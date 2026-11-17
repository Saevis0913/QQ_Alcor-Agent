import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../config.js';
import { checkStickerDispatch } from '../sticker-policy.js';
import { detectImageType } from '../image-type.js';
import { safeFetchBinary } from '../safe-fetch.js';
import { checkStickerScope, stickerHash } from './sticker-model.js';
import { waitForRead } from '../network-read.js';

const INDEX_URL = 'https://aigengtu.com/gallery-index.json';
const ARCHIVE_URL = 'https://aigengtu.com/archive';
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_ITEMS = 8000;
const CACHE_MS = 6 * 60 * 60 * 1000;
export const GENGJING_MAX_IMAGE_BYTES = 1024 * 1024;

const clean = (value, max) => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max)
  : '';
const fold = (value) => value.normalize('NFKC').toLowerCase();
const mimeType = (value) => String(value).split(';')[0].trim().toLowerCase();

function originalId(raw) {
  return /^https:\/\/img\.aigengtu\.com\/meme\/(\d{1,7})\.(?:webp|png|jpe?g|gif)$/.exec(raw)?.[1];
}

export function parseGengjingIndex(data) {
  if (!data?.gallery || typeof data.gallery !== 'object' || Array.isArray(data.gallery)) {
    throw new Error('梗鲸索引格式已变化');
  }
  const rows = new Map();
  let seen = 0;
  for (const catalog of Object.values(data.gallery)) {
    if (!Array.isArray(catalog?.images)) continue;
    for (const image of catalog.images) {
      if (++seen > MAX_ITEMS) throw new Error('梗鲸索引条目超过上限');
      const original = typeof image?.original === 'string' && image.original.length <= 200 ? image.original.trim() : '';
      const id = originalId(original);
      const title = clean(image?.alt || image?.name, 180);
      if (!id || !title || rows.has(id)) continue;
      const character = clean(image.category || catalog.name, 70);
      const story = clean(image.story?.zh, 500);
      const author = clean(image.source_author || image.story?.contributor, 80);
      const searchText = fold([title, image.alt_en, image.alt_ja, image.alt_zh_Hant ?? image['alt_zh-Hant'],
        character, story].map((value) => clean(value, 500)).join(' '));
      rows.set(id, { id, title, character, author, original, searchText,
        page: `https://aigengtu.com/zh/meme/${id}` });
    }
  }
  if (!rows.size) throw new Error('梗鲸索引没有可用条目');
  return [...rows.values()];
}

