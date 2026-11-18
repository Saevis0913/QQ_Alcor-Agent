import path from 'node:path';
import fs from 'node:fs';
import { normalizeStickerEntry } from './stickers.js';

/**
 * 表情索引（纯 JS，无原生依赖 —— 打包运行的是 Electron 33 / Node 20.18，
 * 那里没有 node:sqlite，所以索引自己做）。
 *
 * 存储分两层，内存只碰第一层：
 *   1) `stickers/index.json`：每条只留 8 个短字段的**元组**（约 90 字节），
 *      常驻内存的就是这个数组；条数由 sticker.maxEntries 封顶，不会无限长。
 *   2) `stickers/docs/<xx>/<id>.json`：整条记录，一图一文件，按需读取 ——
 *      列表页只读当前页 60 个文件，详情只读 1 个。
 *
 * 于是：单条增删 O(1)（改索引 + 一个文件），整库重写不存在，
 * 预览/排序/检索都不需要把原记录全读进内存。
 */

const MEMORY_WINDOW = 512;
const SORT_KEYS = Object.freeze({ created: 2, name: 3, size: 4, used: 5 });

let cached = null;

function indexPath(dir) {
  return path.join(dir, 'stickers', 'index.json');
}

function docsRoot(dir) {
  return path.join(dir, 'stickers', 'docs');
}

function docPath(dir, id) {
  const key = String(id);
  const shard = /[A-Za-z0-9]{2}$/.test(key) ? key.slice(-2) : '__';
  return path.join(docsRoot(dir), shard, `${key}.json`);
}

function stamp(value) {
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? time : Date.now();
}

function tagsText(entry) {
  return [entry.desc, entry.localNote, (entry.tags ?? []).join(' ')].filter(Boolean).join(' ');
}

/** 索引行：[id, scope, createdAt, name, bytes, lastUsedAt, hash, tagsText] */
function rowOf(entry) {
  return [
    String(entry.id),
    String(entry.scope || scopeOf(entry)),
    stamp(entry.createdAt),
    String(entry.desc || entry.localNote || entry.id).slice(0, 120),
    Number(entry.bytes) || 0,
    stamp(entry.lastUsedAt),
    typeof entry.contentHash === 'string' ? entry.contentHash : '',
    tagsText(entry).toLowerCase().slice(0, 200)
  ];
}

