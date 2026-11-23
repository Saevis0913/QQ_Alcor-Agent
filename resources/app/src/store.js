// 每个会话（group:xxx / private:xxx）一个不断增长的 JSON 消息存储。
// 这是新架构的核心数据结构：模型不携带对话历史，每次运行都从这里拼接"已读信息"。
//
// 条目格式：
// {
//   id:        本地递增序号（自 1 起，同群唯一，用于 UI 定位）
//   mid:       QQ 消息 id（可为负数；自己主动发送的本地记录可能没有）
//   ts:        时间戳毫秒
//   senderId:  QQ 号（自己发送的为 selfId）
//   senderName:群名片/昵称（自己发送的为 botName）
//   text:      解析后的纯文本（[图片] 等占位符已内联）
//   self:      是否是机器人自己发的
//   read:      已读状态（运行开始时批量置 true）
//   reply:     可选 { sender, text }：该消息引用/回复的对象摘要
//   media:     可选 [{ kind, url, file, faceId, summary }] 原始媒体定位信息
// }
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { countsTowardStickerWindow } from './sticker-policy.js';

const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const LEGACY_OWNER_FILE = path.join(MESSAGES_DIR, 'legacy-account.json');
const ACCOUNT_ID = /^[1-9]\d{0,9}$/;
const OTHER_ACCOUNT_ROWS = Symbol('other account archive rows');

function legacyOwner() {
  try {
    const id = JSON.parse(fs.readFileSync(LEGACY_OWNER_FILE, 'utf8')).account;
    return ACCOUNT_ID.test(id) ? String(id) : '';
  } catch {
    return '';
  }
}

function chatFile(chatKey, directory) {
  // chatKey 形如 group:123 / private:456
  const safe = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
  return path.join(directory, `${safe}.json`);
}

function loadChat(chatKey, directory) {
  if (!directory) return { chatKey, nextLocalId: 1, messages: [] };
  try {
    let text = fs.readFileSync(chatFile(chatKey, directory), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.messages)) return parsed;
  } catch { /* 新会话 */ }
  return { chatKey, nextLocalId: 1, messages: [] };
}

function saveChat(state, directory) {
  if (!directory) return;
  fs.mkdirSync(directory, { recursive: true });
  const tmp = `${chatFile(state.chatKey, directory)}.${process.pid}.tmp`;
  const excluded = state[OTHER_ACCOUNT_ROWS];
  const saved = excluded?.length
    ? { ...state, messages: [...excluded, ...state.messages].sort((a, b) => a.id - b.id) }
    : state;
  fs.writeFileSync(tmp, JSON.stringify(saved, null, 1), 'utf8');
  fs.renameSync(tmp, chatFile(state.chatKey, directory));
}

export class ChatStore {
  constructor(maxPerChat = 0, { accountScoped = false } = {}) {
    this.maxPerChat = Math.max(0, Number(maxPerChat) || 0);
    this.chats = new Map(); // chatKey -> state
    this.accountScoped = accountScoped;
    this.activeAccount = '';
    this.legacyAccount = accountScoped ? legacyOwner() : '';
  }