export function searchGengjing(rows, { keyword, character } = {}) {
  const query = fold(clean(keyword, 100));
  const role = fold(clean(character, 70));
  const tokens = query.split(/\s+/).filter(Boolean).slice(0, 8);
  if (!tokens.length && !role) throw new Error('请提供梗鲸关键词或角色');
  return rows.filter((row) => (!role || fold(row.character).includes(role)) &&
    tokens.every((token) => row.searchText.includes(token) || row.id === token.replace(/^#/, '')))
    .sort((a, b) => Number(fold(b.title).includes(query)) - Number(fold(a.title).includes(query)));
}

function dimensions(buffer, mime) {
  const text = (from, to) => buffer.toString('ascii', from, to);
  if (mime === 'image/png') {
    if (buffer.length < 45 || text(12, 16) !== 'IHDR' || text(buffer.length - 8, buffer.length - 4) !== 'IEND') return [];
    return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
  }
  if (mime === 'image/gif') {
    if (buffer.length < 20 || buffer.at(-1) !== 0x3b) return [];
    return [buffer.readUInt16LE(6), buffer.readUInt16LE(8)];
  }
  if (mime === 'image/webp') {
    if (buffer.length < 30 || buffer.readUInt32LE(4) + 8 !== buffer.length) return [];
    const header = text(12, 16);
    if (header === 'VP8X') return [buffer.readUIntLE(24, 3) + 1, buffer.readUIntLE(27, 3) + 1];
    if (header === 'VP8L' && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
    if (header === 'VP8 ' && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return [buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff];
    }
    return [];
  }
  if (mime !== 'image/jpeg' || buffer.readUInt16BE(buffer.length - 2) !== 0xffd9) return [];
  for (let offset = 2; offset + 9 < buffer.length;) {
    if (buffer[offset++] !== 0xff) return [];
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (offset + 7 >= buffer.length) return [];
    const size = buffer.readUInt16BE(offset);
    if (size < 2 || offset + size > buffer.length) return [];
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 8) {
      return [buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3)];
    }
    if (marker === 0xda) break;
    offset += size;
  }
  return [];
}

function networkOptions(signal) {
  // Both site endpoints have canonical URLs. Disallow redirects on this feature's requests.
  return { browseLocked: true, publicOnly: true, httpsOnly: true, maxRedirects: 0, timeoutMs: 15000, signal };
}

export async function downloadGengjingImage(url, {
  signal, fetchBinary = safeFetchBinary, maxBytes = GENGJING_MAX_IMAGE_BYTES
} = {}) {
  if (!originalId(url)) throw new Error('梗鲸原图来源无效');
  const { buffer, contentType } = await fetchBinary(url, maxBytes, networkOptions(signal));
  signal?.throwIfAborted();
  if (!Buffer.isBuffer(buffer) || buffer.length >= maxBytes) throw new Error('梗鲸原图超过大小上限');
  const type = detectImageType(buffer);
  const declared = mimeType(contentType);
  if (!type || (declared === 'image/jpg' ? 'image/jpeg' : declared) !== type.mime) {
    throw new Error('梗鲸原图格式无效');
  }
  const [width, height] = dimensions(buffer, type.mime);
  if (!width || !height || width > 4096 || height > 4096 || width * height > 16_000_000) {
    throw new Error('梗鲸原图尺寸无效或超过上限');
  }
  return buffer;
}

function readHistory(file) {
  try {
    if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('history over limit');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('invalid history');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('梗鲸发送记录无法读取');
  }
}

function updateHistory(file, id, value) {
  const history = readHistory(file);
  if (value) history[id] = value;
  else delete history[id];
  if (Object.keys(history).length > MAX_ITEMS) throw new Error('梗鲸会话发送记录已达上限');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(history), { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function checkCooldown(history, now, cooldownMs) {
  if (cooldownMs > 0 && Object.values(history).some((record) =>
    Number.isFinite(record.at) && now >= record.at && now - record.at < cooldownMs)) {
    throw Object.assign(new Error('当前会话的梗鲸图片发送间隔未到'), { code: 'GENGJING_COOLDOWN' });
  }
}

function source(row) {
  return { id: row.id, title: row.title, character: row.character, author: row.author || undefined,
    page: row.page, archive: ARCHIVE_URL, source: '梗鲸 · 蓝色大肥鱼档案馆' };
}

export function createGengjing({ runtime, dir = path.join(DATA_DIR, 'builtins', 'gengjing'), fetchBinary = safeFetchBinary }) {
  let cache, loading;
  async function select(input) {
    checkStickerScope(runtime, input);
    if (!cache || runtime.now() - cache.time >= CACHE_MS) {
      if (!loading) loading = (async () => {
      const { buffer, contentType } = await fetchBinary(INDEX_URL, MAX_INDEX_BYTES, {
        ...networkOptions(), acceptGzip: true, timeoutMs: 35000
      });
      if (buffer.length >= MAX_INDEX_BYTES || mimeType(contentType) !== 'application/json') throw new Error('梗鲸索引响应无效');
      let index;
      try { index = JSON.parse(buffer.toString('utf8')); } catch { throw new Error('梗鲸索引无法解析'); }
      cache = { time: runtime.now(), rows: parseGengjingIndex(index) };
      })().finally(() => { loading = null; });
      await waitForRead(loading, input.signal);
      checkStickerScope(runtime, input);
    }
    return searchGengjing(cache.rows, input);
  }

  return {
    async search(input) {
      return (await select(input)).slice(0, 8).map(source);
    },
    async send(input) {
      const { account, chatKey, signal, imageId, cooldownMs } = input;
      const check = () => {
        checkStickerScope(runtime, input);
        checkStickerDispatch(input.stickerPolicy, { selfId: account, chatKey, signal, sticker: getConfig().sticker });
      };
      check();
      const file = path.join(dir, account, chatKey.replace(':', '-'), 'history-v1.json');
      checkCooldown(readHistory(file), runtime.now(), cooldownMs);
      let supported;
      try { supported = await runtime.onebot.call('can_send_image', {}, 5000); } catch (error) {
        check();
        throw new Error(error?.retcode || /不支持|unsupported|unknown action/i.test(error?.message ?? '')
          ? '当前 QQ 原生服务未提供原图发送能力'
          : '无法确认当前 QQ 的原图发送能力');
      }
      check();
      if (supported?.yes !== true) throw new Error('当前 QQ 原生服务未提供原图发送能力');
      const maxBytes = Number.isSafeInteger(supported.max_bytes) && supported.max_bytes > 0
        ? Math.min(GENGJING_MAX_IMAGE_BYTES, supported.max_bytes)
        : GENGJING_MAX_IMAGE_BYTES;
      const formats = Array.isArray(supported.formats) ? new Set(supported.formats) : null;
      const candidates = (await select(input)).filter((row) => !imageId || row.id === imageId);
      if (!candidates.length) throw new Error('梗鲸没有符合条件的图片');
      let downloadError;
      for (const row of candidates.slice(0, 6)) {
        if (Object.hasOwn(readHistory(file), row.id)) continue;
        let buffer;
        try {
          if (formats && !formats.has(row.original.split('.').at(-1).replace(/^jpg$/, 'jpeg'))) {
            throw new Error('当前 QQ 原生服务不支持该原图格式');
          }
          buffer = await downloadGengjingImage(row.original, { fetchBinary, signal, maxBytes });
          const actualFormat = detectImageType(buffer).mime.slice('image/'.length);
          if (formats && !formats.has(actualFormat)) throw new Error('当前 QQ 原生服务不支持该原图格式');
        } catch (error) {
          check();
          downloadError = error;
          continue;
        }
        check();
        const hash = stickerHash(buffer);
        const history = readHistory(file);
        if (history[row.id] || Object.values(history).some((record) => record.hash === hash)) continue;
        // Persist the reservation before handing work to the queue. A crash leaves a
        // conservative unknown receipt that blocks replay of the same image on restart.
        let result;
        let reserved = false;
        const reserve = () => {
          check();
          const latest = readHistory(file);
          const at = runtime.now();
          checkCooldown(latest, at, cooldownMs);
          if (latest[row.id] || Object.values(latest).some((record) => record.hash === hash)) {
            throw new Error('匹配图片已发过或有未知发送记录');
          }
          updateHistory(file, row.id, { hash, state: 'unknown', at });
          reserved = true;
        };
        try {
          result = await runtime.sender.sendMedia(chatKey, [
            { type: 'image', data: { file: 'base64://' + buffer.toString('base64') } }
          ], { label: '[梗鲸图片]', expected_self_id: account, signal, beforeDispatch: reserve,
            sticker: true, stickerPolicy: input.stickerPolicy,
            dedupeKey: `gengjing:${account}:${hash}` });
        } catch (error) {
          if (reserved && error?.delivery !== 'unknown' && !signal?.aborted && runtime.isCurrent(account)) {
            updateHistory(file, row.id, null);
          }
          throw error;
        }
        if (!/^-?[1-9]\d*$/.test(String(result?.message_id ?? ''))) {
          throw Object.assign(new Error('梗鲸图片送达状态未知，已阻止自动重发'), { delivery: 'unknown', nonretryable: true });
        }
        let bookkeepingWarning = result.bookkeepingWarning;
        if (!signal?.aborted && runtime.isCurrent(account)) {
          try { updateHistory(file, row.id, { hash, state: 'sent', messageId: result.message_id, at: runtime.now() }); } catch {
            bookkeepingWarning = '图片已确认发送，发送记录仍保留为未知，已阻止重复发送。';
          }
        }
        return { sent: true, messageId: result.message_id, ...source(row), ...(bookkeepingWarning && { bookkeepingWarning }) };
      }
      if (downloadError) throw downloadError;
      throw new Error('匹配图片已发过或有未知发送记录，请换个关键词或角色');
    }
  };
}
