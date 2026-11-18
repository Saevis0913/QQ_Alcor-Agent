// 表情库控制台接口：列表、原图、上传、删除、改标签、定期清理。
//
// 和聊天链路共用同一个 StickerManager（同一份 SQLite 索引），所以这里删掉/加上
// 的条目立即影响 prompt 与发送；反过来插件自动收藏的条目也会出现在页面上。
import fs from 'node:fs';
import path from 'node:path';
import { detectImageExt } from './image-type.js';
import { localStickerPath } from './sticker-manager.js';
import { logger } from './logger.js';

const UPLOAD_LIMIT = 8 * 1024 * 1024;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

function decodeDataUrl(value) {
  const text = String(value ?? '');
  const match = /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(text);
  if (!match) return null;
  try {
    return Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  } catch {
    return null;
  }
}

export function createStickerRoutes({ stickers, readBody, log }) {
  // app 传进来的是 (level, scope, text) 形式的函数；这里容错，避免日志把请求打成 500。
  const writeLog = typeof log === 'function'
    ? log
    : (...parts) => { try { logger.info(parts.join(' ')); } catch { /* 日志失败不影响业务 */ } };
  const fail = (json, res, status, code, message) => json(res, status, { status: 'failed', retcode: status, data: null, wording: code, message });

  return [
    {
      method: 'GET', pattern: '/api/stickers/list',
      handler: async ({ url, res, json }) => {
        const query = {
          sort: url.searchParams.get('sort') || 'created',
          q: url.searchParams.get('q') || '',
          tag: url.searchParams.get('tag') || '',
          scope: url.searchParams.get('scope') || '',
          limit: Number(url.searchParams.get('limit') || 60),
          offset: Number(url.searchParams.get('offset') || 0)
        };
        const page = stickers.listPage(query);
        return json(res, 200, {
          status: 'ok', retcode: 0,
          data: {
            items: page.items.map((row) => ({
              id: row.id,
              desc: row.desc || '',
              tags: Array.isArray(row.tags) ? row.tags : [],
              localNote: row.localNote || '',
              usage: row.usage || '',
              bytes: Number(row.bytes) || 0,
              createdAt: row.createdAt || '',
              lastUsedAt: row.lastUsedAt || '',
              useCount: Number(row.useCount) || 0,
              source: (!row.qqFile || row.source === 'local') ? 'local' : 'qq',
              lost: Boolean(row.persistFailed),
              key: row.key,
              rowid: row.rowid
            })),
            next: page.next,
            total: page.total ?? 0,
            stats: page.stats
          }
        });
      }
    },
    {
      method: 'GET', pattern: /^\/api\/stickers\/raw\/([\w.-]{1,120})$/,
      handler: async ({ res, json, match }) => {
        const entry = stickers.store.get(decodeURIComponent(match[1]));
        const file = entry ? localStickerPath(entry.url) : null;
        if (!file) return fail(json, res, 404, 'STICKER_FILE_MISSING', '这张表情的原图不在本地了');
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, {
          'content-type': MIME[ext] || 'application/octet-stream',
          'content-length': String(fs.statSync(file).size),
          // 同一条表情的图片内容不会变（文件名按内容哈希），可以放心缓存。
          'cache-control': 'private, max-age=86400',
          'x-content-type-options': 'nosniff'
        });
        res.end(fs.readFileSync(file));
        return undefined;
      }
    },
    {
      method: 'POST', pattern: '/api/stickers/upload',
      handler: async ({ req, res, json }) => {
        let body;
        try {
          body = await readBody(req, { maxBytes: UPLOAD_LIMIT });
        } catch (error) {
          return fail(json, res, error?.status || 400, 'STICKER_UPLOAD_TOO_LARGE', '图片太大，换一张小一点的');
        }
        const buffer = decodeDataUrl(body?.dataUrl ?? body?.image ?? '');
        if (!buffer?.length) {
          const looksLikeDataUrl = /^data:/i.test(String(body?.dataUrl || ''));
          return looksLikeDataUrl
            ? fail(json, res, 400, 'STICKER_FORMAT_UNSUPPORTED', '只支持 png / jpg / gif / webp / bmp')
            : fail(json, res, 400, 'STICKER_BYTES_REQUIRED', '没有可用的图片数据');
        }
        if (!detectImageExt(buffer)) return fail(json, res, 400, 'STICKER_FORMAT_UNSUPPORTED', '只支持 png/jpg/gif/webp/bmp');
        const tags = String(body?.tags ?? '').split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean).slice(0, 8);
        const result = stickers.addLocalSticker({
          buffer,
          tags,
          desc: String(body?.desc ?? '').slice(0, 60),
          localNote: String(body?.localNote ?? '').slice(0, 160)
        });
        writeLog('info', 'sticker', `手动添加表情 ${result.entry.id}${result.duplicate ? '（已存在，补标签）' : ''}`);
        return json(res, 200, { status: 'ok', retcode: 0, data: { id: result.entry.id, duplicate: Boolean(result.duplicate), stats: stickers.stats() } });
      }
    },
    {
      method: 'POST', pattern: '/api/stickers/delete',
      handler: async ({ req, json, res }) => {
        const body = await readBody(req);
        const id = String(body?.id ?? '').trim();
        if (!id) return fail(json, res, 400, 'STICKER_ID_REQUIRED', '缺少表情 id');
        if (stickers.store && !stickers.store.get(id)) return fail(json, res, 404, 'STICKER_NOT_FOUND', '这张表情已经不在了');
        const result = stickers.removeEntry(id);
        writeLog('info', 'sticker', `删除表情 ${id}`);
        return json(res, 200, { status: 'ok', retcode: 0, data: { ...result, stats: stickers.stats() } });
      }
    },
    {
      method: 'POST', pattern: '/api/stickers/tags',
      handler: async ({ req, json, res }) => {
        const body = await readBody(req);
        const id = String(body?.id ?? '').trim();
        if (!id) return fail(json, res, 400, 'STICKER_ID_REQUIRED', '缺少表情 id');
        const patch = {};
        if (body?.desc !== undefined) patch.desc = String(body.desc).slice(0, 60);
        if (body?.localNote !== undefined) patch.localNote = String(body.localNote).slice(0, 160);
        if (body?.tags !== undefined) {
          const list = Array.isArray(body.tags) ? body.tags : String(body.tags).split(/[,，\s]+/);
          patch.tags = [...new Set(list.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 8);
        }
        const entry = stickers.note(id, patch);
        if (!entry) return json(res, 404, { status: 'failed', retcode: 404, data: null, wording: 'STICKER_NOT_FOUND' });
        return json(res, 200, { status: 'ok', retcode: 0, data: { id, desc: entry.desc, tags: entry.tags, localNote: entry.localNote } });
      }
    },
    {
      method: 'POST', pattern: '/api/stickers/prune',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req);
        const result = stickers.prune({ keepDays: Number(body?.keepDays || 7) });
        writeLog('info', 'sticker', `清理无引用原图 ${result.removed} 个`);
        return json(res, 200, { status: 'ok', retcode: 0, data: result });
      }
    }
  ];
}
