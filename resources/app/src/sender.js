// 发送队列：所有对 QQ 的出站消息都经过这里。
// - 每会话串行（sendChain），真人化间隔（随机区间 + 按字数附加）
// - 分钟/小时限频（超限直接拒绝，工具会把错误告诉模型）
// - Markdown → 纯文本、QQ 硬长度切分、CQ 转义
// - 发出的每一条记进 ChatStore（self=true，供下一次运行当"自己的发言"）
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getConfig, DEFAULT_CONFIG, storeConfigForChat } from './config.js';
import { sleep, randInt, createSendChain, formatClockTime } from './util.js';
import { mdToPlain, splitForQQ } from './md-to-plain.js';
import { checkStickerDispatch, reserveStickerDispatch, countsTowardStickerWindow } from './sticker-policy.js';

// 限频回退值统一取自 DEFAULT_CONFIG，杜绝"代码默认 80 / 回退值 8 / UI 回退 8"三处打架。
const DEFAULT_MAX_PER_MINUTE = DEFAULT_CONFIG.send.maxPerMinute;
const DEFAULT_MAX_PER_HOUR = DEFAULT_CONFIG.send.maxPerHour;
const BOOKKEEPING_WARNING = 'SENDER_BOOKKEEPING_FAILED: QQ 已确认发送，本地记录或通知未完成。';

/**
 * 本地路径 → OneBot 能识别的 file URI。
 *
 * 为什么要转换而不是直接传路径：裸 Windows 路径（反斜杠 + 盘符）在 OneBot
 * 各实现里支持不一致，而 `file:///C:/a/b.png` 是规范里明确的形式。
 * 空格/中文要编码（协议端会 decodeURIComponent），`#` `?` 在 URI 里是分隔符，
 * 必须手动转义 —— encodeURI 不处理它们。
 */
