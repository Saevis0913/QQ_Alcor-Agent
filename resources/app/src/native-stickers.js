import { createHash, randomUUID } from 'node:crypto';
import fileSystem from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_DIR, getConfig } from './config.js';
import { ensureStickerDecision, checkStickerDispatch } from './sticker-policy.js';
import { extractAnimatedImageFrames, isAnimatedImage } from './group-media.js';
import { compressImage } from './image-compress.js';
import { detectImageType } from './image-type.js';
import { fetchMessageImage } from './onebot.js';
import { localStickerPath } from './sticker-manager.js';
import { formatStickerList, normalizeStickerEntry, saveStickerStore } from './stickers.js';
import { isSkillEnabledInConfig } from './skills/config.js';
import { skillManager } from './skills/manager.js';
import { stickerHash, STICKER_BATCH_LIMIT } from './builtins/sticker-model.js';

const OPAQUE_FILE = /^alcor-media-[a-f0-9]{64}$/;
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_BATCH_BYTES = 20 * 1024 * 1024;
const reviewEnabled = () => isSkillEnabledInConfig('sticker-review');
const usable = (entry) => !reviewEnabled() || entry.reviewVersion === 1;

function currentScope(ctx) {
  const account = String(ctx.selfId ?? '');
  const chat = String(ctx.chatKey ?? '');
  if (!/^[1-9]\d{0,9}$/.test(account) || !/^(group|private):[1-9]\d{0,9}$/.test(chat) ||
      String(ctx.onebot?.selfId ?? '') !== account) {
    throw new Error('无法确认当前 QQ 账号和会话');
  }
  return 'native_' + createHash('sha256').update(account + ':' + chat).digest('hex').slice(0, 24) + '_';
}

function localEntry(ctx, stickerId) {
  const id = String(stickerId ?? '');
  const scope = currentScope(ctx);
  const entry = ctx.stickers.entries.find((row) => row.id === id && row.id.startsWith(scope));
  if (!entry || !OPAQUE_FILE.test(entry.qqFile) || !usable(entry)) throw new Error('当前会话的本地库没有这个可用表情');
  return entry;
}

export function listNativeStickers(ctx, args = {}) {
  const entries = nativeStickerEntries(ctx);
  return { ...formatStickerList(entries, args.query, Math.min(100, Math.max(1, Number(args.limit) || 24))), source: 'agent-local' };
}

export function nativeStickerEntries(ctx) {
  const scope = currentScope(ctx);
  return ctx.stickers.entries.filter((row) => row.id.startsWith(scope) && OPAQUE_FILE.test(row.qqFile) && usable(row));
}

export async function collectNativeSticker(ctx, { messageId, note } = {}) {
  const result = await collectNativeStickerBatch(ctx, { messageIds: [messageId], note, limit: 1, signal: ctx.signal });
  return result.collected[0];
}

