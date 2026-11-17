// 更新源（GitHub 仓库或发布清单）的读写。
// 随包附带的 release-source.json 是出厂值；用户在「设置 → 桌面端 → 更新与 GitHub」
// 里填的地址写到 data/release-source.json，优先级高于出厂值，卸载重装也不会丢。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGED_FILE = path.resolve(HERE, '../release-source.json');

export const UPDATE_SOURCE_FILE = 'release-source.json';

function httpsUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.length > 2048) throw Error('UPDATE_SOURCE_INVALID');
  let url;
  try { url = new URL(raw); } catch { throw Error('UPDATE_SOURCE_INVALID'); }
  if (url.protocol !== 'https:') throw Error('UPDATE_SOURCE_INVALID');
  if (url.username || url.password || url.hash) throw Error('UPDATE_SOURCE_INVALID');
  if (!url.hostname.includes('.') || url.hostname.endsWith('.localhost')) throw Error('UPDATE_SOURCE_INVALID');
  return url.href;
}

/** GitHub 仓库页会归一成 https://github.com/<owner>/<repo>；其余按发布清单处理。 */
export function normalizeUpdateSource(value) {
  const href = httpsUrl(value);
  if (!href) return { url: '', kind: '', label: '未配置' };
  const url = new URL(href);
  if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) throw Error('UPDATE_SOURCE_INVALID');
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, '');
    if (!/^[\w.-]{1,100}$/.test(owner) || !/^[\w.-]{1,100}$/.test(repo)) throw Error('UPDATE_SOURCE_INVALID');
    const clean = `https://github.com/${owner}/${repo}`;
    return { url: clean, kind: 'github', label: `${owner}/${repo}` };
  }
  return { url: url.href, kind: 'manifest', label: url.hostname };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 读当前生效的更新源。data 目录优先，其次随包出厂值。
 * 返回 { url, kind, label, origin: 'user'|'packaged'|'none' }。
 */
export function readUpdateSource({ dir = DATA_DIR } = {}) {
  const user = readJson(path.join(dir, UPDATE_SOURCE_FILE));
  const packaged = readJson(PACKAGED_FILE);
  const userRaw = user && (user.githubRepositoryUrl || user.manifestUrl);
  if (userRaw) {
    try {
      return { ...normalizeUpdateSource(userRaw), origin: 'user' };
    } catch { /* 用户文件坏了就回落到出厂值 */ }
  }
  const packagedRaw = packaged && (packaged.githubRepositoryUrl || packaged.manifestUrl);
  if (packagedRaw) {
    try {
      return { ...normalizeUpdateSource(packagedRaw), origin: 'packaged' };
    } catch { /* 出厂值不合法按未配置处理 */ }
  }
  return { url: '', kind: '', label: '未配置', origin: 'none' };
}

/** 保存用户填写的更新源；空字符串表示清掉用户值、回到出厂值。 */
export function writeUpdateSource(value, { dir = DATA_DIR } = {}) {
  const file = path.join(dir, UPDATE_SOURCE_FILE);
  const normalized = normalizeUpdateSource(value);
  if (!normalized.url) {
    try { fs.rmSync(file, { force: true }); } catch { /* 不存在就算了 */ }
    return readUpdateSource({ dir });
  }
  fs.mkdirSync(dir, { recursive: true });
  const body = normalized.kind === 'github'
    ? { githubRepositoryUrl: normalized.url }
    : { manifestUrl: normalized.url };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return readUpdateSource({ dir });
}