  setAccount(value) {
    const id = String(value ?? '');
    if (id && !ACCOUNT_ID.test(id)) throw new Error('QQ 账号无效');
    if (!this.legacyAccount && id) {
      fs.mkdirSync(MESSAGES_DIR, { recursive: true });
      try {
        fs.writeFileSync(LEGACY_OWNER_FILE, JSON.stringify({ account: id }), { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      this.legacyAccount = legacyOwner();
    }
    this.accountScoped = true;
    if (this.activeAccount !== id) this.chats.clear();
    this.activeAccount = id;
  }

  #directory() {
    if (!this.accountScoped || (this.activeAccount && this.activeAccount === this.legacyAccount)) return MESSAGES_DIR;
    return this.activeAccount ? path.join(MESSAGES_DIR, 'accounts', this.activeAccount) : null;
  }

  #writeAccount(expected) {
    if (this.accountScoped && (!this.activeAccount || (expected != null && String(expected) !== this.activeAccount))) {
      throw new Error('存档账号未确认或已切换');
    }
    return this.activeAccount || null;
  }

  setMaxPerChat(cap) {
    this.maxPerChat = Math.max(0, Number(cap) || 0);
  }

  #state(chatKey) {
    if (!this.chats.has(chatKey)) {
      const state = loadChat(chatKey, this.#directory());
      if (this.accountScoped) {
        const excluded = [];
        state.messages = state.messages.filter((row) => {
          if (row.selfId != null ? String(row.selfId) === this.activeAccount : this.activeAccount && this.activeAccount === this.legacyAccount) {
            row.selfId = this.activeAccount;
            return true;
          }
          excluded.push(row);
          return false;
        });
        Object.defineProperty(state, OTHER_ACCOUNT_ROWS, { value: excluded });
      }
      const selfMessages = Array.isArray(state.selfMessages) ? state.selfMessages : state.messages;
      state.selfMessages = selfMessages.filter((row) => countsTowardStickerWindow(row) && (!this.accountScoped ||
        (row.selfId != null ? String(row.selfId) === this.activeAccount : this.activeAccount && this.activeAccount === this.legacyAccount)))
        .slice(-10).map((row) => this.accountScoped ? { ...row, selfId: this.activeAccount } : row);
      this.chats.set(chatKey, state);
    }
    return this.chats.get(chatKey);
  }

  listChats() {
    // 从磁盘文件名还原（group_123.json -> group:123），已加载的直接带上
    try {
      const files = fs.readdirSync(this.#directory() || '').filter((f) => /^(group|private)_\d+\.json$/.test(f));
      for (const f of files) {
        const m = /^(group|private)_(\d+)\.json$/.exec(f);
        if (m) this.#state(`${m[1]}:${m[2]}`);
      }
    } catch { /* 目录不存在 */ }
    return [...this.chats.keys()].filter((key) => this.chats.get(key).messages.length > 0);
  }

  getChatMeta(chatKey) {
    const st = this.#state(chatKey);
    // 未读只计他人消息（与 unreadCount / peekUnread 口径一致）——
    // 曾经用 !m.read 把 self 也算进去，机器人自己的发言会把角标顶大。
    const unread = st.messages.filter((m) => !m.read && !m.self).length;
    const last = st.messages[st.messages.length - 1] || null;
    return { chatKey, total: st.messages.length, unread, lastTs: last?.ts ?? 0, lastText: last?.text ?? '' };
  }

  /** 追加一条收到的消息（未读）。返回写入的条目。 */
  appendIncoming(chatKey, { mid, ts, senderId, senderName, senderRole = null, text, reply = null, media = [], isPoke = false, atMe = null, atNames = [], receiptId = null, selfId, forwardVersion }) {
    const account = this.#writeAccount(selfId);
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      receiptId,
      ...(account ? { selfId: account } : {}),
      ts: ts || Date.now(),
      senderId: String(senderId ?? ''),
      senderName: String(senderName ?? ''),
      text: String(text ?? ''),
      self: false,
      read: false,
      reply: reply || null,
      media: Array.isArray(media) ? media : [],
      ...(forwardVersion===3?{forwardVersion:3}:{}),
      // 拍一拍事件：可作触发批（resolveContextTier 按 1 档响应），但不进【已读信息】
      isPoke: Boolean(isPoke),
      // @ 判定标记（2026-09-26）：atMe 以 @ 段的 QQ 号为准 —— 文本包含匹配
      // 分不清"同名不同人"（群友 @ 的人与机器人重名时被误判为 @机器人）。
      // null = 老存档未标，判定层回落文本匹配。
      atMe: atMe === null || atMe === undefined ? null : Boolean(atMe),
      // 渲染进 text 的 @片段原文（含 @ 前缀）：关键词判定据此剔除，
      // 防"@ 别人的名字里带关键词"误触发。空数组 = 该消息没有 @ 段。
      atNames: (Array.isArray(atNames) ? atNames : []).map((n) => String(n ?? '')).filter(Boolean).slice(0, 20)
    };
    if (senderRole) entry.senderRole = senderRole;
    st.messages.push(entry);
    this.#trim(st);
    saveChat(st, this.#directory());
    return entry;
  }

  /** 记录机器人自己发出的消息（已读）。 */
  appendSelf(chatKey, { text, ts, mid = null, selfId, media = [], delivery, outboundId }) {
    const account = this.#writeAccount(selfId);
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ...(account ? { selfId: account } : {}),
      ts: ts || Date.now(),
      senderId: 'self',
      senderName: '我',
      text: String(text ?? ''),
      self: true,
      read: true,
      reply: null,
      media: Array.isArray(media) ? media : [],
      ...(delivery === 'unknown' ? { delivery: 'unknown' } : {}),
      ...(outboundId ? { outboundId: String(outboundId) } : {})
    };
    st.messages.push(entry);
    // Incoming traffic and uncertain ordinary images cannot displace confirmed sticker history.
    if (countsTowardStickerWindow(entry)) st.selfMessages = [...st.selfMessages, entry].slice(-10);
    this.#trim(st);
    try { saveChat(st, this.#directory()); }
    catch (error) {
      // The atomic save left the previous file intact. Reload that version on the next read.
      this.chats.delete(chatKey);
      throw error;
    }
    return entry;
  }

  recoverHistory(chatKey, rows, expectedSelfId) {
    const account = this.#writeAccount(expectedSelfId);
    const current = this.#state(chatKey);
    const known = new Set([...current.messages, ...current.selfMessages].map(row => String(row.mid)));
    const recovered = [];
    let nextLocalId = current.nextLocalId;
    for (const row of rows) {
      if (known.has(String(row.mid))) continue;
      known.add(String(row.mid));
      recovered.push({ ...row, id: nextLocalId++, selfId: account, read: true, recovered: true });
    }
    if (!recovered.length) return 0;

    const byTime = (a, b) => a.ts - b.ts || a.id - b.id;
    const next = { ...current, nextLocalId, messages: [...current.messages, ...recovered].sort(byTime) };
    Object.defineProperty(next, OTHER_ACCOUNT_ROWS, { value: current[OTHER_ACCOUNT_ROWS] });
    next.selfMessages = [...current.selfMessages, ...recovered.filter(countsTowardStickerWindow)].sort(byTime).slice(-10);
    this.#trim(next);
    saveChat(next, this.#directory());
    this.chats.set(chatKey, next);
    const retained = new Set(next.messages.map(row => row.id));
    return recovered.filter(row => retained.has(row.id)).length;
  }

  /** 快照当前未读并全部置为已读（运行开始时调用）。 */
  drainUnread(chatKey) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read && !m.self);
    for (const m of st.messages) m.read = true;
    saveChat(st, this.#directory());
    return unread;
  }

  /**
   * 只 drain「从某条消息起**之后**」的未读：取走触发批，之前的旧积压单独标已读。
   *
   * 为什么需要它（2026-09-25 触发链路重做的补丁）：磁盘上可能遗留旧进程/
   * 暂停期间攒下的积压未读。它们从未经过 onIncoming 的逐条判定，如果一次
   * 触发的 drain 把它们全部吃进触发批，模型会看到一大坨"未读信息"——用户
   * 看到的就是"积压消息被整批塞进唤醒"。正确语义：
   *   · 触发消息 X 之后的未读 = 本批的聚批对象（X 也在内）；
   *   · X 之前的旧未读 = 触发前就该已读的历史 → 标已读沉入【已读信息】。
   *
   * @param {string} chatKey
   * @param {number} fromTs 批的起点（触发消息的 ts，含）；早于它的未读标已读
   * @returns {{ batch: object[], archived: number }} batch = 触发批，archived = 被归档的旧未读条数
   */
  drainUnreadFrom(chatKey, fromTs) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read && !m.self);
    const batch = [];
    let archived = 0;
    for (const m of unread) {
      if (m.ts >= fromTs) batch.push(m);
      else { m.read = true; archived++; }   // 触发点之前的旧积压：沉入历史
    }
    for (const m of st.messages) m.read = true;   // batch 里的也置已读（作为触发批取走）
    saveChat(st, this.#directory());
    return { batch, archived };
  }

  /**
   * 把当前所有未读标记为已读，**但不取走它们**。
   *
   * 这是"档位控制是否响应"的关键：机器人判断"这次不回应"时调用它，
   * 消息就沉入历史（已读），不会产生会话、不消耗 token；
   * 但内容仍留在存档里，日后被艾特时还能作为"已读上下文"带进提示词。
   * 与 drainUnread 的区别：drainUnread 取走并作为触发批，这个只标记。
   *
   * @returns {number} 被标记为已读的条数
   */
  markAllRead(chatKey) {
    const st = this.#state(chatKey);
    let n = 0;
    for (const m of st.messages) {
      if (!m.read && !m.self) { m.read = true; n++; }
    }
    if (n) saveChat(st, this.#directory());
    return n;
  }

  /**
   * 把**单条**消息标记为已读（不取走）。
   *
   * 逐条触发判定（onIncoming）用：该条不触发会话时当场标已读、沉入历史，
   * 不动其它未读 —— 那些是"倒计时窗口内追加的"或"上一批遗留的"，
   * 各有自己的归宿（前者等 drain，后者等兜底或下一次触发）。
   *
   * @param {string} chatKey
   * @param {number} id 消息条目的本地 id（appendIncoming 返回的 entry.id）
   * @returns {boolean} 是否真的标记了（false = 没找到/本来就是已读）
   */
  markEntryRead(chatKey, id) {
    const st = this.#state(chatKey);
    const m = st.messages.find((x) => x.id === id);
    if (!m || m.read || m.self) return false;
    m.read = true;
    saveChat(st, this.#directory());
    return true;
  }

  /**
   * 把时间窗内的**已读**消息重新标记为未读（手动重试失败会话用）。
   *
   * 触发批当初被 drainUnread 置了已读；重试时按会话起止时间把它们翻回未读，
   * 唤醒流程就能重新取走它们。窗口向前放宽 5 分钟（容纳防抖聚批期），
   * 向后到会话结束 —— 窗口外的不动，避免误翻后来真正已读的历史。
   * @returns {number} 恢复为未读的条数
   */
  markUnreadInWindow(chatKey, startedAt, endedAt) {
    const st = this.#state(chatKey);
    const winStart = Number(startedAt) - 5 * 60 * 1000;
    const winEnd = Number(endedAt || startedAt) + 1000;
    let n = 0;
    for (const m of st.messages) {
      if (m.self || m.recalled) continue;
      if (m.read && m.ts >= winStart && m.ts <= winEnd) { m.read = false; n++; }
    }
    if (n) saveChat(st, this.#directory());
    return n;
  }

  unreadCount(chatKey) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).length;
  }

  /** 查看当前未读消息（不置已读），用于“等待中”会话的触发摘要。 */
  peekUnread(chatKey, limit = 3) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).slice(0, Math.max(1, Number(limit) || 3));
  }

  recentSelf(chatKey) {
    return this.#state(chatKey).selfMessages.slice(-10);
  }

  recent(chatKey, { limit = 80, offset = 0, includeSelf = true, includeRecalled = true, fromTs, beforeTs } = {}) {
    const st = this.#state(chatKey);
    const all = includeSelf && includeRecalled && fromTs == null && beforeTs == null
      ? st.messages
      : st.messages.filter(m => (includeSelf || !m.self) && (includeRecalled || !m.recalled)
        && (fromTs == null || m.ts >= fromTs) && (beforeTs == null || m.ts < beforeTs));
    // offset = 跳过最近 N 条（用于工具翻页）。只读，绝不能修改 st.messages！
    const start = Math.max(0, all.length - Math.max(0, Number(offset) || 0));
    return all.slice(0, start).slice(-Math.max(1, Number(limit) || 1));
  }

  findByMid(chatKey, mid) {
    const st = this.#state(chatKey);
    const target = String(mid);
    return st.messages.find((m) => String(m.mid) === target) || null;
  }

  setRecallUnconfirmed(chatKey, mid, unconfirmed, selfId) {
    this.#writeAccount(selfId);
    const row = this.findByMid(chatKey, mid);
    if (!row || row.recalled) return false;
    const previous = row.recallUnconfirmed;
    if (unconfirmed) row.recallUnconfirmed = true;
    else delete row.recallUnconfirmed;
    try {
      saveChat(this.#state(chatKey), this.#directory());
    } catch (error) {
      if (previous) row.recallUnconfirmed = previous;
      else delete row.recallUnconfirmed;
      throw error;
    }
    return true;
  }

  /**
   * 标记一条消息已被用户撤回（按 QQ 消息 id）。
   * 撤回的消息后续不再发给大模型（buildPastState 会过滤 recalled）。
   * @returns {boolean} 是否找到并标记了
   */
  markRecalled(chatKey, mid) {
    const st = this.#state(chatKey);
    const target = String(mid);
    const m = st.messages.find((x) => String(x.mid) === target);
    if (!m) return false;
    m.recalled = true;
    m.read = true;   // 撤回的消息也算"已读"，不再触发回复
    delete m.recallUnconfirmed;
    saveChat(st, this.#directory());
    return true;
  }

  /**
   * 按 QQ 消息 id 更新一条已存档消息（文本/补媒体），并落盘。
   * 用途：read_forward 工具把"合并转发占位符"永久升级成展开后的文本
   * —— 一次展开，以后谁（模型/存档页/金句）都直接读到内容。
   */
  updateByMid(chatKey, mid, { text, appendMedia = [], replaceMedia, forwardVersion } = {}) {
    const st = this.#state(chatKey);
    const target = String(mid);
    const m = st.messages.find((x) => String(x.mid) === target);
    if (!m) return false;
    if (text != null) m.text = String(text);
    if(forwardVersion===3)m.forwardVersion=3;
    if(Array.isArray(replaceMedia))m.media=replaceMedia;
    if (appendMedia.length) {
      m.media = Array.isArray(m.media) ? m.media : [];
      const key=x=>x&&(x.file||x.url)?`${x.kind}:${x.file||x.url}:${x.forwardNode||''}`:
        x?.error&&x.forwardNode&&x.forwardIndex?`${x.kind}:unavailable:${x.forwardNode}:${x.forwardIndex}`:null;
      const seen = new Set(m.media.map(key).filter(Boolean));
      for (const x of appendMedia) {
        const id=key(x);if (id && !seen.has(id)) { m.media.push(x); seen.add(id); }
      }
    }
    saveChat(st, this.#directory());
    return true;
  }

  findByLocalId(chatKey, localId) {
    const st = this.#state(chatKey);
    return st.messages.find((m) => m.id === Number(localId)) || null;
  }

  /**
   * 删除指定本地 id 的消息（部分清除）。返回删掉的条数。
   * @param {string} chatKey
   * @param {number[]} localIds 本地递增 id 数组
   */
  removeByLocalIds(chatKey, localIds = []) {
    const st = this.#state(chatKey);
    const ids = new Set((Array.isArray(localIds) ? localIds : [localIds]).map(Number));
    if (!ids.size) return 0;
    const before = st.messages.length;
    st.messages = st.messages.filter((m) => !ids.has(m.id));
    const removed = before - st.messages.length;
    if (removed) saveChat(st, this.#directory());
    return removed;
  }

  /**
   * 清空某会话的全部消息（整体清除）。返回删掉的条数。
   * 会话文件保留（空 messages），下次来消息继续往里写。
   */
  clearChat(chatKey) {
    const st = this.#state(chatKey);
    const removed = st.messages.length;
    if (removed || st.selfMessages.length) {
      st.messages = [];
      st.selfMessages = [];
      saveChat(st, this.#directory());
    }
    return removed;
  }

  /**
   * 仅屏蔽（不删除）：把某会话的全部未读标记为已读。
   * 与 markAllRead 相同语义，这里显式命名供"仅屏蔽、不再发送"场景调用。
   * 返回标记的条数。
   */
  muteUnread(chatKey) {
    return this.markAllRead(chatKey);
  }

  /** 最近 senderId 出现过的活跃成员（带最后发言时间）。 */
  activeMembers(chatKey, limit = 10) {
    const st = this.#state(chatKey);
    const map = new Map();
    for (const m of st.messages) {
      if (m.self) continue;
      const prev = map.get(m.senderId);
      if (!prev || prev.lastTs < m.ts) {
        const role = m.senderRole || prev?.role;
        map.set(m.senderId, { userId: m.senderId, name: m.senderName, lastTs: m.ts, count: (prev?.count || 0) + 1, ...(role ? { role } : {}) });
      } else {
        prev.count += 1;
      }
    }
    return [...map.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, Math.max(1, limit));
  }

  #trim(st) {
    if (this.maxPerChat > 0 && st.messages.length > this.maxPerChat) {
      st.messages.splice(0, st.messages.length - this.maxPerChat);
    }
  }
}