export async function collectNativeStickerBatch(ctx, { messageIds, note, classify, signal, guard, limit = STICKER_BATCH_LIMIT } = {}) {
  const config = getConfig().sticker;
  if (!config?.collectEnabled) throw new Error('本地收藏表情功能未开启');
  const scope = currentScope(ctx);
  const check = () => {
    signal?.throwIfAborted();
    guard?.();
    if (!getConfig().sticker?.collectEnabled) throw new Error('本地收藏表情功能未开启');
    if (scope !== currentScope(ctx)) throw new Error('收藏时 QQ 账号或会话已切换');
  };
  check();
  const media = new Map();
  const plainImages = new Map();
  let seen = 0;
  for (const mid of [...new Set(Array.isArray(messageIds) ? messageIds : [])].slice(0, STICKER_BATCH_LIMIT)) {
    if (!/^-?[1-9]\d{0,19}$/.test(String(mid))) continue;
    const message = ctx.store.findByMid(ctx.chatKey, mid);
    if (!message) continue;
    seen += 1;
    if (message.self || message.recalled || (message.selfId && String(message.selfId) !== String(ctx.selfId))) continue;
    for (const item of message?.media ?? []) {
      if (item.kind !== 'image' || !OPAQUE_FILE.test(item.file)) continue;
      if (item.sticker) media.set(item.file, item);
      else plainImages.set(item.file, item);
      if (media.size >= limit) break;
    }
    if (media.size >= limit) break;
  }
  // QQ 只对"表情"子类型给 sub_type=1；用户指着普通图片说"收藏这个"时也要能收，
  // 所以表情优先，没有表情时回落到同一消息里的图片（仍然只收一张）。
  if (!media.size) for (const [file, item] of plainImages) { media.set(file, item); if (media.size >= limit) break; }
  if (!media.size) {
    const error = new Error(seen ? '这条消息里没有可收藏的图片或表情' : '这条消息不在本地记录里（可能太旧，或来自合并转发）');
    error.code = seen ? 'STICKER_MEDIA_NOT_FOUND' : 'STICKER_MESSAGE_NOT_IN_HISTORY';
    throw error;
  }
  const reviewer = reviewEnabled() ? skillManager.getCapabilityProviders('sticker.review', ctx)
    .find((provider) => provider.skillId === 'sticker-review')?.fn : null;
  if (reviewEnabled() && !reviewer) throw new Error('表情审核已开启但暂不可用');
  const now = Date.now();
  ctx.stickers.collectTimes = ctx.stickers.collectTimes.filter((time) => now - time < 3600000);
  const candidates = [];
  const already = [];
  let aggregateBytes = 0;
  for (const item of media.values()) {
    check();
    const id = scope + item.file.slice('alcor-media-'.length);
    const existing = ctx.stickers.entries.find((row) => row.id === id);
    if (existing && usable(existing)) {
      if (!classify && note) {
        const text = String(note).slice(0, 160);
        const updated = normalizeStickerEntry({ ...existing, localNote: text, desc: existing.tags.length ? existing.desc : text.slice(0, 40) });
        const entries = ctx.stickers.entries.map((row) => row.id === id ? updated : row);
        saveStickerStore(entries);
        ctx.stickers.entries = entries;
        already.push(collectionResult(updated));
      } else {
        already.push(collectionResult(existing));
      }
      continue;
    }
    if (ctx.stickers.collectTimes.length >= Math.max(1, Number(config.maxCollectPerHour) || 10)) {
      if (!candidates.length && !already.length) throw new Error('本地收藏表情过于频繁');
      break;
    }
    ctx.stickers.collectTimes.push(now);
    let buffer;
    try {
      ({ buffer } = await fetchMessageImage(ctx.onebot, { file: item.file }, { maxBytes: MAX_BYTES, signal }));
    } catch (error) {
      check();
      if (!classify) throw error;
      continue;
    }
    check();
    const type = detectImageType(buffer);
    if (!type || aggregateBytes + buffer.length > MAX_BATCH_BYTES) continue;
    aggregateBytes += buffer.length;
    candidates.push({ id, item, buffer, type, hash: stickerHash(buffer) });
  }
  if (!candidates.length) {
    if (!already.length) throw new Error('表情未返回可保存的图片格式');
    return { collected: already, rejected: 0 };
  }
  const request = {
    account: String(ctx.selfId), chatKey: ctx.chatKey, session: ctx.session, signal,
    buffers: candidates.map(({ buffer }) => buffer)
  };
  const reviews = reviewer ? await reviewer(request) : null;
  check();
  const approved = candidates.filter((_, index) => !reviewer || reviews?.[index]?.approved === true);
  if (!approved.length && !classify) throw new Error('表情未通过审核（判定为恐怖、猎奇或恶俗内容），未收藏');
  const labels = classify && approved.length ? await classify({
    ...request, buffers: approved.map(({ buffer }) => buffer)
  }) : null;
  check();
  if (!reviewer && reviewEnabled()) throw new Error('表情审核设置已变化，请重新收藏');
  if (reviewer && reviewEnabled() && skillManager.getCapabilityProviders('sticker.review', ctx)
    .find((provider) => provider.skillId === 'sticker-review')?.fn !== reviewer) {
    throw new Error('表情审核插件已重载，请重新收藏');
  }
  const accepted = approved.flatMap((candidate, index) => !classify || labels?.[index]?.keep === true
    ? [{ ...candidate, labels: labels?.[index] }]
    : []);
  return { collected: [...already, ...saveCollection(ctx, scope, accepted, note, Boolean(reviewer))],
    rejected: candidates.length - accepted.length };
}

