// 表情包体系（移植自原版 sticker-lib.js）：本地表情知识库 + 搜索 + 提示词摘要。
// QQ 收藏表情（Alcor fetch_custom_face_detail）是"源"，本地库是 AI 认知层。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { stickerTier } from './sticker-policy.js';

export const STICKER_FILE = path.join(DATA_DIR, 'stickers.json');

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeStickerEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id = String(entry.id || entry.emoji_id || entry.resId || '').trim();
  if (!id) return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 20)
    : [];
  return {
    id,
    resId: String(entry.resId || entry.emoji_id || id).trim(),
    // QQ 原生收藏身份（add_custom_face 的 emoji_id）：入了 QQ 收藏的条目靠它
    // 做幂等补录、备注回写（modify_custom_face）与长效地址回查。
    emojiId: String(entry.emojiId || '').trim(),
    // 消息里的协议端缓存文件 id：转存失败后的重试线索（get_image 认它）。
    qqFile: String(entry.qqFile || '').trim(),
    ...(typeof entry.contentHash === 'string' && /^[a-f0-9]{64}$/.test(entry.contentHash)
      ? { contentHash: entry.contentHash } : {}),
    ...(entry.reviewVersion === 1 ? { reviewVersion: 1 } : {}),
    // 本地转存产物（file:///）。搬家自愈后由 healLocalPaths 重写。
    localFile: String(entry.localFile || '').trim(),
    // 本地转存失败标记：提示这条目当前靠 url 存活（QQ 图床 rkey ~1h，僵尸预警）。
    persistFailed: entry.persistFailed === true,
    url: String(entry.url || '').trim(),
    md5: String(entry.md5 || '').trim().toUpperCase(),
    desc: String(entry.desc ?? '').trim(),
    localNote: String(entry.localNote ?? '').trim(),
    tags,
    usage: String(entry.usage ?? '').trim(),
    source: entry.source === 'manual' ? 'manual' : (entry.source === 'ai' ? 'ai' : 'qq'),
    useCount: Math.max(0, Number(entry.useCount) || 0),
    lastUsedAt: Number(entry.lastUsedAt) || 0,
    lastContext: String(entry.lastContext ?? '').slice(0, 200),
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso())
  };
}

let activeStore = null;

/** 接上 SQLite 索引：之后的读写都走它，JSON 只在首次迁移时读一次。 */
export function useStickerStore(store) {
  activeStore = store || null;
}

export function getStickerStore() {
  return activeStore;
}

