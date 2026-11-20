// 自动更新：检查 → 下载 → 校验 → 安装。
// 只在用户点了「检查更新 / 立即更新」时联网；启动时做一次静默检查。
// 下载优先用系统 curl（Node 的 retryRead 有 60s 硬上限，装不下 314 MB 安装包），
// 校验用同仓库同版本的 SHA256SUMS.txt 对比，不一致就删掉、不启动安装器。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR, getConfig } from './config.js';
import { checkReleaseUpdate } from './release-update.js';
import { chatCompletion } from './llm.js';
import { fetchManifest, compareVersion, isPatchUpdate } from './update-feeds.js';

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
  readyBytes: 0,
  readyHash: '',
  source: '',          // 这次校验走的通路：清单地址或 github-api
  urls: [],            // 安装包候选直链（含镜像）
  sha256: '',          // 清单声明的哈希
  bytes: 0,            // 清单声明的大小
  fileName: '',        // 清单声明的文件名
  applyMode: 'restart',// restart | hot
  minSupported: '',
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
      '--continue-at', '-',
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
  const currentVersion = String(current || state.current || '');
  const common = { ...state, checkedAt: new Date().toISOString(), current: currentVersion, error: '' };

  // 1) 多源清单：raw / jsDelivr / Pages / 自定义镜像同时打，谁先返回用谁。
  try {
    const manifest = await fetchManifest();
    const hasUpdate = compareVersion(manifest.latest, currentVersion) > 0;
    const keepReady = hasUpdate && state.phase === 'ready' && state.latest === manifest.latest && state.readyPath;
    state = {
      ...common,
      ok: true,
      code: '',
      latest: manifest.latest,
      hasUpdate,
      notes: manifest.notes,
      publishedAt: manifest.publishedAt,
      source: manifest.source,
      urls: manifest.urls,
      url: manifest.urls[0],
      sha256: manifest.sha256,
      bytes: manifest.bytes,
      fileName: manifest.fileName,
      applyMode: manifest.applyMode,
      minSupported: manifest.minSupported,
      phase: keepReady ? 'ready' : 'idle',
      ...(keepReady ? {} : { readyPath: '', readyBytes: 0, readyHash: '', progress: 0 })
    };
    return updateState();
  } catch (manifestError) {
    // 2) 清单全挂时回落 GitHub Releases API：哪怕只有这一条通，也要给出提示。
    const result = await checkReleaseUpdate(currentVersion, { standard });
    const hasUpdate = Boolean(result.ok && result.hasUpdate);
    state = {
      ...common,
      ok: Boolean(result.ok),
      code: result.code || '',
      latest: result.latest || '',
      hasUpdate,
      notes: result.notes || '',
      publishedAt: result.publishedAt || null,
      projectUrl: result.projectUrl || '',
      error: result.ok ? '' : (result.error || ''),
      source: result.ok ? 'github-api' : '',
      urls: result.ok && result.url ? [result.url] : [],
      ...(result.ok && result.url ? { url: result.url, fileName: path.basename(new URL(result.url).pathname) } : { url: '', fileName: '' }),
      sha256: '',
      bytes: 0,
      applyMode: 'restart',
      phase: hasUpdate ? 'idle' : 'idle',
      ...(hasUpdate ? {} : { readyPath: '', readyBytes: 0, readyHash: '', progress: 0 }),
      ...(manifestError ? { detail: String(manifestError?.detail || manifestError?.code || manifestError?.message || '').slice(0, 300) } : {})
    };
    return updateState();
  }
}