function collectionResult(entry) {
  return { collected: true, id: entry.id, note: entry.localNote, tags: entry.tags,
    qqSaved: false, localSaved: true, source: 'agent-local' };
}

function saveCollection(ctx, scope, candidates, note, reviewed) {
  if (!candidates.length) return [];
  const root = path.join(DATA_DIR, 'sticker-images');
  const entries = new Map(ctx.stickers.entries.map((entry) => [entry.id, entry]));
  const result = new Map();
  const created = [];
  fileSystem.mkdirSync(root, { recursive: true });
  try {
    for (const { id, item, buffer, type, hash, labels } of candidates) {
      const duplicate = [...entries.values()].find((entry) =>
        entry.id.startsWith(scope) && entry.contentHash === hash && usable(entry));
      const prior = entries.get(id);
      if (duplicate) {
        result.set(duplicate.id, collectionResult(duplicate));
        continue;
      }
      const filename = path.join(root, id + '-' + hash + type.ext);
      if (!fileSystem.existsSync(filename)) {
        const temporary = filename + '.' + randomUUID() + '.tmp';
        try {
          fileSystem.writeFileSync(temporary, buffer, { flag: 'wx' });
          fileSystem.renameSync(temporary, filename);
          created.push(filename);
        } finally {
          fileSystem.rmSync(temporary, { force: true });
        }
      }
      const localFile = pathToFileURL(filename).href;
      const text = String(note || prior?.localNote || item.summary || '').slice(0, 160);
      const entry = normalizeStickerEntry({
        ...prior, id, qqFile: item.file, emojiId: '', url: localFile, localFile, contentHash: hash,
        reviewVersion: reviewed ? 1 : undefined, desc: labels?.emotion || text.slice(0, 40),
        localNote: text, source: 'ai', tags: labels?.tags || prior?.tags, usage: labels?.usage || prior?.usage
      });
      entries.set(id, entry);
      result.set(id, collectionResult(entry));
    }
    saveStickerStore([...entries.values()]);
    ctx.stickers.entries = [...entries.values()];
  } catch (error) {
    for (const file of created) {
      try { fileSystem.rmSync(file, { force: true }); } catch { /* Keep the original store error. */ }
    }
    throw error;
  }
  return [...result.values()];
}

export async function previewNativeSticker(ctx, { stickerId } = {}) {
  const entry = localEntry(ctx, stickerId);
  const filename = localStickerPath(entry.localFile);
  if (!filename) throw new Error('找不到本地表情图片');
  const root = await fs.realpath(path.join(DATA_DIR, 'sticker-images'));
  const file = await fs.realpath(filename);
  if (path.relative(root, file) !== path.basename(filename)) throw new Error('本地表情图片路径无效');
  const handle = await fs.open(file, 'r');
  let buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) throw new Error('本地表情图片大小无效');
    buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) throw new Error('本地表情图片读取不完整');
  } finally {
    await handle.close();
  }
  const type = detectImageType(buffer);
  if (!type) throw new Error('本地表情图片格式无效');
  let images;
  if (isAnimatedImage(buffer, type.mime)) {
    images = await extractAnimatedImageFrames(buffer);
  } else {
    const image = await compressImage(buffer);
    images = [`data:${image.compressed ? image.mime : type.mime};base64,${image.buffer.toString('base64')}`];
  }
  return { content: [
    { type: 'text', text: `本地 QQ 表情 ${entry.id}。${entry.desc || ''}。结合语境理解情绪或互动。` },
    ...images.map((url) => ({ type: 'image_url', image_url: { url } }))
  ] };
}