export function loadStickerStore(file = STICKER_FILE) {
  if (activeStore) return activeStore.recentAll();
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStickerEntry).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveStickerStore(entries, file = STICKER_FILE) {
  if (activeStore) {
    activeStore.upsertMany(entries);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function mergeStickerLibrary(existing, fetched) {
  const out = existing.map(normalizeStickerEntry).filter(Boolean);
  const byId = new Map(out.map((e) => [e.id, e]));
  const fetchedIds = new Set();
  for (const item of Array.isArray(fetched) ? fetched : []) {
    const id = String(item?.emoji_id || item?.resId || item?.id || '').trim();
    if (id) fetchedIds.add(id);
  }
  for (const item of Array.isArray(fetched) ? fetched : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.emoji_id || item.resId || item.id || '').trim();
    if (!id) continue;
    const old = byId.get(id);
    const merged = normalizeStickerEntry({
      ...(old || {}),
      id,
      resId: String(item.resId || item.emoji_id || id).trim(),
      url: String(item.url || old?.url || '').trim(),
      md5: String(item.md5 || old?.md5 || '').trim().toUpperCase(),
      desc: String(item.desc ?? old?.desc ?? '').trim(),
      localNote: old?.localNote || '',
      tags: old?.tags || [],
      usage: old?.usage || '',
      source: old?.source || 'qq',
      useCount: old?.useCount || 0,
      lastUsedAt: old?.lastUsedAt || 0,
      lastContext: old?.lastContext || '',
      createdAt: old?.createdAt || nowIso(),
      updatedAt: nowIso()
    });
    if (!merged) continue;
    if (!byId.has(id)) {
      out.push(merged);
      byId.set(id, merged);
    } else {
      const idx = out.findIndex((e) => e.id === id);
      if (idx >= 0) out[idx] = merged;
    }
  }
  return out.filter((e) => e.source !== 'qq' || fetchedIds.has(e.id));
}

export function findSticker(entries, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const md5 = raw.toUpperCase();
  const urlNormalized = raw.replace(/\/+$/, '').replace(/^https?:\/\//i, '');
  return (Array.isArray(entries) ? entries : []).find((e) => {
    if (!e) return false;
    if (e.id === raw || e.resId === raw) return true;
    if (e.md5 && e.md5 === md5) return true;
    const eUrl = String(e.url || '').replace(/\/+$/, '').replace(/^https?:\/\//i, '');
    if (eUrl && urlNormalized && (eUrl === urlNormalized || eUrl.includes(urlNormalized) || urlNormalized.includes(eUrl))) return true;
    return false;
  }) || null;
}

export function formatStickerList(entries, query = '', limit = 48) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const q = String(query ?? '').trim().toLowerCase();
  const filtered = q
    ? list.filter((e) => {
        const haystack = [e.desc, e.localNote, e.usage, e.id, e.resId, e.md5, ...(e.tags || [])].join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : list;
  const max = Math.max(1, Math.min(500, Number(limit) || 48));
  const items = filtered.slice(0, max).map((e) => ({
    id: e.id,
    desc: e.desc || '',
    localNote: e.localNote || '',
    tags: e.tags || [],
    useCount: e.useCount || 0
  }));
  return { total: list.length, matched: filtered.length, truncated: filtered.length > max, stickers: items };
}

/**
 * 提示词里的【可用表情包】摘要（不暴露完整 URL，控制上下文体积）。
 * rotatePeriodMin <= 0 时关闭轮换；now 仅用于测试注入稳定的轮次。
 * 只列审核通过且有标签的候选，每条都附可直接选择的 ID。
 */
export function buildStickerContext(entries, max = 20, { rotatePeriodMin = 60, now = Date.now() } = {}) {
  const unique = new Map();
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = normalizeStickerEntry(raw);
    if (entry?.reviewVersion === 1 && entry.tags.length && !unique.has(entry.id)) unique.set(entry.id, entry);
  }
  const list = [...unique.values()];
  if (!list.length) return '';
  const total = Math.max(1, Math.min(20, Number(max) || 20));
  const byUse = [...list].sort((a, b) =>
    (b.useCount || 0) - (a.useCount || 0)
    || ((b.desc || b.localNote) ? 1 : 0) - ((a.desc || a.localNote) ? 1 : 0)
    || String(a.id).localeCompare(String(b.id))
  );
  let selected = byUse.slice(0, total);

  if (Number(rotatePeriodMin) > 0 && list.length > total) {
    const stableCount = Math.max(1, Math.floor(total / 2));
    const stable = byUse.slice(0, stableCount);
    const stableIds = new Set(stable.map((e) => e.id));
    const pool = [...list].filter((e) => !stableIds.has(e.id)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const period = Number(rotatePeriodMin) * 60000;
    const round = Math.floor(Number(now) / period);
    // 按轮次播种的 Fisher-Yates：同一轮次结果稳定，既利于缓存命中也便于测试断言。
    // seed=0 时 xorshift 恒输出 0（j 恒为 0，洗牌失效）——用黄金比例常数兜底。
    let seed = round >>> 0;
    for (const e of pool) for (const ch of e.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    if (seed === 0) seed = 0x9e3779b9;
    const shuffled = [...pool];
    for (let i = shuffled.length - 1; i > 0; i--) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
      const j = seed % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    selected = [...stable, ...shuffled.slice(0, total - stableCount)];
  }

  const lines = selected.map((e) => {
    const label = e.desc || e.localNote || e.usage || '按标签选择';
    const extra = e.tags?.length ? ` [${e.tags.join('/')}]` : '';
    // 不展示使用次数：真实计数每发一次表情就 +1，写进提示词会让【可用表情包】
    // 段每次运行都变（把它后面的全部段落挤出缓存前缀）。模型只需要知道
    // "有哪些表情"（useCount 仍参与排序与轮换挑选，只是不进文本）。
    const id = ` id=${e.id}`;
    return `- ${label}${extra}${id}`;
  });
  return `【可用表情包】你的 QQ 收藏表情里有 ${list.length} 个表情（以下为常用/轮换的 ${selected.length} 个，完整列表可用 list_stickers 查询）：\n${lines.join('\n')}`;
}

/** 发送前的表情策略提示；发送队列仍负责最终校验。 */
export function buildStickerStrategyHint(level = 2) {
  const tier = stickerTier({ sendTier: level });
  return [
    '【表情包策略】' + tier.tier + ' ' + tier.label,
    '- 任何成员明确请求发送时可获本轮许可。主动配图概率为 ' + Math.round(tier.probability * 100) + '%，发送后最近十条机器人消息最多 ' + tier.cap + ' 张表情。',
    '- 原生表情和梗鲸共用许可，以【本轮表情许可】为准；不要换工具或重试绕过。',
    '- 用已审核的候选标签和 ID 选择贴合语境的表情，标签明确时无需再次看图。',
    '- 表情独立气泡发送，严肃、正式、敏感话题不要硬塞。'
  ].join('\n');
}

export function applyStickerNote(entries, id, patch = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    localNote: patch.localNote !== undefined
      ? String(patch.localNote ?? '').trim()
      : (patch.note !== undefined ? String(patch.note ?? '').trim() : target.localNote),
    desc: patch.desc !== undefined ? String(patch.desc ?? '').slice(0, 60) : target.desc,
    tags: Array.isArray(patch.tags) ? patch.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : target.tags,
    usage: patch.usage !== undefined ? String(patch.usage ?? '').trim() : target.usage,
    source: patch.source || target.source || 'ai',
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}

export function markStickerUsed(entries, id, context = '') {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    useCount: (target.useCount || 0) + 1,
    lastUsedAt: Date.now(),
    lastContext: String(context || '').slice(0, 200),
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}
