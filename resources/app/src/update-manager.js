// 自动更新：检查 → 下载 → 校验 → 安装。
// 只在用户点了「检查更新 / 立即更新」时联网；启动时做一次静默检查。
// 下载优先用系统 curl（Node 的 retryRead 有 60s 硬上限，装不下 314 MB 安装包），
// 校验用同仓库同版本的 SHA256SUMS.txt 对比，不一致就删掉、不启动安装器。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './config.js';
import { checkReleaseUpdate } from './release-update.js';

const UPDATE_DIR = path.join(DATA_DIR, 'updates');
const MAX_INSTALLER_BYTES = 520 * 1024 * 1024;
const START_DELAY_MS = 8_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 20 * 60 * 1000;

let state = {
  checkedAt: null,
  ok: false,
  code: '',
  current: '',
  latest: '',
  hasUpdate: false,
  notes: '',
  publishedAt: null,
  projectUrl: '',
  phase: 'idle',        // idle | downloading | ready | installing | error
  progress: 0,          // 0..1
  readyPath: '',
  error: ''
};
let checkTimer = null;
let bootTimer = null;

export function updateState() {
  return { ...state };
}

function sumFileUrl(assetUrl) {
  const url = new URL(assetUrl);
  const parts = url.pathname.split('/');
  parts[parts.length - 1] = 'SHA256SUMS.txt';
  url.pathname = parts.join('/');
  return url.toString();
}

export 
const DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com'
]);

let curlChecked = null;

/** 系统自带 curl（Windows 10 1803+ / Server 2019+）在大文件上比 Node TLS 稳，优先用它。 */
async function findCurl() {
  if (curlChecked !== null) return curlChecked;
  const candidates = [
    'C:\\Windows\\System32\\curl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\curl.exe'
  ];
  for (const candidate of candidates) {
    try { await fs.promises.access(candidate, fs.constants.X_OK); curlChecked = candidate; return candidate; } catch { /* 下一个 */ }
  }
  curlChecked = '';
  return curlChecked;
}

async function sha256OfFile(file) {
  const digest = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', (chunk) => digest.update(chunk)).on('error', reject).on('end', resolve);
  });
  return digest.digest('hex');
}

function curlDownload(curl, url, destPath, { maxBytes, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-L', '--fail', '--silent', '--show-error',
      '--retry', '5', '--retry-delay', '2', '--retry-all-errors',
      '--connect-timeout', '20',
      '--max-time', String(Math.max(60, Math.round(timeoutMs / 1000))),
      '-o', destPath, url
    ];
    const child = spawn(curl, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, timeoutMs + 30000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        await fs.promises.unlink(destPath).catch(() => {});
        reject(Object.assign(Error('UPDATE_DOWNLOAD_FAILED'), { code: 'UPDATE_DOWNLOAD_FAILED', status: code, detail: stderr.trim().slice(0, 300) }));
        return;
      }
      try {
        const bytes = (await fs.promises.stat(destPath)).size;
        if (bytes > maxBytes) {
          await fs.promises.unlink(destPath).catch(() => {});
          reject(Object.assign(Error('UPDATE_TOO_LARGE'), { code: 'UPDATE_TOO_LARGE' }));
          return;
        }
        resolve({ bytes, sha256: await sha256OfFile(destPath), url });
      } catch (error) { reject(error); }
    });
  });
}

/**
 * 下载一个 https 资源到磁盘：优先系统 curl（能续传、抗 RST），失败再退回 Node https。
 * GitHub release 会 302 到 objects.githubusercontent.com，只允许这几个白名单主机。
 */