export function resolveReceivedMedia(ctx, { messageId, stickerId, file } = {}) {
  const direct = String(file ?? '');
  if (direct) {
    if (!OPAQUE_FILE.test(direct)) throw Object.assign(new Error('这个媒体引用无效，只能发本会话收到过的图片或表情'), { code: 'MEDIA_REF_INVALID' });
    return { file: direct, sticker: false };
  }
  const id = String(stickerId ?? '').trim();
  if (id) return { file: localEntry(ctx, id).qqFile, sticker: true, stickerId: id };
  const mid = String(messageId ?? '').trim();
  if (!/^-?[1-9]\d{0,19}$/.test(mid)) throw Object.assign(new Error('要给一个消息 id，或一个收藏表情 id'), { code: 'MEDIA_TARGET_REQUIRED' });
  const message = ctx.store.findByMid(ctx.chatKey, mid);
  if (!message) throw Object.assign(new Error('这条消息不在本地记录里（可能太旧，或来自合并转发）'), { code: 'MEDIA_MESSAGE_NOT_IN_HISTORY' });
  const media = (message.media ?? []).filter((item) => item.kind === 'image' && OPAQUE_FILE.test(item.file));
  const picked = media.find((item) => item.sticker) ?? media[0];
  if (!picked) throw Object.assign(new Error('这条消息里没有可以转发的图片或表情'), { code: 'MEDIA_NOT_FOUND' });
  return { file: picked.file, sticker: Boolean(picked.sticker) };
}

export async function sendReceivedMedia(ctx, args = {}, { send, sendImage } = {}) {
  const target = resolveReceivedMedia(ctx, args);
  let result;
  if (target.sticker) {
    if (typeof send !== 'function') throw new Error('未连接已收表情发送队列');
    // 这里的表情是「按消息转发/按 id 发送」，属于明确请求，不受主动配图概率限制（仍受总开关与窗口上限约束）。
  const stickerPolicy = ensureStickerDecision(ctx.session, { selfId: ctx.selfId, chatKey: ctx.chatKey, sticker: getConfig().sticker, requested: true });
    checkStickerDispatch(stickerPolicy, { selfId: ctx.selfId, chatKey: ctx.chatKey, sticker: getConfig().sticker, signal: ctx.signal });
    result = await send(target.file, { stickerPolicy, signal: ctx.signal, expected_self_id: ctx.selfId,
      beforeDispatch: () => { if (target.stickerId) localEntry(ctx, target.stickerId); } });
  } else {
    // 图片与表情共用一条路径，但图片不受表情档位与配额限制 —— 否则「档位低时连图都发不出」。
    if (typeof sendImage !== 'function') throw new Error('未连接已收图片发送队列');
    result = await sendImage(target.file, { signal: ctx.signal, expected_self_id: ctx.selfId });
  }
  return { messageId: result?.message_id ?? null, sticker: target.sticker, file: target.file };
}

export async function sendNativeSticker(ctx, { stickerId, replyToMessageId, atUserId } = {}, { send } = {}) {
  if (String(replyToMessageId ?? '').trim() || String(atUserId ?? '').trim()) {
    const error = new Error('已收表情只能单独发送：不能带引用或 @');
    error.code = 'STICKER_STANDALONE_ONLY';
    throw error;
  }
  const entry = localEntry(ctx, stickerId);
  if (typeof send !== 'function') throw new Error('未连接已收表情发送队列');
  const stickerPolicy = ensureStickerDecision(ctx.session, { selfId: ctx.selfId, chatKey: ctx.chatKey, sticker: getConfig().sticker });
  checkStickerDispatch(stickerPolicy, { selfId: ctx.selfId, chatKey: ctx.chatKey, sticker: getConfig().sticker, signal: ctx.signal });
  const result = await send(entry.qqFile, { stickerPolicy, signal: ctx.signal, expected_self_id: ctx.selfId,
    beforeDispatch: () => { localEntry(ctx, stickerId); } });
  return { stickerId: entry.id, messageId: result?.message_id ?? null,...(result?.bookkeepingWarning?{bookkeepingWarning:result.bookkeepingWarning}:{}) };
}
