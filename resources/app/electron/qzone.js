import { app, BrowserWindow, net, safeStorage, session } from 'electron';
import path from 'node:path';
import { QZONE_ACCOUNT, qzoneItemKey } from '../src/qzone.js';
import { QZONE_ORIGIN, buildQzoneLoginUrl, buildQzoneReadUrl, describeQzoneResponse, isQzoneLoginNavigation, isQzoneLoginRequest, isQzoneReadRequest, parseQzoneFeed, qzoneError } from '../src/qzone-feed.js';
import { createQzoneSessionStore } from './qzone-session.js';

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_PAGES = 8;

// Authentication stays in this partition. g_tk is the site's normal CSRF value
// for its own first-party session and only travels to the fixed read endpoints.
function csrf(key) {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) hash = (hash * 33 + key.charCodeAt(i)) | 0;
  return hash & 0x7fffffff;
}

export function createElectronQzoneProvider() {
  const isolated = session.fromPartition('persist:alcor-qzone', { cache: false });
  const sessionStore = createQzoneSessionStore({ dataDir: process.env.ALCOR_AGENT_DATA_DIR || path.dirname(app.getPath('userData')), safeStorage, partition: isolated });
  const reads = new Set();
  let loginWindow;
  let revision = 0;
  let checkingLogin = false;
  let blockedNavigationHost;
  let readFailures = [];
  let readScans = [];
  let expectedLoginAccount;
  let attemptedRestore;
  let restoring;
  let sessionStored = false;

  const getCookies = () => isolated.cookies.get({ url: `${QZONE_ORIGIN}/` });

  async function auth(cookies) {
    cookies ??= await getCookies();
    const find = (name) => cookies.find((cookie) => cookie.name === name && ['qzone.qq.com', 'user.qzone.qq.com'].includes(cookie.domain?.replace(/^\./, '')))?.value || '';
    const account = find('p_uin').replace(/^o0*/i, '');
    const key = find('p_skey');
    return QZONE_ACCOUNT.test(account) && key ? { account, key } : null;
  }

  async function finishLogin() {
    if (!loginWindow || checkingLogin) return;
    checkingLogin = true;
    const window = loginWindow;
    try {
      const cookies = await getCookies();
      const current = await auth(cookies);
      if (current && loginWindow === window && !window.isDestroyed()) {
        await isolated.cookies.flushStore();
        if (current.account === expectedLoginAccount) sessionStored = await sessionStore.save(current.account, cookies).catch(() => false);
        else await sessionStore.clear().catch(() => {});
        if (!window.isDestroyed()) window.destroy();
      }
    } catch { /* the manual sign-in window can still be closed */ }
    finally { checkingLogin = false; }
  }

  isolated.cookies.on('changed', () => { if (loginWindow) void finishLogin(); });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on('will-download', (event) => event.preventDefault());
  isolated.webRequest.onBeforeRequest((request, callback) => {
    if (loginWindow && request.webContentsId === loginWindow.webContents.id) {
      return callback({ cancel: !isQzoneLoginRequest(request.url, request.method) });
    }
    callback({ cancel: !isQzoneReadRequest(request.url, request.method) });
  });

  async function status(expectedAccount) {
    if (loginWindow) return { state: 'signing_in', revision };
    let current = await auth();
    if (QZONE_ACCOUNT.test(expectedAccount) && !current && attemptedRestore !== expectedAccount) {
      restoring ??= sessionStore.restore(expectedAccount).then((restored) => {
        attemptedRestore = expectedAccount;
        sessionStored = restored;
      }).finally(() => { restoring = undefined; });
      await restoring;
      current = await auth();
    }
    if (current && QZONE_ACCOUNT.test(expectedAccount) && current.account !== expectedAccount) {
      sessionStored = false;
      await sessionStore.clear().catch(() => {});
    }
    return current ? { state: 'signed_in', account: current.account, revision } : { state: 'login_required', revision };
  }

  async function diagnostics() {
    const cookies = await getCookies();
    const url = loginWindow?.webContents.getURL();
    return {
      loginWindowOpen: Boolean(loginWindow),
      loginHost: url && isQzoneLoginNavigation(url) ? new URL(url).hostname : null,
      blockedNavigationHost: blockedNavigationHost ?? null,
      cookiePresent: Object.fromEntries(['p_uin', 'p_skey', 'uin', 'skey'].map((name) => [name, cookies.some((cookie) => cookie.name === name)])),
      cookiePersistent: Object.fromEntries(['p_uin', 'p_skey', 'uin', 'skey'].map((name) => [name, cookies.some((cookie) => cookie.name === name && !cookie.session)])),
      accountSuffix: (await auth(cookies))?.account.slice(-4) ?? null,
      sessionStored,
      readFailures, readScans
    };
  }

  async function login({ reset, account }) {
    if (loginWindow) return loginWindow.focus();
    if (reset) {
      await sessionStore.clear();
      await isolated.clearStorageData();
      sessionStored = false;
    }
    expectedLoginAccount = account;
    attemptedRestore = account;
    blockedNavigationHost = undefined;
    revision++;
    const window = new BrowserWindow({
      width: 820, height: 720, show: true, title: '连接 QQ 空间', autoHideMenuBar: true,
      webPreferences: { session: isolated, sandbox: true, nodeIntegration: false, contextIsolation: true }
    });
    loginWindow = window;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (event, url) => {
      if (isQzoneLoginNavigation(url)) return;
      event.preventDefault();
      try {
        const { hostname } = new URL(url);
        if (hostname === 'qq.com' || hostname.endsWith('.qq.com')) blockedNavigationHost = hostname;
      } catch { /* malformed URL */ }
    };
    window.webContents.on('will-navigate', guard);
    window.webContents.on('will-redirect', guard);
    window.webContents.on('did-navigate', () => { void finishLogin(); });
    window.on('closed', () => {
      if (loginWindow === window) loginWindow = undefined;
      revision++;
    });
    // loadURL completion can lag behind the visible login UI. Resolve once the
    // window has been created and keep navigation errors out of application logs.
    void window.loadURL(buildQzoneLoginUrl().href).catch(() => {});
  }

  async function getPage(url, account, signal, attempt) {
    if (!isQzoneReadRequest(url, 'GET')) throw qzoneError('read_error');
    signal.throwIfAborted();
    let httpStatus;
    let contentType;
    const source = await new Promise((resolve, reject) => {
      const request = net.request({
        url: url.href, session: isolated, method: 'GET', credentials: 'include', redirect: 'manual', cache: 'no-store',
        headers: { Referer: `${QZONE_ORIGIN}/${account}/main`, Accept: 'application/json, text/javascript, */*;q=0.5' }
      });
      const fail = (code) => { reject(qzoneError(code)); request.abort(); };
      const abort = () => fail('read_error');
      signal.addEventListener('abort', abort, { once: true });
      request.once('close', () => signal.removeEventListener('abort', abort));
      request.once('redirect', () => fail('login_required'));
      request.once('error', () => reject(qzoneError('read_error')));
      request.once('response', (response) => {
        httpStatus = response.statusCode;
        const value = String(response.headers['content-type'] || '').split(';')[0].trim();
        contentType = /^(?:text|application)\/[a-z0-9+.-]+$/i.test(value) ? value : undefined;
        response.once('error', () => reject(qzoneError('read_error')));
        if ([401, 403].includes(response.statusCode)) return fail('login_required');
        if (response.statusCode < 200 || response.statusCode >= 300) return fail('read_error');
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.byteLength;
          if (size > MAX_BYTES) return fail('parse_error');
          chunks.push(chunk);
        });
        response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      request.end();
    }).catch((error) => {
      readFailures.push({ ...attempt, httpStatus, contentType, state: error.code });
      throw error;
    });
    try { return { ...parseQzoneFeed(source), diagnostics: { httpStatus, contentType, shape: describeQzoneResponse(source) } }; }
    catch (error) {
      readFailures.push({ ...attempt, httpStatus, contentType, state: error.code, stage: error.stage,
        parseOffset: error.parseOffset, parseKind: error.parseKind, records: error.records, unrecognized: error.unrecognized,
        shape: describeQzoneResponse(source) });
      throw error;
    }
  }

  async function scan({ account, scope, limit, seen, friendIds }, token, signal, fallback = false) {
    const items = new Map();
    const cursors = new Set();
    const report = { scope, fallback, pages: 0, parsed: 0, eligible: 0, added: 0, end: 'page_limit', responses: [] };
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = buildQzoneReadUrl({ account, scope, token, cursor, fallback, start: page * 20 });
      const feed = await getPage(url, account, signal, { scope, fallback, page: page + 1 });
      report.pages++;
      report.responses.push(feed.diagnostics);
      report.parsed += feed.items.length;
      for (const item of feed.items) {
        if ((item.authorId === account) !== (scope === 'own')) continue;
        if (scope === 'friends' && !friendIds.has(item.authorId)) continue;
        report.eligible++;
        const key = qzoneItemKey(item);
        if (!seen.has(key) && !items.has(key)) items.set(key, item);
      }
      if (!feed.more) { report.end = 'terminal_page'; break; }
      if (items.size >= limit) { report.end = 'quota'; break; }
      if (!fallback && (!feed.cursor || cursors.has(feed.cursor))) {
        report.end = feed.cursor ? 'repeated_cursor' : 'missing_cursor';
        break;
      }
      cursor = feed.cursor;
      cursors.add(cursor);
    }
    report.added = Math.min(items.size, limit);
    readScans.push(report);
    if (!report.added && !['terminal_page', 'quota'].includes(report.end)) throw qzoneError('parse_error');
    return [...items.values()].slice(0, limit);
  }

  async function read(input) {
    if (input.scope === 'friends' && !(input.friendIds instanceof Set)) throw qzoneError('read_error');
    if (input.scope === 'own' || readFailures.length >= 8) readFailures = [];
    if (input.scope === 'own' || readScans.length >= 8) readScans = [];
    if (loginWindow) throw qzoneError('login_required');
    const current = await auth();
    if (!current) throw qzoneError('login_required');
    if (current.account !== input.account) throw qzoneError('wrong_account');
    const request = new AbortController();
    reads.add(request);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    const token = csrf(current.key);
    try {
      let items;
      try { items = await scan(input, token, signal); }
      catch (error) {
        if (error.code !== 'parse_error') throw error;
        return await scan(input, token, signal, true);
      }
      if (!items.length && readScans.at(-1)?.parsed === 0) {
        return await scan(input, token, signal, true);
      }
      return items;
    } catch (error) {
      if (error.code === 'login_required') {
        sessionStored = false;
        await sessionStore.clear().catch(() => {});
      }
      if (['login_required', 'wrong_account', 'parse_error', 'read_error'].includes(error?.code)) throw error;
      throw qzoneError('read_error');
    } finally {
      reads.delete(request);
    }
  }

  return { status, diagnostics, login, read, stop() {
    loginWindow?.destroy();
    for (const request of reads) request.abort();
  } };
}
