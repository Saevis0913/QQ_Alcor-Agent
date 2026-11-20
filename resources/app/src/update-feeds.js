// 更新清单（update/manifest.json）的多源获取。
//
// 现实问题：GitHub API 在某些网络下会超时、被墙、被限流，结果就是「明明联网了却拿不到更新」。
// 这里同时打多条通路（自建/自定义清单 → raw.githubusercontent.com → jsDelivr → GitHub Pages），
// 谁先返回用谁；全部失败才算失败，交给上层回落 GitHub Releases API 或 AI 修复。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';
import { safeFetchBinary } from './safe-fetch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGED_FILE = path.resolve(HERE, '../release-source.json');

const MAX_MANIFEST_BYTES = 262144;
const SOURCE_TIMEOUT_MS = 6000;
const DEFAULT_REPO = 'Saevis0913/QQ_Alcor-Agent';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function httpsOnly(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:') throw Error('UPDATE_MANIFEST_INVALID');
  if (url.username || url.password) throw Error('UPDATE_MANIFEST_INVALID');
  return url.href;
}

/** 从 GitHub 仓库地址里取 owner/name；取不到就用出厂仓库。 */
function repoSegments(source) {
  try {
    const url = new URL(source);
    if (url.hostname === 'github.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return { owner: parts[0], name: parts[1].replace(/\.git$/i, '') };
    }
  } catch { /* 用默认仓库 */ }
  const [owner, name] = DEFAULT_REPO.split('/');
  return { owner, name };
}

/**
 * 所有可用的清单地址，按「快 → 稳」排序。
 * 用户填了自定义清单就放第一位，仍然保留公共镜像做兜底。
 */
export function manifestSources({ dir = DATA_DIR } = {}) {
  const user = readJson(path.join(dir, 'release-source.json'));
  const packaged = readJson(PACKAGED_FILE);
  const merged = { ...(packaged || {}), ...(user || {}) };
  const custom = String(merged.manifestUrl || '').trim();
  const repoSource = String(merged.githubRepositoryUrl || '').trim() || 'https://github.com/' + DEFAULT_REPO;
  const { owner, name } = repoSegments(repoSource);
  const out = [];
  const push = (url) => { if (url && !out.includes(url)) out.push(url); };
  if (custom) { try { push(httpsOnly(custom)); } catch { /* 配置坏了就跳过 */ } }
  const rawMain = `https://raw.githubusercontent.com/${owner}/${name}/main/update/manifest.json`;
  push(rawMain);
  push(`https://cdn.jsdelivr.net/gh/${owner}/${name}@main/update/manifest.json`);
  push(`https://fastly.jsdelivr.net/gh/${owner}/${name}@main/update/manifest.json`);
  push(`https://cdn.statically.io/gh/${owner}/${name}/main/update/manifest.json`);
  push(`https://raw.gitmirror.com/${owner}/${name}/main/update/manifest.json`);
  push(`https://gh-proxy.com/${rawMain}`);
  push(`https://ghfast.top/${rawMain}`);
  push(`https://raw.githubusercontent.com/${owner}/${name}/master/update/manifest.json`);
  push(`https://${owner.toLowerCase()}.github.io/${name}/update/manifest.json`);
  return out;
}

/** 校验并归一化清单；字段缺失就判无效，不做「猜」的兼容。 */
export function normalizeManifest(raw, sourceUrl) {
  if (!raw || typeof raw !== 'object') throw Error('UPDATE_MANIFEST_INVALID');
  const latest = String(raw.latest || raw.version || '').trim();
  if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(latest)) throw Error('UPDATE_MANIFEST_INVALID');
  const full = raw.full && typeof raw.full === 'object' ? raw.full : {};
  const rawUrls = [].concat(full.urls || full.url || raw.url || [], full.mirrors || []).filter(Boolean);
  const urls = rawUrls.map(httpsOnly);
  if (!urls.length) throw Error('UPDATE_MANIFEST_INVALID');
  const sha256 = String(full.sha256 || raw.sha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw Error('UPDATE_MANIFEST_INVALID');
  const bytes = Number(full.bytes || raw.bytes || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) throw Error('UPDATE_MANIFEST_INVALID');
  const notes = raw.notes == null ? '' : String(raw.notes).slice(0, 16000);
  const applyMode = raw.applyMode === 'hot' ? 'hot' : 'restart';
  const fileName = String(full.fileName || raw.fileName || '').trim() ||
    (() => { try { return decodeURIComponent(new URL(urls[0]).pathname.split('/').pop() || ''); } catch { return ''; } })();
  if (!/^[A-Za-z0-9._-]{1,120}\.exe$/.test(fileName)) throw Error('UPDATE_MANIFEST_INVALID');
  return {
    product: 'Alcor Agent',
    latest: latest.replace(/^v/, ''),
    minSupported: String(raw.minSupported || '').replace(/^v/, ''),
    rollout: Number.isFinite(Number(raw.rollout)) ? Math.max(0, Math.min(100, Number(raw.rollout))) : 100,
    applyMode,
    notes,
    publishedAt: raw.publishedAt ? String(raw.publishedAt) : null,
    urls,
    fileName,
    bytes,
    sha256,
    source: sourceUrl || ''
  };
}