export async function downloadToFile(urlString, destPath, { maxBytes = MAX_INSTALLER_BYTES, timeoutMs = 30 * 60 * 1000, onProgress } = {}) {
  const target = new URL(urlString);
  if (target.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(target.hostname)) {
    throw Object.assign(Error('UPDATE_HOST_NOT_ALLOWED'), { code: 'UPDATE_HOST_NOT_ALLOWED' });
  }
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const curl = await findCurl();
  if (curl) {
    if (typeof onProgress === 'function') onProgress(0);
    const result = await curlDownload(curl, target.toString(), destPath, { maxBytes, timeoutMs });
    if (typeof onProgress === 'function') onProgress(1);
    return result;
  }
  const https = await import('node:https');
  const deadline = Date.now() + timeoutMs;
  let url = target;
  const hash = crypto.createHash('sha256');
  let written = 0;
  let attempt = 0;
  let hops = 0;
  let lastError = null;

  const fetchOnce = () => new Promise((resolve, reject) => {
    if (!DOWNLOAD_HOSTS.has(url.hostname)) {
      reject(Object.assign(Error('UPDATE_HOST_NOT_ALLOWED'), { code: 'UPDATE_HOST_NOT_ALLOWED' }));
      return;
    }
    const base = written;
    let settled = false;
    let out = null;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { error.partialBytes = fs.statSync(destPath).size; } catch { error.partialBytes = base; }
      try { out?.destroy(); } catch { /* 已关闭 */ }
      reject(error);
    };
    const headers = { 'user-agent': 'Alcor-Agent-Updater' };
    if (base > 0) headers.range = 'bytes=' + base + '-';
    const request = https.get(url, { headers, timeout: 180000 }, (response) => {
      const status = response.statusCode;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        settled = true;
        resolve({ redirect: location ? new URL(location, url).toString() : '' });
        return;
      }
      if (status !== 200 && status !== 206) {
        response.resume();
        fail(Object.assign(Error('UPDATE_HTTP_' + status), { code: 'UPDATE_DOWNLOAD_FAILED', status }));
        return;
      }
      const total = Number(response.headers['content-length']) || 0;
      if (total > maxBytes) {
        response.resume();
        fail(Object.assign(Error('UPDATE_TOO_LARGE'), { code: 'UPDATE_TOO_LARGE' }));
        return;
      }
      out = fs.createWriteStream(destPath, { flags: base > 0 ? 'a' : 'w' });
      let bytes = base;
      response.on('data', (chunk) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > maxBytes) {
          response.resume();
          fail(Object.assign(Error('UPDATE_TOO_LARGE'), { code: 'UPDATE_TOO_LARGE' }));
          return;
        }
        hash.update(chunk);
        if (!out.write(chunk)) {
          response.pause();
          out.once('drain', () => response.resume());
        }
        if (typeof onProgress === 'function') onProgress(total ? Math.min(1, bytes / (status === 206 ? total + base : total)) : 0);
      });
      response.on('end', () => { out.end(() => { if (!settled) { settled = true; resolve({ bytes }); } }); });
      response.on('aborted', () => out.end(() => fail(Object.assign(Error('UPDATE_STREAM_ABORTED'), { code: 'ECONNRESET' }))));
      response.on('error', fail);
      out.on('error', fail);
    });
    request.on('socket', (socket) => socket.once('error', () => {}));
    request.on('timeout', () => {
      fail(Object.assign(Error('UPDATE_DOWNLOAD_TIMEOUT'), { code: 'UPDATE_DOWNLOAD_TIMEOUT' }));
      try { request.destroy(); } catch { /* 已销毁 */ }
    });
    request.on('error', fail);
  });

  while (attempt < 6) {
    if (Date.now() > deadline) throw Object.assign(Error('UPDATE_DOWNLOAD_TIMEOUT'), { code: 'UPDATE_DOWNLOAD_TIMEOUT' });
    let result;
    try {
      result = await fetchOnce();
    } catch (error) {
      lastError = error;
      if (Number.isFinite(error?.partialBytes)) written = error.partialBytes;
      const fatal = ['UPDATE_TOO_LARGE', 'UPDATE_DOWNLOAD_FAILED', 'UPDATE_HOST_NOT_ALLOWED', 'UPDATE_MANIFEST_INVALID'].includes(error?.code);
      if (fatal) throw error;
      attempt++;
      await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
      continue;
    }
    if (result.redirect !== undefined) {
      hops++;
      if (!result.redirect || hops > 6) throw Object.assign(Error('UPDATE_REDIRECT_LOOP'), { code: 'UPDATE_MANIFEST_INVALID' });
      url = new URL(result.redirect);
      continue;
    }
    written = result.bytes;
    lastError = null;
    break;
  }
  if (lastError) throw lastError;
  const bytes = (await fs.promises.stat(destPath)).size;
  return { bytes, sha256: await sha256OfFile(destPath), url: url.toString() };
}

async function expectedHash(assetUrl, filename) {
  const url = sumFileUrl(assetUrl);
  const target = path.join(UPDATE_DIR, '.sums');
  await fs.promises.mkdir(UPDATE_DIR, { recursive: true });
  await downloadToFile(url, target, { maxBytes: 65536, timeoutMs: 30000 });
  const text = await fs.promises.readFile(target, 'utf8').catch(() => '');
  await fs.promises.unlink(target).catch(() => {});
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match && match[2].trim() === filename) return match[1].toLowerCase();
  }
  return '';
}


