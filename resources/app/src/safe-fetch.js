// 安全抓取层（完整移植自原版 safe-fetch + mcp-web-search-safe 的 SSRF 防护）。
//
// - 仅 http/https；禁止 URL 内嵌凭据；
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
// - 域名先做 DNS 解析并检查全部解析结果；解析后固定到已校验的 IP 发请求（防 DNS rebinding）；
// - 手动跟随重定向，每一跳重新校验；
// - 响应体限量读取，避免超大响应拖垮进程；
// - 大文件（视频）走 safeFetchBinaryToFile：边收边写盘，内存占用与文件大小无关。
//
// 例外开关：security.allowPrivateImageHosts = true 时，图片下载跳过内网检查
// （仅供本地测试/自建图床使用，默认关闭）。
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';
import { getConfig } from './config.js';
import { retryRead, waitForRead, httpReadError } from './network-read.js';

const dnsLookup = dns.promises.lookup;

// ── IP 判定 ─────────────────────────────────────────────────────────────

// 解析 IPv6 中内嵌的 IPv4（::ffff:a.b.c.d、::ffff:7f00:1 等）。
function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

export function isPrivateIp(ip) {
  const h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  const embedded = h.includes(':') ? parseEmbeddedIpv4(h) : null;
  if (embedded) return isPrivateIp(embedded);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }
  return false;
}

// ── 主机名校验（含 DNS） ────────────────────────────────────────────────

async function lookupWithTimeout(hostname) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS 解析超时')), 5000);
  });
  return Promise.race([dnsLookup(hostname, { all: true, verbatim: true }), timeout]).finally(() => clearTimeout(timer));
}

async function resolveSafeHost(hostname, { allowPrivate = false } = {}) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) throw new Error('主机名为空');
  if (!allowPrivate && (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local'))) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (!allowPrivate && isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await lookupWithTimeout(h);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  if (!allowPrivate) {
    for (const { address } of addresses) {
      if (isPrivateIp(address)) throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses[0].address;
}

/** 校验 URL 的 scheme 与主机（DNS 级）。返回 { url, ip }。 */
export async function validateFetchUrl(raw, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname, { allowPrivate });
  return { url, ip };
}

// ── 浏览锁定（browseLock）──────────────────────────────────────────────
//
// 作用：把"机器人能访问哪些域名"收成一个白名单，给用户一个硬边界
// （家长/老师/自用场景：只让它上这几个站）。
//
// ⚠️ 最关键的一点：白名单必须**逐跳校验**。
// 只看入口 URL 是不够的 —— 一个站内链接 302 到站外就绕过去了。
// 所以 safeFetch / safeFetchBinary 在**每一次重定向之后**都重新查一遍白名单，
// 而不是只在开始查一次。

/** 域名归一化：去协议/去路径/去端口/转小写，只留主机名。 */
export function normalizeDomain(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  try {
    // 带协议的写法直接解析
    const u = new URL(s.includes('://') ? s : `http://${s}`);
    return u.hostname.toLowerCase().replace(/^\.+|\.+$/g, '');
  } catch {
    return '';
  }
}

/** 读当前锁定配置（每次现读，保证改配置立即生效）。 */
export function browseLockState() {
  const lock = getConfig().security?.browseLock || {};
  const enabled = lock.enabled === true;
  const domains = (Array.isArray(lock.hosts) ? lock.hosts : [])
    .map(normalizeDomain)
    .filter(Boolean);
  return { enabled, domains, siteSearchUrl: String(lock.siteSearchUrl || '').trim() };
}

/**
 * 主机是否在白名单内。**支持子域**：白名单里有 `example.com` 时
 * `img.example.com` 也算通过 —— 否则一个图床的 CDN 域名就把正常使用挡死了。
 * 但反向不成立：白名单写 `img.example.com` 不会放行 `example.com`。
 */
export function hostAllowed(host, state = browseLockState()) {
  if (!state.enabled) return true;          // 没开锁定 = 不限制
  const h = String(host ?? '').toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!h) return false;
  if (!state.domains.length) return false;  // 开了锁定但没填域名 = 全部拒绝（比"全部放行"安全）
  return state.domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/** 锁定开启时校验一个 URL 的主机；未开启则直接通过。返回 { enabled, host, allowed }。 */
export function checkBrowseLock(rawUrl, state = browseLockState()) {
  if (!state.enabled) return { enabled: false, host: '', allowed: true };
  let host = '';
  try {
    host = new URL(String(rawUrl ?? '')).hostname.toLowerCase();
  } catch {
    return { enabled: true, host: '', allowed: false };
  }
  return { enabled: true, host, allowed: hostAllowed(host, state) };
}

// ── 受限请求 ────────────────────────────────────────────────────────────

function sliceByCodePoints(s, max) {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

function readBounded(res, maxBytes, asText, onProgress) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    const chunks = [];
    let total = 0;
    let text = '';
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };
    res.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (!asText && total > maxBytes) {
        finish(reject, new Error('响应超过大小上限')); res.destroy(); return;
      }
      if (chunk.length > 0) onProgress?.();
      if (asText) text += decoder.write(chunk);
      else chunks.push(chunk);
      // 只用字节数判断是否超限。原实现还额外判断了 text.length >= maxBytes，
      // 但 text.length 是字符数而 maxBytes 是字节数（UTF-8 下中文 1 字符 = 3 字节），
      // 单位不一致，会让刚好读满的响应被误标成 truncated。
      if (asText && total >= maxBytes) {
        try { res.destroy(); } catch { /* ignore */ }
        finish(resolve, asText ? sliceByCodePoints(text, maxBytes) : Buffer.concat(chunks).subarray(0, maxBytes));
      }
    });
    res.on('end', () => {
      if (!settled) {
        if (asText) {
          text += decoder.end();
          finish(resolve, sliceByCodePoints(text, maxBytes));
        } else {
          finish(resolve, Buffer.concat(chunks));
        }
      }
    });
    res.on('error', (err) => finish(reject, err));
    res.on('aborted', () => finish(reject, Object.assign(new Error('响应意外中断'), { code: 'ECONNRESET' })));
    res.on('close', () => { if (!settled && !res.complete) finish(reject, Object.assign(new Error('响应未读完'), { code: 'ECONNRESET' })); });
  });
}