/** 下载并校验安装包；成功后 state.readyPath 可交给 installUpdate。 */
export async function downloadUpdate() {
  const urls = (Array.isArray(state.urls) && state.urls.length ? state.urls : (state.url ? [state.url] : []))
    .map((value) => String(value || '')).filter(Boolean);
  if (!state.hasUpdate || !urls.length) throw Object.assign(Error('UPDATE_NOTHING_TO_DOWNLOAD'), { code: 'UPDATE_NOTHING_TO_DOWNLOAD' });
  const filename = state.fileName || path.basename(new URL(urls[0]).pathname);
  if (!/^[A-Za-z0-9._-]{1,120}\.exe$/.test(filename)) throw Object.assign(Error('UPDATE_MANIFEST_INVALID'), { code: 'UPDATE_MANIFEST_INVALID' });
  await fs.promises.mkdir(UPDATE_DIR, { recursive: true });
  const dest = path.join(UPDATE_DIR, filename);
  const part = dest + '.part';
  state = { ...state, phase: 'downloading', progress: 0, error: '', readyPath: '', readyBytes: 0, readyHash: '' };
  let expected = String(state.sha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) expected = await expectedHash(urls[0], filename).catch(() => '');
  if (!/^[a-f0-9]{64}$/.test(expected)) throw Object.assign(Error('UPDATE_HASH_UNAVAILABLE'), { code: 'UPDATE_HASH_UNAVAILABLE' });
  let lastError = null;
  for (const url of urls) {
    try {
      const got = await downloadToFile(url, part, {
        maxBytes: MAX_INSTALLER_BYTES,
        onProgress: (value) => { state = { ...state, progress: value }; }
      });
      if (got.sha256 !== expected) {
        await fs.promises.rm(part, { force: true }).catch(() => {});
        lastError = Object.assign(Error('UPDATE_HASH_MISMATCH'), { code: 'UPDATE_HASH_MISMATCH' });
        continue;
      }
      await fs.promises.rename(part, dest);
      const bytes = (await fs.promises.stat(dest)).size;
      state = { ...state, phase: 'ready', progress: 1, readyPath: dest, readyBytes: bytes, readyHash: expected };
      return updateState();
    } catch (error) {
      lastError = error;
      await fs.promises.rm(part, { force: true }).catch(() => {});
    }
  }
  state = { ...state, phase: 'error', progress: 0, readyPath: '', error: String(lastError?.code || lastError?.message || 'UPDATE_DOWNLOAD_FAILED') };
  throw lastError || Object.assign(Error('UPDATE_DOWNLOAD_FAILED'), { code: 'UPDATE_DOWNLOAD_FAILED' });
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


/** AI 修复下载：装不上时让已配置的模型给出候选直链，再由本进程校验安装。 */
const REPAIR_HOSTS = new Set([
  ...DOWNLOAD_HOSTS,
  'cdn.jsdelivr.net',
  'raw.githubusercontent.com',
  'github.io'
]);

async function aiCandidateUrls() {
  const cfg = getConfig();
  const prompt = [
    '你是 Alcor Agent 的更新修复助手。用户的应用无法下载新版本安装包，现在需要你给出可用的下载直链。',
    '当前版本：' + (state.current || '未知'),
    '目标版本：' + (state.latest || '未知'),
    '已知清单地址：' + ((state.urls || []).join(' ') || '无'),
    '上次错误：' + (state.error || '未知'),
    '要求：只输出一个 JSON 对象，形如 {"urls":["https://..."],"note":"一句话"}。',
    'urls 必须是可直接下载 .exe 安装包的 https 链接（GitHub Release 资产、jsDelivr、raw.githubusercontent.com 或自建镜像均可），按优先级排序，最多 5 条，不要输出解释文字。'
  ].join('\n');
  const result = await chatCompletion({
    messages: [
      { role: 'system', content: '你是更新修复助手，只输出 JSON，不输出任何解释。' },
      { role: 'user', content: prompt }
    ],
    tools: null,
    temperature: 0,
    maxTokens: 600,
    overrides: { model: cfg?.api?.model }
  });
  const text = String(result?.message?.content || '');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw Object.assign(Error('UPDATE_AI_NO_PLAN'), { code: 'UPDATE_AI_NO_PLAN', detail: text.slice(0, 200) });
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { throw Object.assign(Error('UPDATE_AI_NO_PLAN'), { code: 'UPDATE_AI_NO_PLAN', detail: text.slice(0, 200) }); }
  const urls = [].concat(parsed.urls || []).map((value) => String(value || '')).filter(Boolean).slice(0, 5);
  const safe = [];
  for (const value of urls) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') continue;
      if (!REPAIR_HOSTS.has(url.hostname)) continue;
      if (!/\.exe$/i.test(url.pathname)) continue;
      safe.push(url.href);
    } catch { /* 跳过坏链接 */ }
  }
  if (!safe.length) throw Object.assign(Error('UPDATE_AI_NO_PLAN'), { code: 'UPDATE_AI_NO_PLAN', detail: '模型给出的链接都不在允许的下载主机里' });
  return { urls: safe, note: String(parsed.note || '').slice(0, 200) };
}