function scopeOf(entry) {
  const match = /^(native_[a-f0-9]{24}_)/.exec(String(entry.id ?? ''));
  return match ? match[1] : 'native_global_';
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

export function openStickerStore({ dir }) {
  const indexFile = indexPath(dir);
  if (cached && cached.dir === dir) return cached;

  fs.mkdirSync(docsRoot(dir), { recursive: true });
  let rows = [];
  try {
    let text = fs.readFileSync(indexFile, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) rows = parsed.filter((row) => Array.isArray(row) && row.length >= 6);
  } catch { rows = []; }

  // id → 行下标；只在增删时维护，查找 O(1)。
  const position = new Map(rows.map((row, index) => [row[0], index]));
  let dirty = false;
  let flushTimer = null;

  const flush = () => {
    if (!dirty) return;
    dirty = false;
    try { writeJsonAtomic(indexFile, rows); } catch { dirty = true; }
  };
  const touch = () => {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 400);
    flushTimer.unref?.();
  };

  function put(entry) {
    const normalized = normalizeStickerEntry(entry);
    if (!normalized) return null;
    const prevAt = position.get(String(normalized.id));
    const prevBytes = prevAt === undefined ? 0 : Number(rows[prevAt][4]) || 0;
    // normalizeStickerEntry 只认它认识的字段，bytes/scope 这类元数据要沿上一版补回来，
    // 否则改一次标签就把"原图大小"清零（曾把统计打成 0）。
    if (!Number(normalized.bytes)) normalized.bytes = Number(entry.bytes) || prevBytes;
    if (!normalized.scope) normalized.scope = String(entry.scope || (prevAt === undefined ? '' : rows[prevAt][1]) || '');
    const row = rowOf(normalized);
    const at = position.get(row[0]);
    if (at === undefined) {
      position.set(row[0], rows.length);
      rows.push(row);
    } else {
      rows[at] = row;
    }
    const file = docPath(dir, row[0]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(normalized), 'utf8');
    touch();
    return normalized;
  }

  function readDoc(id) {
    try {
      const text = fs.readFileSync(docPath(dir, id), 'utf8');
      const raw = JSON.parse(text);
      const entry = normalizeStickerEntry(raw);
      if (!entry) return null;
      // normalizeStickerEntry 只保留它认识的字段，bytes/scope 这类元数据得补回来。
      if (!entry.bytes) entry.bytes = Number(raw.bytes) || 0;
      if (!entry.scope) entry.scope = String(raw.scope || '');
      return entry;
    } catch { return null; }
  }

  function drop(id) {
    const key = String(id);
    const at = position.get(key);
    const hash = at === undefined ? '' : rows[at][6];
    if (at !== undefined) {
      rows.splice(at, 1);
      position.delete(key);
      for (let i = at; i < rows.length; i += 1) position.set(rows[i][0], i);
      touch();
    }
    try { fs.rmSync(docPath(dir, key), { force: true }); } catch { /* 文件已不在 */ }
    return hash ? [hash] : [];
  }

  const store = {
    dir,
    file: indexFile,
    count(scope = null) {
      if (!scope) return rows.length;
      return rows.reduce((total, row) => total + (row[1] === scope ? 1 : 0), 0);
    },
    bytes() {
      return rows.reduce((total, row) => total + (Number(row[4]) || 0), 0);
    },
    get(id) {
      return readDoc(id);
    },
    findByHash(scope, hash) {
      if (!hash) return null;
      const hit = rows.find((row) => row[6] === hash && (!scope || row[1] === scope));
      return hit ? readDoc(hit[0]) : null;
    },
    upsert(entry) {
      return put(entry);
    },
    upsertMany(entries) {
      if (!Array.isArray(entries) || !entries.length) return 0;
      let written = 0;
      for (const entry of entries) if (put(entry)) written += 1;
      flush();
      return written;
    },
    remove(id) {
      return drop(id);
    },
    /** 启动窗口：最近的一页（条数有上限，配合内存窗口）。 */
    recent(scope, limit = MEMORY_WINDOW) {
      return recentAll(limit).filter((entry) => scopeOf(entry) === scope);
    },
    recentAll(limit = MEMORY_WINDOW) {
      const size = Math.max(1, Math.min(5000, Number(limit) || MEMORY_WINDOW));
      return rows.slice()
        .sort((a, b) => b[2] - a[2])
        .slice(0, size)
        .map((row) => readDoc(row[0]))
        .filter(Boolean);
    },
    /**
     * 分页列表：排序与过滤都在索引行上做（只碰 8 个短字段），
     * 只有当前页的 60 条才去读 docs 文件。
     */
    list(query = {}) {
      const limit = Math.max(1, Math.min(200, Number(query.limit) || 60));
      const sortName = String(query.sort || 'created');
      const sortKey = SORT_KEYS[sortName] !== undefined ? SORT_KEYS[sortName] : 2;
      const q = String(query.q ?? '').trim().toLowerCase();
      const tag = String(query.tag ?? '').trim().toLowerCase();
      const scope = String(query.scope ?? '').trim();

      let pool = rows;
      if (scope) pool = pool.filter((row) => row[1] === scope);
      if (q) pool = pool.filter((row) => row[7].includes(q) || row[3].toLowerCase().includes(q) || row[0] === q);
      if (tag) pool = pool.filter((row) => row[7].includes(tag));

      const sorted = pool.slice().sort((a, b) => {
        // 名称按拼音正序（A→Z），日期/大小/最近使用按倒序（新的、大的、常用的在前）。
        if (sortKey === 3) return String(a[3]).localeCompare(String(b[3]), 'zh-Hans-CN');
        return Number(b[sortKey]) - Number(a[sortKey]);
      });

      // 偏移分页：索引行很小，切片成本可忽略；只有当前页去读 docs。
      const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
      const slice = sorted.slice(offset, offset + limit);
      const items = [];
      for (const row of slice) {
        const doc = readDoc(row[0]);
        if (doc) items.push({ ...doc, key: sortKey === 3 ? 0 : Number(row[sortKey]) || 0, rowid: 0 });
      }
      const more = sorted.length > offset + limit;
      return { items, next: more ? { offset: offset + limit } : null, total: sorted.length };
    },
    /** 提示词抽样：不把整库读进内存，随机取页面并优先少用过的。 */
    sample(scope, limit = 20) {
      const size = Math.max(1, Math.min(200, Number(limit) || 20));
      const pool = rows.filter((row) => row[1] === scope);
      const picked = [];
      for (let i = 0; i < size && pool.length; i += 1) {
        const index = Math.floor(Math.random() * pool.length);
        picked.push(pool.splice(index, 1)[0]);
      }
      return picked.map((row) => readDoc(row[0])).filter(Boolean);
    },
    /** 首次启动：把旧的 stickers.json 导入一次，然后改名留档。 */
    migrateFromJson(file) {
      if (!fs.existsSync(file)) return { imported: 0, migrated: false };
      let parsed;
      try {
        let text = fs.readFileSync(file, 'utf8');
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        parsed = JSON.parse(text);
      } catch { return { imported: 0, migrated: false }; }
      if (!Array.isArray(parsed)) return { imported: 0, migrated: false };
      const written = store.upsertMany(parsed);
      try { fs.renameSync(file, `${file}.migrated`); } catch { /* 改名失败下次再试 */ }
      return { imported: written, migrated: true };
    },
    /** 定期管理：清掉没有条目引用、且超过 keepMs 的原图。 */
    pruneOrphans(rootDir, keepMs = 7 * 24 * 3600 * 1000) {
      const known = new Set(rows.map((row) => row[6]).filter(Boolean));
      const root = path.join(rootDir, 'sticker-images');
      let names = [];
      try { names = fs.readdirSync(root); } catch { return { removed: 0 }; }
      const now = Date.now();
      let removed = 0;
      for (const name of names) {
        const match = /([a-f0-9]{64})/.exec(name);
        if (match && known.has(match[1])) continue;
        const full = path.join(root, name);
        try {
          const stat = fs.statSync(full);
          if (!stat.isFile() || now - stat.mtimeMs < keepMs) continue;
          fs.rmSync(full, { force: true });
          removed += 1;
        } catch { /* 单个失败继续 */ }
      }
      return { removed };
    },
    flush
  };

  store.migrateFromJson(path.join(dir, 'stickers.json'));
  flush();
  cached = store;
  return store;
}

export const STICKER_MEMORY_WINDOW = MEMORY_WINDOW;