async function writeBounded(res, destination, maxBytes, signal, onProgress) {
  let bytes = 0;
  const countBytes = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes >= maxBytes) {
        callback(new Error(`文件达到大小上限（${maxBytes} 字节），已中止`));
        return;
      }
      if (chunk.length > 0) onProgress?.();
      callback(null, chunk);
    }
  });
  await pipeline(res, countBytes, fs.createWriteStream(destination), { signal });
  if (!res.complete) throw Object.assign(new Error('响应未读完'), { code: 'ECONNRESET' });
  if (!bytes) throw new Error('下载内容为空');
  return bytes;
}

// 使用已校验的 IP 发起请求（保留 Host/SNI），从根上消除 DNS rebinding。
function requestOnce(url, ip, {
  asBinary = false, maxBytes = 50000, signal, acceptGzip = false, onProgress, destination
} = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    let writing = false;
    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) qq-agent/1.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8,image/avif,image/webp,image/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
        ...(acceptGzip && { 'accept-encoding': 'gzip' })
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      signal,
      timeout: destination ? 0 : 20000
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        resolve({ statusCode, redirect: String(res.headers.location || '') });
        res.destroy();
        return;
      }
      if (statusCode < 200 || statusCode >= 300 || (destination && statusCode !== 200)) {
        resolve({ statusCode, retryAfter: res.headers['retry-after'] }); res.destroy(); return;
      }
      const contentType = String(res.headers['content-type'] || '');
      if (destination) {
        writing = true;
        writeBounded(res, destination, maxBytes, signal, onProgress)
          .then(bytes => resolve({ statusCode, bytes, contentType }), reject);
        return;
      }
      if (!asBinary && !/^(?:text\/|application\/(?:json|[\w.+-]*xml|javascript))/i.test(contentType)) {
        reject(new Error('网页响应不是可读取的文本类型')); res.destroy(); return;
      }
      readBounded(res, maxBytes, !asBinary, onProgress)
        .then((body) => resolve({ statusCode, body, contentType,
          contentEncoding: String(res.headers['content-encoding'] || '').toLowerCase() }))
        .catch(reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' })));
    req.on('error', error => { if (!writing) reject(error); });
    req.end();
  });
}

const MAX_REDIRECTS = 5;

/** 抓取网页文本（≤50000 字符），SSRF 全防护（不做内网例外）。 */
export async function safeFetch(urlString, { timeoutMs = 20000, signal, ...options } = {}) {
  return retryRead((current, onProgress) => safeFetchOnce(urlString, { ...options, signal: current, onProgress }), { signal, timeoutMs, label: '网页读取' });
}
async function safeFetchOnce(urlString, { browseLocked = false, signal, onProgress } = {}) {
  // 锁定校验放在**最前面**，连 DNS 都不做 —— 不在白名单就根本不该发起连接
  const lock = browseLocked ? checkBrowseLock(urlString) : { enabled: false, allowed: true, host: '' };
  if (!lock.allowed) throw new Error(`浏览锁定：${lock.host || '该地址'} 不在允许的域名清单内`);
  let { url, ip } = await waitForRead(validateFetchUrl(urlString), signal);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    signal.throwIfAborted();
    if (browseLocked && !checkBrowseLock(url.href).allowed) throw new Error('浏览锁定：当前地址已不在允许清单中');
    const result = await requestOnce(url, ip, { asBinary: false, maxBytes: 50000, signal, onProgress });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      // ⚠️ 逐跳校验：重定向目标也要在白名单里。
      // 只在入口校验的话，一个站内链接 302 到站外就绕过了锁定。
      if (browseLocked) {
        const nl = checkBrowseLock(next);
        if (!nl.allowed) throw new Error(`浏览锁定：重定向目标 ${nl.host || '未知'} 不在允许的域名清单内`);
      }
      ({ url, ip } = await waitForRead(validateFetchUrl(next), signal));
      continue;
    }
    const body = result.body || '';
    if (result.statusCode < 200 || result.statusCode >= 300) throw httpReadError(result.statusCode, result.retryAfter);
    return { url: url.toString(), statusCode: result.statusCode, truncated: body.length >= 50000, body };
  }
  throw new Error('重定向次数过多，已停止');
}