/**
 * 下载失败后的兜底：让已配置的模型给出候选直链，逐个试，仍用清单里的 sha256 校验。
 * 校验不通过就删文件，绝不放一个来路不明的安装包进系统。
 */
export async function repairUpdate() {
  const expected = String(state.sha256 || '').toLowerCase();
  if (!state.hasUpdate || !/^[a-f0-9]{64}$/.test(expected)) {
    throw Object.assign(Error('UPDATE_REPAIR_UNAVAILABLE'), { code: 'UPDATE_REPAIR_UNAVAILABLE' });
  }
  state = { ...state, phase: 'downloading', progress: 0, error: '', repair: 'asking-ai' };
  let plan;
  try {
    plan = await aiCandidateUrls();
  } catch (error) {
    state = { ...state, phase: 'error', repair: 'failed', error: String(error?.code || 'UPDATE_AI_NO_PLAN') };
    throw error;
  }
  state = { ...state, repair: 'downloading', repairNote: plan.note || '' };
  const filename = state.fileName || path.basename(new URL(plan.urls[0]).pathname);
  if (!/^[A-Za-z0-9._-]{1,120}\.exe$/i.test(filename)) throw Object.assign(Error('UPDATE_MANIFEST_INVALID'), { code: 'UPDATE_MANIFEST_INVALID' });
  await fs.promises.mkdir(UPDATE_DIR, { recursive: true });
  const dest = path.join(UPDATE_DIR, filename);
  const part = dest + '.part';
  let lastError = null;
  for (const url of plan.urls) {
    try {
      const got = await downloadToFile(url, part, {
        maxBytes: MAX_INSTALLER_BYTES,
        onProgress: (value) => { state = { ...state, progress: value }; }
      });
      if (got.sha256 !== expected) {
        await fs.promises.rm(part, { force: true }).catch(() => {});
        lastError = Object.assign(Error('UPDATE_HASH_MISMATCH'), { code: 'UPDATE_HASH_MISMATCH' });
        continue;
      }
      await fs.promises.rename(part, dest);
      const bytes = (await fs.promises.stat(dest)).size;
      state = { ...state, phase: 'ready', progress: 1, readyPath: dest, readyBytes: bytes, readyHash: expected, repair: 'done' };
      return updateState();
    } catch (error) {
      lastError = error;
      await fs.promises.rm(part, { force: true }).catch(() => {});
    }
  }
  state = { ...state, phase: 'error', progress: 0, repair: 'failed', error: String(lastError?.code || 'UPDATE_DOWNLOAD_FAILED') };
  throw lastError || Object.assign(Error('UPDATE_DOWNLOAD_FAILED'), { code: 'UPDATE_DOWNLOAD_FAILED' });
}

/** 启动时静默检查一次，之后每 6 小时一次；首次失败 20 分钟后重试一次。 */
export function startUpdateWatcher({ current, standard = false, log = () => {}, onQuit } = {}) {
  const run = async (reason) => {
    try {
      const s = await checkForUpdate({ current, standard });
      if (s.ok && s.hasUpdate) log(`[update] 发现新版本 ${s.latest}（当前 ${s.current}）来源 ${s.source || '未知'}`);
      else if (s.ok) log(`[update] 已是最新版本 ${s.current}`);
      else log(`[update] 检查未完成：${s.code || s.error || '未知原因'}`);
      // 小版本（同主次版本号）更新：直接下好并安装，用户不需要点任何按钮。
      const auto = getConfig()?.update?.autoInstall !== false;
      if (s.ok && s.hasUpdate && auto && isPatchUpdate(s.latest, s.current)) {
        try {
          log(`[update] 小版本更新，开始自动下载 ${s.latest}`);
          const ready = await downloadUpdate();
          log(`[update] 安装包已校验，${Math.round((ready.readyBytes || 0) / 1048576)} MB，准备安装`);
          installUpdate({ onQuit });
        } catch (error) {
          log(`[update] 自动安装未完成：${error?.code || error?.message || error}`);
        }
      }
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