/** 静默检查（启动/定时）。失败只记在 state 里，不打断任何流程。 */
export async function checkForUpdate({ current, standard = false } = {}) {
  const result = await checkReleaseUpdate(current, { standard });
  state = {
    ...state,
    checkedAt: new Date().toISOString(),
    ok: Boolean(result.ok),
    code: result.code || '',
    current: String(current || state.current || ''),
    latest: result.latest || '',
    hasUpdate: Boolean(result.ok && result.hasUpdate),
    notes: result.notes || '',
    publishedAt: result.publishedAt || null,
    projectUrl: result.projectUrl || '',
    error: result.ok ? '' : (result.error || ''),
    phase: result.ok && result.hasUpdate ? (state.phase === 'ready' ? 'ready' : 'idle') : 'idle',
    ...(result.ok && !result.hasUpdate ? { readyPath: '', progress: 0 } : {})
  };
  if (result.ok && result.hasUpdate) state.url = result.url;
  else delete state.url;
  return updateState();
}

/** 下载并校验安装包；成功后 state.readyPath 可交给 installUpdate。 */
export async function downloadUpdate() {
  if (!state.hasUpdate || !state.url) throw Object.assign(Error('UPDATE_NOTHING_TO_DOWNLOAD'), { code: 'UPDATE_NOTHING_TO_DOWNLOAD' });
  const filename = path.basename(new URL(state.url).pathname);
  if (!/^[A-Za-z0-9._-]{1,120}\.exe$/.test(filename)) throw Object.assign(Error('UPDATE_MANIFEST_INVALID'), { code: 'UPDATE_MANIFEST_INVALID' });
  await fs.promises.mkdir(UPDATE_DIR, { recursive: true });
  const dest = path.join(UPDATE_DIR, filename);
  state = { ...state, phase: 'downloading', progress: 0, error: '', readyPath: '' };
  try {
    const expected = await expectedHash(state.url, filename);
    if (!expected) throw Object.assign(Error('UPDATE_HASH_UNAVAILABLE'), { code: 'UPDATE_HASH_UNAVAILABLE' });
    const got = await downloadToFile(state.url, dest, {
      maxBytes: MAX_INSTALLER_BYTES,
      onProgress: (value) => { state = { ...state, progress: value }; }
    });
    const actual = got.sha256;
    state = { ...state, progress: 1 };
    if (actual !== expected) {
      await fs.promises.unlink(dest).catch(() => {});
      throw Object.assign(Error('UPDATE_HASH_MISMATCH'), { code: 'UPDATE_HASH_MISMATCH' });
    }
    const bytes = (await fs.promises.stat(dest)).size;
    state = { ...state, phase: 'ready', progress: 1, readyPath: dest, readyBytes: bytes, readyHash: actual };
    return updateState();
  } catch (error) {
    state = { ...state, phase: 'error', progress: 0, readyPath: '', error: String(error?.code || error?.message || error) };
    throw error;
  }
}

/** 启动安装器并让应用退出：安装器会等进程退出后替换文件。 */
export function installUpdate({ onQuit } = {}) {
  const file = state.readyPath;
  if (!file || !fs.existsSync(file)) throw Object.assign(Error('UPDATE_PAYLOAD_MISSING'), { code: 'UPDATE_PAYLOAD_MISSING' });
  state = { ...state, phase: 'installing', error: '' };
  const child = spawn(file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/RESTARTAPPLICATIONS'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  child.unref();
  setTimeout(() => {
    try { if (typeof onQuit === 'function') onQuit(); } catch { /* 退出失败也不回滚 */ }
  }, 1500).unref?.();
  return { ok: true, pid: child.pid || null };
}

/** 启动时静默检查一次，之后每 6 小时一次；首次失败 20 分钟后重试一次。 */
export function startUpdateWatcher({ current, standard = false, log = () => {} } = {}) {
  const run = async (reason) => {
    try {
      const s = await checkForUpdate({ current, standard });
      if (s.ok && s.hasUpdate) log(`[update] 发现新版本 ${s.latest}（当前 ${s.current}）`);
      else if (s.ok) log(`[update] 已是最新版本 ${s.current}`);
      else log(`[update] 检查未完成：${s.code || s.error || '未知原因'}`);
      return s;
    } catch (error) {
      log(`[update] 检查异常：${error?.message ?? error}`);
      return updateState();
    }
  };
  bootTimer = setTimeout(() => {
    run('boot').then((s) => {
      if (!s.ok) setTimeout(() => run('retry'), RETRY_MS).unref?.();
    });
    checkTimer = setInterval(() => { run('timer'); }, CHECK_EVERY_MS);
    checkTimer.unref?.();
  }, START_DELAY_MS);
  bootTimer.unref?.();
}

export function stopUpdateWatcher() {
  if (bootTimer) clearTimeout(bootTimer);
  if (checkTimer) clearInterval(checkTimer);
  bootTimer = null;
  checkTimer = null;
}