export function toFileUri(input) {
  // ⚠️ 本函数刻意不使用任何正则转义（用 String.fromCharCode(92) 取反斜杠、
  // 用 split/join 代替路径分隔符替换）。原因：这段代码最初是用脚本批量写入的，
  // 多层转义把 `\/` 吃成了 `/`，写出了一个非法的正则字面量，
  // 而 `node --check` 的结果被 shell 的 `&&` 链掩盖成"通过" ——
  // 结果整个 sender.js 加载即崩，比原本要修的 bug 严重得多。
  // 零反斜杠写法让"写错字符"这件事根本不可能发生。
  const BS = String.fromCharCode(92);                    // 反斜杠字符本身
  let s = String(input || '').trim().split(BS).join('/');
  if (!s) return '';
  if (s.slice(0, 7).toLowerCase() === 'file://') return s;   // 已是 URI → 幂等
  const unc = s.startsWith('//');                        // UNC：\\server\share
  // 去掉前导斜杠（逐个 split 掉，避免再用正则转义）
  const body = unc ? s.slice(2) : s.split('/').filter(Boolean).join('/');
  if (!body) return '';
  // encodeURI 会处理空格/中文，但不转义 `#` `?` —— 它们在 URI 里是分隔符，必须手动转
  const encoded = encodeURI(body).replace(/[?#]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return unc ? 'file://' + encoded : 'file:///' + encoded;
}

export class SendQueue {
  constructor({ onebot, store, onSent = null, log = null }) {
    this.onebot = onebot;
    this.store = store;
    this.onSent = onSent;
    // 回退/降级这类"行为变了但没报错"的事必须留痕，否则排查时看不到曾经降级过
    this.log = typeof log === 'function' ? log : null;
    this.chains = new Map();      // chatKey -> enqueue fn
    this.minuteTimes = new Map(); // chatKey -> [ts]
    this.hourTimes = new Map();   // chatKey -> [ts]
    this.recentSent = new Map();  // "chatKey::text" -> ts（发送去重窗口）
    this.uncertainSends = new Set();
    this.unarchivedEffects = new Map(); // Keep counting confirmed/unknown sends if disk bookkeeping fails.
  }

  #chain(chatKey) {
    if (!this.chains.has(chatKey)) this.chains.set(chatKey, createSendChain());
    return this.chains.get(chatKey);
  }

  #checkReplyPolicy(chatKey) {
    if (storeConfigForChat(chatKey).replyPolicy?.mode === 'off') throw new Error('REPLY_MODE_OFF: 当前会话设置为不回复，已停止尚未发出的消息。');
  }

  #checkRate(chatKey) {
    this.#checkReplyPolicy(chatKey);
    const now = Date.now();
    const cfg = getConfig().send;
    const minute = (this.minuteTimes.get(chatKey) || []).filter((t) => now - t < 60000);
    const hour = (this.hourTimes.get(chatKey) || []).filter((t) => now - t < 3600000);
    // 回退值必须与 config.js 的默认值一致（80）。此前这里是 8，
    // 配置缺失/为 0 时限频突然收紧 10 倍，行为不可预测。
    if (minute.length >= Math.max(1, Number(cfg.maxPerMinute) || DEFAULT_MAX_PER_MINUTE)) {
      throw new Error(`发送频率超限（每分钟最多 ${cfg.maxPerMinute || DEFAULT_MAX_PER_MINUTE} 条），请等一会再发`);
    }
    if (hour.length >= Math.max(1, Number(cfg.maxPerHour) || DEFAULT_MAX_PER_HOUR)) {
      throw new Error(`发送频率超限（每小时最多 ${cfg.maxPerHour || DEFAULT_MAX_PER_HOUR} 条）`);
    }
    minute.push(now);
    hour.push(now);
    this.minuteTimes.set(chatKey, minute);
    this.hourTimes.set(chatKey, hour);
  }

  /**
   * 发送去重：同一会话短时间内完全相同的文本只发一次。
   *
   * 背景（重复消息的根因之一）：模型在一次会话里可能重复调用 send_message
   * 传入相同内容（尤其是内联工具调用解析 + 原生 tool_calls 并存时），
   * 或 OneBot 超时看似失败但实际已发出、上层重试再发一遍。
   * 这里在真正发出前做一道内容指纹去重：窗口期内 identical 文本直接跳过。
   */
  #dedupeWindow() {
    const raw = getConfig().send?.dedupeWindowMs;
    // 0 是明确的关闭值，不能用 `|| 8000` 把它误当默认值。
    if (raw === null || raw === undefined || raw === '') return 8000;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, n) : 8000;
  }

  /**
   * 只读判断：窗口期内是否已发出过相同内容。
   * ⚠️ 绝不在发送前记账 —— 发送失败（OneBot 报错/限频）的消息必须允许重试，
   * 提前记账会把合法重试误判为重复、导致消息静默丢失。
   */
  #isDuplicate(chatKey, text) {
    const win = this.#dedupeWindow();
    if (!win) return false;
    const last = this.recentSent.get(`${chatKey}::${String(text)}`);
    return Boolean(last && Date.now() - last < win);
  }

  /** 发送成功后记账（去重指纹）。 */
  #markSent(chatKey, text) {
    const win = this.#dedupeWindow();
    if (!win) return;
    const now = Date.now();
    this.recentSent.set(`${chatKey}::${String(text)}`, now);
    // 顺手清理过期条目，避免 Map 无限增长
    if (this.recentSent.size > 500) {
      for (const [k, t] of this.recentSent) {
        if (now - t > win) this.recentSent.delete(k);
      }
    }
  }

  async #attempt(chatKey, selfId, fingerprint, send) {
    if (selfId !== String(this.onebot.selfId ?? '')) {
      throw Object.assign(new Error('AGENT_ACCOUNT_CHANGED: 发送时 QQ 账号已变化。'), { nonretryable: true });
    }
    const key = createHash('sha256')
      .update(JSON.stringify([selfId, chatKey, fingerprint])).digest('hex');
    if (this.uncertainSends.has(key)) {
      throw Object.assign(new Error('此前发送的送达状态未知，已阻止重复发送'), { delivery: 'unknown', nonretryable: true });
    }
    try {
      return await send();
    } catch (error) {
      if (error?.delivery === 'unknown') {
        this.uncertainSends.add(key);
        error.nonretryable = true;
      }
      throw error;
    }
  }

  async #writeLog(message, log = this.log) {
    try { await log?.(message); } catch { /* 日志失败不影响发送结果。 */ }
  }

  #stickerHistory(chatKey, selfId) {
    const saved = this.store.recentSelf?.(chatKey)
      ?? this.store.recent?.(chatKey, { limit: Number.MAX_SAFE_INTEGER, includeSelf: true }) ?? [];
    const unsaved = this.unarchivedEffects.get(selfId + ':' + chatKey) || [];
    const savedIds = new Set(saved.map((row) => row.outboundId).filter(Boolean));
    return [...saved, ...unsaved.filter((row) => !savedIds.has(row.outboundId))]
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }

  async #recordEffect(chatKey, { selfId, text, ts, messageId, media = [], delivery }) {
    const row = { selfId, text, ts, mid: messageId, media, outboundId: randomUUID(), ...(delivery && { delivery }) };
    try { await this.store.appendSelf(chatKey, row); return true; }
    catch {
      const key = selfId + ':' + chatKey;
      const effect = { ...row, self: true };
      if (countsTowardStickerWindow(effect)) this.unarchivedEffects.set(key, [...(this.unarchivedEffects.get(key) || []), effect].slice(-10));
      return false;
    }
  }

  async #stickerAttempt(chatKey, selfId, fingerprint, options, send) {
    let dispatched = false;
    const context = () => ({ selfId, chatKey, sticker: getConfig().sticker,
      history: this.#stickerHistory(chatKey, selfId), signal: options.signal });
    try {
      return await this.#attempt(chatKey, selfId, fingerprint, async () => {
        checkStickerDispatch(options.stickerPolicy, context());
        await options.beforeDispatch?.();
        if (selfId !== String(this.onebot.selfId ?? '')) {
          throw Object.assign(new Error('AGENT_ACCOUNT_CHANGED: 发送时 QQ 账号已变化。'), { nonretryable: true });
        }
        reserveStickerDispatch(options.stickerPolicy, context());
        dispatched = true;
        const data = await send();
        if (!/^-?[1-9]\d*$/.test(String(data?.message_id ?? ''))) {
          throw Object.assign(new Error('表情送达状态未知，已阻止自动重发'), { delivery: 'unknown', nonretryable: true });
        }
        return data;
      });
    } catch (error) {
      if (dispatched && error?.delivery === 'unknown') {
        await this.#recordEffect(chatKey, { selfId, text: '[表情包]', ts: Date.now(), messageId: null,
          media: [{ kind: 'image', sticker: true }], delivery: 'unknown' });
      }
      throw error;
    }
  }

  async #recordConfirmed(chatKey, { selfId, text, ts, messageId, media = [], notification = {} }) {
    let bookkeepingFailed = !await this.#recordEffect(chatKey, { selfId, text, ts, messageId, media });
    try { await this.onSent?.({ chatKey, text, messageId, ...notification }); }
    catch { bookkeepingFailed = true; }
    if (!bookkeepingFailed) return { confirmed: true };
    await this.#writeLog(BOOKKEEPING_WARNING);
    return { confirmed: true, bookkeepingWarning: BOOKKEEPING_WARNING };
  }

  #gap(text, isLast) {
    const cfg = getConfig().send;
    const min = Math.max(200, Number(cfg.minGapMs) || 1000);
    const max = Math.max(min, Number(cfg.maxGapMs) || 3000);
    if (isLast) return 0;
    const byLength = Math.min(8000, (String(text || '').length) * (Number(cfg.byLengthMs) || 20));
    return Math.min(15000, Math.max(min, randInt(min, max) * 0.5 + byLength * 0.5));
  }

  /**
   * 发送一批文本消息（一条或多条）。
   * options: { replyToMessageId, atUserId }
   * 返回 { sent: [{text, messageId}], failed: [{text, error}] }；全部失败时抛错。
   */
  async sendTextBatch(chatKey, messages, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group' && kind !== 'private') throw new Error(`非法会话 key：${chatKey}`);
    const selfId = String(options.expected_self_id ?? this.onebot.selfId ?? '');
    const hasReply = String(options.replyToMessageId ?? '').trim() !== '';
    const hasAt = String(options.atUserId ?? '').trim() !== '';
    if (hasReply && hasAt) throw new Error('引用和 @ 只能选一种');
    const addressed = hasReply || hasAt;
    const list = Array.isArray(messages) ? messages : [messages];
    if (!list.length) throw new Error('消息列表为空');
    const hardSplitAt = Number(getConfig().send?.hardSplitAt) || 0;
    const parts = [];
    for (const m of list) {
      const plain = mdToPlain(String(m ?? ''));
      if (!plain) continue;
      // 最后防线：任何上游畸形路径漏下来的 "[object Object]" 到这儿直接拦掉，
      // 用户永远不该在 QQ 里看到这串字符。全被拦 → 下方抛"消息内容为空"回给模型。
      if (/^\[object Object\]$/.test(plain)) continue;
      if (hardSplitAt > 0 && plain.length > hardSplitAt) parts.push(...splitForQQ(plain, hardSplitAt));
      else parts.push(plain);
    }
    if (!parts.length) throw new Error('消息内容为空');

    const chain = this.#chain(chatKey);
    const promises = [];
    let firstDelivered = false;
    let deliveryUnknown = false;
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      const isLast = i === parts.length - 1;
      const gap = this.#gap(text, isLast);
      promises.push(chain(async () => {
        if (deliveryUnknown) throw new Error('此前消息送达状态未知，后续消息已停止');
        if (i > 0 && addressed && !firstDelivered) throw new Error('首条定位消息未送达，后续消息已停止');
        this.#checkRate(chatKey);
        if (gap > 0) await sleep(gap, { signal: options.signal });
        options.signal?.throwIfAborted();
        await options.beforeDispatch?.();
        // 发送去重：窗口期内 identical 文本跳过（防模型重复调用/超时重试造成的重复发言）
        if (this.#isDuplicate(chatKey, text)) {
          if (i === 0 && addressed) throw new Error('首条定位消息已触发发送去重');
          await this.#writeLog(`[sender] 跳过重复消息（${this.#dedupeWindow()}ms 内已发过相同内容）`, console.warn);
          return { text, messageId: null, at: formatClockTime(Date.now()), deduped: true };
        }
        this.#checkReplyPolicy(chatKey);
        let data;
        try {
          data = await this.#attempt(chatKey, selfId, text, () => this.onebot.sendText(kind, id, text, {
            replyToMessageId: i === 0 ? options.replyToMessageId : null, // 引用挂在第一条上：回的就是那条
            atUserId: i === 0 ? options.atUserId : null,
            expected_self_id: selfId || undefined, signal: options.signal
          }));
        } catch (error) {
          deliveryUnknown = error?.delivery === 'unknown';
          throw error;
        }
        if (i === 0) firstDelivered = true;
        this.#markSent(chatKey, text);   // 只有 OneBot 成功返回后才记入去重窗口
        const ts = Date.now();
        const messageId = data?.message_id ?? null;
        const receipt = await this.#recordConfirmed(chatKey, { selfId, text, ts, messageId });
        return { text, messageId, at: formatClockTime(ts), ...receipt };
      }));
    }

    const settled = await Promise.allSettled(promises);
    const sent = [];
    const failed = [];
    const deduped = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled') (r.value.deduped ? deduped : sent).push(r.value);
      // 带上 index 和原文：调用方需要知道"哪一条"失败了（才能重发或告知模型）。
      // 原先 failed 里只有 error，没有任何定位信息。
      else failed.push({
        index: i, text: parts[i], error: String(r.reason?.message ?? r.reason),
        ...(r.reason?.delivery === 'unknown' ? { delivery: 'unknown' } : {}),
        ...(r.reason?.nonretryable ? { nonretryable: true } : {})
      });
    }
    // 部分成功也要让调用方知道：原先只在"全败"时抛错，部分成功会静默丢消息
    if (failed.length > 0) {
      const detail = failed.map((f) => `第${f.index + 1}条「${String(f.text).slice(0, 20)}」：${f.error}`).join('；');
      if (sent.length === 0) throw Object.assign(new Error(detail), {
        ...(failed.some((failure) => failure.delivery === 'unknown') ? { delivery: 'unknown' } : {}),
        ...(failed.some((failure) => failure.nonretryable) ? { nonretryable: true } : {})
      });
      await this.#writeLog(`[sender] 部分发送失败（${failed.length}/${parts.length}）`, console.warn);
    }
    return { sent, failed, deduped };
  }

  /** 发送一个收藏表情（独立气泡）；与原生/梗鲸共用本轮唯一许可。 */
  sendSticker(chatKey, sticker, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const selfId = String(options.expected_self_id ?? this.onebot.selfId ?? '');
    return this.#chain(chatKey)(async () => {
      this.#checkRate(chatKey);
      await sleep(randInt(600, 1500), { signal: options.signal });
      this.#checkReplyPolicy(chatKey);
      const primary = String(sticker.url || '').trim();
      if (!primary) throw new Error('表情没有可发送的图片地址');
      const data = await this.#stickerAttempt(chatKey, selfId, '__sticker__' + (sticker.id || primary), options,
        () => this.onebot.sendSticker(kind, id, primary, { expected_self_id: selfId, signal: options.signal,
          replyToMessageId: options.replyToMessageId ?? null, atUserId: options.atUserId ?? null }));
      const messageId = data.message_id;
      const receipt = await this.#recordConfirmed(chatKey, {
        selfId, text: '[表情包:' + (sticker.desc || sticker.localNote || sticker.id) + ']', ts: Date.now(), messageId,
        media: [{ kind: 'image', sticker: true }], notification: { text: '[表情包]', sticker: sticker.id }
      });
      return { message_id: messageId, ...receipt };
    });
  }

  sendReceivedSticker(chatKey, file, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (!/^(group|private):[1-9]\d{0,9}$/.test(String(chatKey)) || !/^alcor-media-[a-f0-9]{64}$/.test(file)) {
      return Promise.reject(new Error('已收表情或目标会话无效'));
    }
    const selfId = String(options.expected_self_id ?? this.onebot.selfId ?? '');
    const fingerprint = `__sticker__${file}`;
    return this.#chain(chatKey)(async () => {
      this.#checkRate(chatKey);
      await sleep(randInt(600, 1500), { signal: options.signal });
      this.#checkReplyPolicy(chatKey);
      if (this.#isDuplicate(chatKey, fingerprint)) throw new Error('这个表情刚刚发过，已跳过');
      const data = await this.#stickerAttempt(chatKey, selfId, fingerprint, options, () => this.onebot.sendSegments(
        kind, id, [{ type: 'image', data: { file } }], { ...options, expected_self_id: selfId || undefined }
      ));
      this.#markSent(chatKey, fingerprint);
      const messageId = data?.message_id ?? null;
      const receipt = await this.#recordConfirmed(chatKey, {
        selfId, text: '[表情包]', ts: Date.now(), messageId, media: [{ kind: 'image', sticker: true }], notification: { kind: 'sticker' }
      });
      return { message_id: messageId, ...receipt };
    });
  }

  /**
   * 转发本会话收到过的图片（图片与表情共用一条逻辑，但图片不受表情档位与配额限制）。
   *
   * 只有表情才走贴纸策略；普通图片按正常发图管道处理：限频 → 去重 → 发送 → 留档。
   */
  sendForwardedImage(chatKey, file, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (!/^(group|private):[1-9]\d{0,9}$/.test(String(chatKey)) || !/^alcor-media-[a-f0-9]{64}$/.test(file)) {
      return Promise.reject(new Error('已收图片或目标会话无效'));
    }
    const selfId = String(options.expected_self_id ?? this.onebot.selfId ?? '');
    const fingerprint = `__forwarded__${file}`;
    return this.#chain(chatKey)(async () => {
      this.#checkRate(chatKey);
      await sleep(randInt(600, 1500), { signal: options.signal });
      this.#checkReplyPolicy(chatKey);
      if (this.#isDuplicate(chatKey, fingerprint)) throw new Error('这张图刚刚发过，已跳过');
      const data = await this.#attempt(chatKey, selfId, fingerprint, async () => {
        if (selfId !== String(this.onebot.selfId ?? '')) {
          throw Object.assign(new Error('AGENT_ACCOUNT_CHANGED: 发送时 QQ 账号已变化。'), { nonretryable: true });
        }
        return this.onebot.sendSegments(kind, id, [{ type: 'image', data: { file } }], { ...options, expected_self_id: selfId || undefined });
      });
      this.#markSent(chatKey, fingerprint);
      const messageId = data?.message_id ?? null;
      const receipt = await this.#recordConfirmed(chatKey, {
        selfId, text: '[图片]', ts: Date.now(), messageId, media: [{ kind: 'image' }]
      });
      return { message_id: messageId, ...receipt };
    });
  }

  /**
   * 发一张图片（独立气泡）。
   *
   * 和 sendSticker 一样走完整发送管道：限频 → 去重 → 发送 → 留档。
   * 这三步一个都不能省：
   *   · 限频：图比文字更容易刷屏，必须和文字共享同一套配额
   *   · 去重：模型可能对同一个 URL 连发两次（实测过），按 URL 指纹挡掉
   *   · 留档：不留档的话，下一次运行不知道自己发过图，可能重复发
   *
   * @param {object} img { url } 或 { dataUrl }（二选一）
   * @param {object} options { note, replyToMessageId, atUserId }
   */
  sendImage(chatKey, img, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const selfId = String(options.expected_self_id ?? this.onebot.selfId ?? '');
    const chain = this.#chain(chatKey);
    const url = String(img?.url ?? '').trim();
    const dataUrl = String(img?.dataUrl ?? '').trim();
    // Tools provide safeFetch-validated bytes. Only an explicit internal file field permits local reads.
    const file = String(img?.file ?? '').trim();
    if (!url && !dataUrl && !file) return Promise.reject(new Error('图片地址为空'));

    const ref = dataUrl || (file ? toFileUri(file) : url);
    if (options.sticker === true || img?.sticker === true) {
      return this.sendMedia(chatKey, [{ type: 'image', data: { file: ref } }], { ...options, sticker: true });
    }
    // 去重键优先用 URL；dataUrl 太长不适合当键，用长度 + 前 64 字符做指纹
    const dedupeKey = url || file || `data:${dataUrl.length}:${dataUrl.slice(0, 64)}`;
    return chain(async () => {
      if (this.#isDuplicate(chatKey, `__img__${dedupeKey}`)) {
        throw new Error('这张图刚刚发过，已跳过（避免重复刷屏）');
      }
      this.#checkRate(chatKey);
      await sleep(randInt(500, 1300), { signal: options.signal });   // 发图前真人式的短暂停顿

      let data, dispatched = false;
      let sendRef = ref;
      try {
        if (file && !dataUrl) {
          const handle = await fs.open(file.startsWith('file:') ? fileURLToPath(file) : file, 'r');
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) throw new Error('本地图片须为不超过 1 MiB 的文件');
            const buffer = Buffer.alloc(stat.size);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead !== buffer.length) throw new Error('本地图片读取不完整');
            sendRef = 'base64://' + buffer.toString('base64');
          } finally { await handle.close(); }
        }
        this.#checkReplyPolicy(chatKey);
        data = await this.#attempt(chatKey, selfId, `__img__${dedupeKey}`, async () => {
          await options.beforeDispatch?.();
          options.signal?.throwIfAborted();
          dispatched = true;
          const result = await this.onebot.sendImage(kind, id, sendRef, {
            replyToMessageId: options.replyToMessageId ?? null, atUserId: options.atUserId ?? null,
            expected_self_id: selfId || undefined, signal: options.signal
          });
          if (!/^-?[1-9]\d*$/.test(String(result?.message_id ?? ''))) {
            throw Object.assign(new Error('图片送达状态未知，已阻止自动重发'), { delivery: 'unknown', nonretryable: true });
          }
          return result;
        });
      } catch (error) {
        if (dispatched && error?.delivery === 'unknown') {
          await this.#recordEffect(chatKey, { selfId, text: '[图片]', ts: Date.now(), messageId: null,
            media: [{ kind: 'image' }], delivery: 'unknown' });
        }
        throw error;
      }
      this.#markSent(chatKey, `__img__${dedupeKey}`);   // 发图同样：成功后才记账
      const ts = Date.now();
      const note = options.note ? `:${String(options.note).slice(0, 40)}` : '';
      const messageId = data?.message_id ?? null;
      const receipt = await this.#recordConfirmed(chatKey, {
        selfId, text: `[图片${note}]`, ts, messageId, media: [{ kind: 'image' }], notification: { kind: 'image' }
      });
      return { message_id: messageId, ...receipt };
    });
  }

  /**
   * 发送一批媒体段（视频 / 一次多图）—— 走完整发送管道：串行 → 限频 → 去重 → 留档。
   *
   * 为什么需要它：`sendImage` 一次只能发一张（一图一气泡），而"抖音图文帖一次 9 张"
   * 或"转发一段视频"没法用单图 API 表达。media-download 这类插件下载完拿到的是
   * 本地路径数组，必须能一次性成段发出去。
   *
   * ⚠️ 插件**不得**绕过本方法直接调 `onebot.sendSegments` —— 那样会跳过限频与留档，
   * 表现为"媒体把文字配额吃光后突然发不出话"和"下一次运行忘了自己发过，重复发"。
   * 所以 provider 拿到的依赖里应该带 `sender`，用 ctx 传进来的这个对象发送。
   *
   * @param {Array} segments OneBot 段数组，如 [{type:'video',data:{file:'/x.mp4'}}]
   * @param {object} options { label, dedupeKey, replyToMessageId, atUserId }
   */
  sendMedia(chatKey, segments, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group' && kind !== 'private') return Promise.reject(new Error(`非法会话 key：${chatKey}`));
    const selfId = String(options.expected_self_id ?? this.onebot.selfId ?? '');
    const segs = (Array.isArray(segments) ? segments : []).filter((s) => s && s.type);
    if (!segs.length) return Promise.reject(new Error('媒体段为空'));
    const sticker = options.sticker === true || segs.some((s) => s.sticker === true || s.data?.sticker === true);
    if (sticker && (segs.length !== 1 || segs[0].type !== 'image')) {
      return Promise.reject(Object.assign(new Error('STICKER_SINGLE_REQUIRED: 表情只能单张图片独立发送'),
        { code: 'STICKER_SINGLE_REQUIRED', nonretryable: true }));
    }
    const label = String(options.label || '[媒体]');
    // 去重键优先用本地文件路径（同一份文件重复发说明是重试/重复触发）
    const dedupeKey = String(options.dedupeKey
      || segs.map((s) => s?.data?.file).filter(Boolean).join('|')
      || label);
    const chain = this.#chain(chatKey);
    return chain(async () => {
      options.signal?.throwIfAborted();
      if (this.#isDuplicate(chatKey, `__media__${dedupeKey}`)) {
        throw new Error('这份媒体刚刚发过，已跳过（避免重复刷屏）');
      }
      this.#checkRate(chatKey);
      await sleep(randInt(800, 1800), { signal: options.signal });   // 视频/多图体积大，停顿比文字长一点
      options.signal?.throwIfAborted();
      this.#checkReplyPolicy(chatKey);
      const send = () => this.onebot.sendSegments(kind, id, segs, { expected_self_id: selfId || undefined, signal: options.signal });
      const data = sticker
        ? await this.#stickerAttempt(chatKey, selfId, '__media__' + dedupeKey, options, send)
        : await this.#attempt(chatKey, selfId, '__media__' + dedupeKey, async () => {
          await options.beforeDispatch?.();
          options.signal?.throwIfAborted();
          return send();
        });
      this.#markSent(chatKey, `__media__${dedupeKey}`);   // 成功后才记账
      const messageId = data?.message_id ?? null;
      const receipt = await this.#recordConfirmed(chatKey, {
        selfId, text: label, ts: Date.now(), messageId,
        media: segs.map((s) => ({ kind: s.type, ...(sticker && { sticker: true }) })),
        notification: { kind: sticker ? 'sticker' : 'media' }
      });
      return { message_id: messageId, ...receipt };
    });
  }

  /** 拍一拍。发送成功后留档（self 记录），否则下一次运行不知道自己拍过。 */
  poke(chatKey, targetUserId, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (!/^(group|private):[1-9]\d{0,9}$/.test(String(chatKey))) return Promise.reject(new Error('拍一拍目标会话无效'));
    const userId = Number(kind === 'group' ? targetUserId : id);
    if (!Number.isInteger(userId) || userId < 1 || userId > 0xffffffff) return Promise.reject(new Error('拍一拍需要有效的目标 QQ 号'));
    const selfId = String(options.expected_self_id ?? this.onebot.selfId ?? '');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      // 拍一拍同样占发送配额 —— 曾经不调 #checkRate，模型连发 poke
      // 可以绕过 maxPerMinute/maxPerHour 刷屏
      this.#checkRate(chatKey);
      await sleep(randInt(300, 900), { signal: options.signal });
      this.#checkReplyPolicy(chatKey);
      const data = await this.#attempt(chatKey, selfId, `__poke__${userId}`, () => this.onebot.sendPoke(
        kind, id, userId, { ...options, expected_self_id: selfId || undefined }
      ));
      const ts = Date.now();
      const target = kind === 'group' && targetUserId != null ? ` ${targetUserId}` : '对方';
      const receipt = await this.#recordConfirmed(chatKey, {
        selfId, text: `[拍一拍] 你拍了拍${target}`, ts, messageId: data?.message_id ?? null,
        notification: { text: `[拍一拍]${target}`, messageId: null }
      });
      return { ...data, ...receipt, sideEffect: { type: 'poke', targetUserId: userId, at: formatClockTime(ts) } };
    });
  }
}