/**
 * 同时请求所有清单地址，收集有响应的，再挑「版本最高」的那份。
 *
 * 为什么要挑最高版本而不是「谁先返回」：jsDelivr / statically 这类 CDN 会缓存分支文件，
 * 快是快，但可能还在发上一个版本；谁先返回就用谁，等于让缓存把新版本盖掉。
 * 所以先拿第一份响应当信号，再给其它源一个宽限窗口（默认 2.5s），窗口内谁的 latest 更高用谁。
 */
const GRACE_MS = 2500;

function gather(tasks, graceMs) {
  return new Promise((resolve) => {
    const settlements = [];
    let pending = tasks.length;
    let graceTimer = null;
    let settled = false;
    const finish = () => { if (!settled) { settled = true; if (graceTimer) clearTimeout(graceTimer); resolve(settlements); } };
    if (!pending) return finish();
    for (const task of tasks) {
      task.then((value) => settlements.push({ ok: true, value }), (error) => settlements.push({ ok: false, error })).finally(() => {
        pending -= 1;
        if (pending === 0) return finish();
        if (settlements.some((item) => item.ok) && !graceTimer) graceTimer = setTimeout(finish, graceMs);
      });
    }
  });
}

/** 限制同时进行的请求数：全局读取并发上限是 4，9 个源一起打会有 5 个直接被判「读取任务繁忙」。 */
function limitConcurrency(task, max) {
  let active = 0;
  const queue = [];
  return (...args) => new Promise((resolve, reject) => {
    const run = () => {
      active += 1;
      task(...args).then(resolve, reject).finally(() => {
        active -= 1;
        const next = queue.shift();
        if (next) next();
      });
    };
    if (active < max) run();
    else queue.push(run);
  });
}

function newestOf(settlements) {
  let best = null;
  for (const item of settlements) {
    if (!item.ok) continue;
    if (!best || compareVersion(item.value.latest, best.latest) > 0) best = item.value;
  }
  return best;
}

export async function fetchManifest({ dir = DATA_DIR, timeoutMs = SOURCE_TIMEOUT_MS } = {}) {
  const sources = manifestSources({ dir });
  if (!sources.length) throw Object.assign(Error('UPDATE_SOURCE_NOT_CONFIGURED'), { code: 'UPDATE_SOURCE_NOT_CONFIGURED' });
  const errors = [];
  const round = async (source, budget) => {
    try {
      const { buffer } = await safeFetchBinary(source, MAX_MANIFEST_BYTES, {
        httpsOnly: true, publicOnly: true, timeoutMs: budget, maxRedirects: 3
      });
      if (!buffer?.length) throw Error('UPDATE_MANIFEST_INVALID');
      return normalizeManifest(JSON.parse(buffer.toString('utf8')), source);
    } catch (error) {
      errors.push(`${new URL(source).hostname}: ${error?.code || error?.message || error}`);
      throw error;
    }
  };
  // 两轮：第一轮限时收集；全挂时再给慢源一次机会（弱网下第一次常常只是握手慢）。
  for (let pass = 0; pass < 2; pass++) {
    const budget = pass === 0 ? timeoutMs : timeoutMs * 2;
    const limited = limitConcurrency((source) => round(source, budget), 4);
    const settlements = await gather(sources.map((source) => limited(source)), GRACE_MS);
    const best = newestOf(settlements);
    if (best) return best;
    if (pass === 0) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw Object.assign(Error('UPDATE_ALL_SOURCES_FAILED'), {
    code: 'UPDATE_ALL_SOURCES_FAILED',
    detail: errors.slice(0, 6).join(' | ')
  });
}

/** 语义化版本比较：a>b 返回 1，相等 0，小于 -1。 */
export function compareVersion(a, b) {
  const parse = (value) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value || ''));
    if (!match) return null;
    return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] };
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] > right.numbers[i] ? 1 : -1;
  }
  if (!left.pre.length && right.pre.length) return 1;
  if (left.pre.length && !right.pre.length) return -1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === r) continue;
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) return Number(l) > Number(r) ? 1 : -1;
    if (ln !== rn) return ln ? -1 : 1;
    return l > r ? 1 : -1;
  }
  return 0;
}

/** 只比较主次版本：用于判断「这是不是个小版本（补丁级）更新」。 */
export function isPatchUpdate(latest, current) {
  const parse = (value) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value || ''));
    return match ? match.slice(1, 4).map(Number) : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1];
}
