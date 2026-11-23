// 接入方式切换：内置核心（原生注入） ⇄ OneBot 进程外接入。
//
// 两套接入方式的开关不是一个配置项，而是安装目录里的一个标记文件：
// resources/app/onebot-edition.json —— app.js 用 isStandardEdition() 判它。
// 之所以仍然走文件：安装包/逆向者都能改 config.json，标记文件才是「这台机器装的是哪种版本」
// 的唯一事实来源；这里只负责把它做成用户点一下就能完成的事。
//
// 原生注入在一部分机器上注定拿不到 QQ 的消息服务对象（service_global 恒 0、
// get_service 绑在线程局部存储上），那种机器只能走 OneBot。界面上按诊断码
// IDENTITY_SERVICE_UNBOUND 给出这个入口，别让用户自己去翻文件。

import fs from 'node:fs';
import path from 'node:path';
import { normalizeStandardConnection } from './standard-connection.js';
import { editionMarkerPath as markerPathOf } from './environment-check.mjs';

export const ONEBOT_EDITION_MARKER = 'onebot-edition.json';

// 路径判定只有一处：environment-check 既给 isStandardEdition 用，也给这里用。
export const editionMarkerPath = markerPathOf;

export function onebotEditionEnabled(installRoot) {
  try { return fs.existsSync(editionMarkerPath(installRoot)); } catch { return false; }
}

// 连接设置必须指向本机别的端口：指回 Agent 自己会形成自环，normalizeStandardConnection
// 只管地址格式，端口冲突要在知道本进程端口的地方判。
export function connectionHitsPort(connection, port) {
  if (!port) return false;
  for (const value of [connection?.httpUrl, connection?.wsUrl]) {
    if (!value) continue;
    try { if (Number(new URL(value).port) === Number(port)) return true; } catch { /* 地址已由 normalize 校验 */ }
  }
  return false;
}

export function readEditionRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('接入设置格式无效。');
  return normalizeStandardConnection(body);
}

export function enableOneBotEdition({ installRoot, connection, now = new Date().toISOString() }) {
  if (!connection?.httpUrl || !connection?.wsUrl) throw new Error('OneBot 接入需要 HTTP 与 WebSocket 两个本机地址。');
  const marker = editionMarkerPath(installRoot);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  // switchedInPlace：这是用户在已装好的内置核心版里点的切换，不是「标准版安装包」。
  // environment-check 的 ONEBOT_SEPARATE_DIRECTORY 只放行带这个标记的目录。
  fs.writeFileSync(marker, JSON.stringify({ edition: 'onebot', switchedInPlace: true, enabledAt: now,
    httpUrl: connection.httpUrl, wsUrl: connection.wsUrl }, null, 2) + '\n', 'utf8');
  return { marker, enabledAt: now };
}

// 「测试连接」：只读探测外部 OneBot 的 HTTP 动作与 WebSocket 事件通道，
// 不改任何配置。分成两段报，用户才知道是地址错了还是令牌错了。
export async function probeOneBotConnection(connection, { timeoutMs = 8000, fetchImpl = fetch, WebSocketImpl = null } = {}) {
  const http = { ok: false, ms: 0, error: '', account: '', nickname: '' };
  const ws = { ok: false, ms: 0, error: '' };
  if (!connection?.httpUrl || !connection?.wsUrl) return { ok: false, http, ws, message: 'OneBot 接入需要 HTTP 与 WebSocket 两个本机地址。' };
  const startedHttp = Date.now();
  const headers = { 'content-type': 'application/json' };
  if (connection.httpAccessToken) headers.authorization = 'Bearer ' + connection.httpAccessToken;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetchImpl(String(connection.httpUrl).replace(/\/+$/, '') + '/get_login_info', {
      method: 'POST', headers, body: '{}', signal: controller.signal });
    clearTimeout(timer);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!res.ok) http.error = 'HTTP ' + res.status + (body?.message ? '：' + body.message : '');
    else if (!body || typeof body !== 'object') http.error = '返回的不是 OneBot JSON：' + text.slice(0, 120);
    else if (Number(body.retcode) !== 0) http.error = 'retcode ' + body.retcode + (body.message ? '：' + body.message : '至' + text.slice(0, 120));
    else {
      http.ok = true;
      http.account = String(body.data?.user_id ?? '');
      http.nickname = String(body.data?.nickname ?? '');
    }
  } catch (error) {
    http.error = error?.name === 'AbortError' ? '请求超时（' + timeoutMs + ' ms）'
      : String(error?.cause?.message || error?.message || error);
  }
  http.ms = Date.now() - startedHttp;
  const startedWs = Date.now();
  try {
    const Impl = WebSocketImpl || (await import('ws')).WebSocket;
    const socket = new Impl(connection.wsUrl, { headers: connection.accessToken ? { authorization: 'Bearer ' + connection.accessToken } : {} });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { try { socket.close(); } catch { /* */ } reject(new Error('握手超时（' + timeoutMs + ' ms）')); }, timeoutMs);
      socket.once('open', () => { clearTimeout(timer); try { socket.close(); } catch { /* */ } resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    ws.ok = true;
  } catch (error) {
    ws.error = String(error?.message || error);
  }
  ws.ms = Date.now() - startedWs;
  const ok = http.ok && ws.ok;
  const message = ok
    ? '连接成功：账号 ' + (http.account || '(未知)') + (http.nickname ? '（' + http.nickname + '）' : '')
    : [http.error ? 'HTTP：' + http.error : '', ws.error ? 'WebSocket：' + ws.error : ''].filter(Boolean).join('；') || '连接失败';
  return { ok, http, ws, message };
}

export function disableOneBotEdition({ installRoot }) {
  const marker = editionMarkerPath(installRoot);
  try { fs.unlinkSync(marker); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return { marker };
}
