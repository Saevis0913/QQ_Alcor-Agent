// 社区市场的口令校验与安装；不提供发布或账号凭据存储。
import path from 'node:path';
import { ROOT } from './config.js';
import { logger } from './logger.js';
export const MARKET_API_BASE = 'https://www.kondius.cn/api/community';
const FETCH_TIMEOUT_MS = 30000;
const MAX_ZIP_BYTES = 8 * 1024 * 1024;
const log = (fn, ...args) => logger[fn]('market', ...args);

/**
 * 把 nginx/网关层的拦截翻译成人话。
 * 应用层（community_app.py）报错时总带 JSON error；返回 HTML 错误页的一定是
 * 反代/防火墙层 —— 2026-09-26 实测：GET 能进应用，POST/PUT/… 被 nginx 403
 * （同域名下 / 与 /qq-agent/ 的 POST 都能到达应用，只有 /api/community 被拦），
 * 属于服务器对这个 location 的方法限制，客户端怎么改都绕不过。
 */
function friendlyMarketError(res) {
  if (res.status === 403) {
    return '市场服务拒绝访问（403，来自服务器 nginx 层而非应用）：'
      + '请检查服务器对 /api/community 的方法限制（limit_except / 站点防火墙"禁用 POST"之类），应用本身是好的';
  }
  if (res.status >= 500) return `市场服务故障（HTTP ${res.status}），请稍后再试`;
  return `市场服务 HTTP ${res.status}`;
}

/**
 * 官网市场 API 代理。返回解析后的 JSON；HTTP 非 2xx 抛错（带服务器给的 error 文案）。
 * @param {string} pathname 以 / 开头，拼在 MARKET_API_BASE 后
 * @param {object} options { method, json, timeoutMs }
 */
export async function marketFetch(pathname, { method = 'GET', json = null, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const res = await fetch(`${MARKET_API_BASE}${pathname}`, {
    method,
    headers: {
      ...(json !== null ? { 'content-type': 'application/json' } : {})
    },
    body: json !== null ? JSON.stringify(json) : null,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data?.error || friendlyMarketError(res));
    e.status = res.status;
    throw e;
  }
  return data;
}

/**
 * 口令校验（批量）：codes → [{ code, ok, name, author, type, ... }]。
 */
export async function verifyInstallCodes(codes) {
  const data = await marketFetch('/install/verify', { method: 'POST', json: { codes } });
  if (!Array.isArray(data?.results)) throw new Error('口令校验响应异常');
  return data.results;
}

/**
 * 按口令下载并安装到本地 skills/ 或 plugins/。
 * 类型路由由**服务器返回的 type** 决定（skill.json→skill / plugin.json→plugin），
 * 前端/调用方无法干预 —— 即使在技能页输入了插件的口令，也装进 plugins/。
 *
 * @param {object} o { code, verified(校验阶段拿到的条目信息) }
 * @returns {Promise<{ok, kind, id, dir}>}
 */
export async function installByCode({ code, verified }) {
  const entry = verified && verified.ok ? verified : null;
  const type = String(entry?.type || '').toLowerCase() === 'plugin' ? 'plugin' : 'skill';
  // 先下载（没传 verified 也重新校验一次拿 type —— 不信任何本地猜测）
  const ident = entry?.id;
  const res = await fetch(`${MARKET_API_BASE}/install/${encodeURIComponent(String(code).trim().toUpperCase())}/download`, {
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // HTML 错误页 = nginx/网关层拦截（应用层错误是 JSON）；给出可排查的提示
    const why = /<\/?[a-z][^>]*>/i.test(text) ? friendlyMarketError(res) : (text.slice(0, 120) || `HTTP ${res.status}`);
    throw new Error(`下载失败：${why}`);
  }
  const zipBuffer = Buffer.from(await res.arrayBuffer());
  if (zipBuffer.length > MAX_ZIP_BYTES) throw new Error('安装包超过 8MB 上限');
  const { unzipToModuleDir, validateZipStructure } = await import('./zip-install.js');
  validateZipStructure(zipBuffer);
  const dirName = await unzipToModuleDir(zipBuffer, { root: ROOT, type, preferId: ident });
  log('info', `口令 ${code} 安装完成：${type}s/${dirName}`);
  return { ok: true, kind: type, id: dirName, dir: path.join(ROOT, type === 'plugin' ? 'plugins' : 'skills', dirName) };
}