/** 下载二进制（图片，≤maxBytes 字节），返回 { buffer, contentType }。 */
export async function safeFetchBinary(urlString, maxBytes = 12 * 1024 * 1024, {
  timeoutMs = 20000, signal, ...options
} = {}) {
  return retryRead((current, onProgress) => safeFetchBinaryOnce(urlString, maxBytes, { ...options, signal: current, onProgress }), { signal, timeoutMs, label: '媒体下载' });
}
async function safeFetchBinaryOnce(urlString, maxBytes, {
  browseLocked = false, publicOnly = false, httpsOnly = false, timeoutMs, maxRedirects = MAX_REDIRECTS,
  signal: cancellation, acceptGzip = false, onProgress
} = {}, destination) {
  const lock = browseLocked ? checkBrowseLock(urlString) : { enabled: false, allowed: true, host: '' };
  if (!lock.allowed) throw new Error(`浏览锁定：${lock.host || '该地址'} 不在允许的域名清单内`);
  const allowPrivate = !publicOnly && getConfig().security?.allowPrivateImageHosts === true;
  const timeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  const signal = timeout && cancellation ? AbortSignal.any([timeout, cancellation]) : timeout || cancellation;
  signal?.throwIfAborted();
  let { url, ip } = await waitForRead(validateFetchUrl(urlString, { allowPrivate }), signal);
  for (let i = 0; i <= maxRedirects; i++) {
    signal?.throwIfAborted();
    if (browseLocked && !checkBrowseLock(url.href).allowed) throw new Error('浏览锁定：当前地址已不在允许清单中');
    if (httpsOnly && url.protocol !== 'https:') throw new Error('媒体地址必须使用 HTTPS');
    const result = await requestOnce(url, ip, { asBinary: true, maxBytes, signal, acceptGzip, onProgress, destination });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (i === maxRedirects) break;
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      // 逐跳校验（同 safeFetch）：重定向目标也必须在白名单内
      if (browseLocked) {
        const nl = checkBrowseLock(next);
        if (!nl.allowed) throw new Error(`浏览锁定：重定向目标 ${nl.host || '未知'} 不在允许的域名清单内`);
      }
      ({ url, ip } = await waitForRead(validateFetchUrl(next, { allowPrivate }), signal));
      continue;
    }
    if (result.statusCode !== 200) throw httpReadError(result.statusCode, result.retryAfter);
    if (destination) return { bytes: result.bytes, contentType: result.contentType };
    if (acceptGzip && result.contentEncoding === 'gzip') {
      if (result.body.length >= maxBytes) throw new Error('压缩响应超过大小上限');
      return { buffer: gunzipSync(result.body, { maxOutputLength: maxBytes }), contentType: result.contentType };
    }
    return { buffer: result.body, contentType: result.contentType };
  }
  throw new Error('重定向次数过多，已停止');
}

/**
 * 流式写入同一文件系统的临时文件，完整读完后原子替换目标。
 * 达到字节上限即中止，失败清理临时文件。timeoutMs 包含所有读取和重试。
 * attemptMs 是一次连接或读取的无进展时限。
 */
export async function safeFetchBinaryToFile(urlString, destPath, maxBytes, {
  timeoutMs = 30000, attemptMs = 8000, browseLocked = false, signal
} = {}) {
  const dest = String(destPath || '');
  if (!dest) throw new Error('缺少目标文件路径');
  signal?.throwIfAborted();
  const limit = Math.max(1, Number(maxBytes) || 1);
  const parent = path.dirname(dest);
  await fs.promises.mkdir(parent, { recursive: true });
  const stage = await fs.promises.mkdtemp(path.join(parent, '.download-'));
  const temporary = path.join(stage, 'body');
  let pending;
  try {
    const result = await retryRead(async (current, onProgress) => {
      // An aborted attempt can still be closing its file on Windows.
      if (pending) await waitForRead(pending.catch(() => {}), current);
      current.throwIfAborted();
      pending = safeFetchBinaryOnce(urlString, limit, { browseLocked, signal: current, onProgress }, temporary);
      return pending;
    }, { timeoutMs, attemptMs, signal, label: '媒体下载' });
    signal?.throwIfAborted();
    await fs.promises.rename(temporary, dest);
    return result;
  } finally {
    await pending?.catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
    await fs.promises.rmdir(stage).catch(() => {});
  }
}

/**
 * 图片地址校验（供 send_sticker / 图片下载使用）。
 * 默认内网地址一律拒绝；security.allowPrivateImageHosts=true 时放行（仅本地测试/自建图床）。
 */
export async function validateImageUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('图片地址不合法');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http(s) 图片地址');
  if (getConfig().security?.allowPrivateImageHosts === true) return url.toString();
  const { url: safeUrl } = await validateFetchUrl(url.toString());
  return safeUrl.toString();
}
