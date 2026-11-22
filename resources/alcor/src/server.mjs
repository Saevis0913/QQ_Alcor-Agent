import http from 'node:http';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import manifest from '../package.json' with { type: 'json' };
import WebSocket, { WebSocketServer } from '../vendor/ws/wrapper.mjs';
import { normalizeConfig } from './config.mjs';
import { Backend, BridgeError, isQuery } from './backend.mjs';
import { withinJsonDepth } from './json.mjs';
import { NativeBackend } from './native-backend.mjs';
import { createNativeResume } from '../native-core/native-resume.mjs';
import { createManagement } from './management.mjs';
import { compatibleCall } from './adapters.mjs';
import { servePanel } from './panel.mjs';
import { createOutboundTransports } from './outbound-transports.mjs';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const responseEcho = request => object(request) && own(request, 'echo') ? { echo: request.echo } : {};
const failure = (code, retcode = 1500, extra = {}) => ({ status: 'failed', retcode, data: null, wording: code, ...extra });
const hash = value => createHash('sha256').update(value).digest();

async function readBody(req, limit, reserve) {
  if (Number(req.headers['content-length']) > limit) { req.resume(); throw new BridgeError('REQUEST_TOO_LARGE', 413); }
  let size = 0; const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) { req.resume(); throw new BridgeError('REQUEST_TOO_LARGE', 413); }
    reserve(chunk.length);
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new BridgeError('INVALID_JSON', 400); }
  if (!object(result)) throw new BridgeError('OBJECT_REQUIRED', 400);
  return result;
}

export function createBridge(input, options={}) {
  const config = normalizeConfig(input);
  const mediaFile=options.management?.configFile?path.resolve(options.management.configFile)+'.media-index.json':undefined;
  const backend = config.backend.type==='native' ? new NativeBackend(config,{...options.native,mediaFile}) : new Backend(config);
  const nativeResume = config.backend.type === 'native' ? createNativeResume(options.management?.configFile, backend, options.nativeResume) : null;
  const clients = new Set(); const apiClients = new WeakSet();
  const clientCleanup = new WeakMap(); const connections = new Set(); const born = Date.now();
  let active = 0; let bufferedBytes = 0; let droppedClients = 0; let stopped = false;
  let binding, starting, closing;
  function acquire() {
    if (active >= config.maxConcurrent) throw new BridgeError('TOO_MANY_REQUESTS', 429);
    active++;
    let retained = 0; let released = false;
    return {
      reserve(bytes) {
        if (released) throw new BridgeError('REQUEST_CLOSED', 499);
        if (bufferedBytes + bytes > config.maxBufferedBytes) throw new BridgeError('BUFFER_CAPACITY_EXCEEDED', 503);
        retained += bytes; bufferedBytes += bytes;
      },
      release() { if (released) return; released = true; active--; bufferedBytes -= retained; }
    };
  }
  const expectedToken = hash(config.listen.token);
  const authorize = (req, url) => {
    const authorization = req.headers.authorization;
    const token = authorization !== undefined ? /^Bearer (.+)$/i.exec(authorization)?.[1] : url.searchParams.get('access_token');
    return typeof token === 'string' && timingSafeEqual(hash(token), expectedToken);
  };
  const validOrigin = req => !req.headers.origin || req.headers.origin === `http://${req.headers.host}`;
  function status() {
    const connection = backend.snapshot();
    const ready = connection.receiveReady === true && connection.qqOnline === true &&
      (config.backend.type === 'native' || connection.apiReady === true);
    return { name: 'Alcor', version: manifest.version, listening: server.listening, ready, readOnly: config.readOnly, backend: connection, outbound: outbound.snapshot(), activeRequests: active, bufferedBytes, clients: clients.size, connections: connections.size, droppedClients, uptimeSeconds: Math.floor((Date.now() - born) / 1000) };
  }
  const management=createManagement({config,backend,status,...options.management,nativeResume});
  async function dispatch(request, lease) {
    if (!withinJsonDepth(request, config.maxJsonDepth)) return { code: 400, body: failure('JSON_TOO_DEEP', 1400) };
    const echo = responseEcho(request);
    if (!object(request) || typeof request.action !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_.]{0,99}$/.test(request.action) || (request.params !== undefined && !object(request.params))) return { code: 400, body: failure('INVALID_ACTION_REQUEST', 1400, echo) };
    if (stopped) return { code: 503, body: failure('SHUTTING_DOWN', 1503, echo) };
    const { action } = request;
    if (action === 'get_version_info') return { code: 200, body: { status: 'ok', retcode: 0, data: { app_name: 'Alcor', app_version: manifest.version, protocol_version: 'v11', implementation: config.backend.type==='native'?'native-qq-client':'external-personal-account-backend' }, ...echo } };
    if (action === 'get_bridge_status') return { code: 200, body: { status: 'ok', retcode: 0, data: status(), ...echo } };
    if (action === 'get_bridge_info') {
      const results = await Promise.allSettled(['get_status', 'get_login_info', 'get_version_info'].map(name => backend.call(name, {}, lease.reserve)));
      const value = index => results[index].status === 'fulfilled' && results[index].value.status === 'ok' ? results[index].value.data : null;
      const login = value(1), version = value(2), address = server.address();
      if (stopped || !address) return { code: 503, body: failure('SHUTTING_DOWN', 1503, echo) };
      const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
      const httpUrl = `http://${host}:${address.port}`;
      return { code: 200, body: { status: 'ok', retcode: 0, data: {
        bridge: status(), compatibility: config.compatibility,
        connection: { httpUrl, wsUrl: httpUrl.replace('http:', 'ws:') + '/events' },
        accountLastFour: login?.user_id === undefined ? null : String(login.user_id).slice(-4),
        backendVersion: version ? { name: String(version.app_name ?? '').slice(0, 100), version: String(version.app_version ?? '').slice(0, 100) } : null,
        backendQueriesSucceeded: results.every(result => result.status === 'fulfilled' && result.value.status === 'ok')
      }, ...echo } };
    }
    if (config.readOnly && !isQuery(action)) return { code: 403, body: failure('READ_ONLY_MODE', 1403, echo) };
    try {
      const { echo: _upstreamEcho, ...body } = await compatibleCall(config, backend, action, request.params ?? {}, lease.reserve);
      management.log(body.status === 'ok' ? 'info' : 'warn', 'action', action + ' · ' + (body.status === 'ok' ? '完成' : '失败'));
      return { code: 200, body: { ...body, ...echo } };
    }
    catch (error) { management.log('warn','action',action+' · '+(error.code??'INTERNAL_ERROR'));return { code: error.httpStatus ?? 500, body: failure(error.code ?? 'INTERNAL_ERROR', error.httpStatus ?? 1500, { ...(error.delivery ? { delivery: error.delivery } : {}), ...echo }) }; }
  }
  async function getAccount() {
    if (config.backend.type === 'native') return backend.controller.snapshot().connected && backend.receiving ? backend.account : null;
    if (!backend.snapshot().receiveReady) return null;
    const reply = await backend.call('get_login_info', {});
    return reply.status === 'ok' ? reply.data?.user_id : null;
  }
  const outbound = createOutboundTransports(config, {
    getAccount, log: management.log,
    async execute(request, account, size = 0) {
      const echo = withinJsonDepth(request, config.maxJsonDepth) ? responseEcho(request) : {};
      let lease, timeout, cancelled = false, dispatched = false;
      try {
        lease = acquire(); lease.reserve(size);
        const operation = (async () => {
          if (String(await getAccount()) !== account) return failure('OUTBOUND_ACCOUNT_CHANGED', 1409, echo);
          if (cancelled || stopped) return failure('CLIENT_TIMEOUT', 1504, echo);
          if (config.backend.type === 'native' && object(request) && (request.params === undefined || object(request.params))) {
            request = { ...request, params: { ...request.params, expected_self_id: account } };
          }
          dispatched = true;
          return (await dispatch(request, lease)).body;
        })();
        const deadline = new Promise(resolve => { timeout = setTimeout(() => {
          cancelled = true;
          const delivery = dispatched && !isQuery(request?.action ?? '') ? { delivery: 'unknown' } : {};
          resolve(failure('CLIENT_TIMEOUT', 1504, { ...delivery, ...echo }));
        }, config.clientTimeoutMs); timeout.unref(); });
        return await Promise.race([operation, deadline]);
      } catch (error) { return failure(error.code ?? 'INTERNAL_ERROR', error.httpStatus ?? 1500, echo); }
      finally { cancelled = true; clearTimeout(timeout); lease?.release(); }
    }
  });
  function send(res, code, body) {
    if (res.destroyed) return;
    const json = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(json);
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!validOrigin(req)) { req.resume(); send(res, 403, failure('ORIGIN_NOT_ALLOWED', 1403)); return; }
      if (servePanel(req, res, url)) return;
      if (!authorize(req, url)) { req.resume(); send(res, 401, failure('UNAUTHORIZED', 1401)); return; }
      if (stopped) { req.resume(); send(res, 503, failure('SHUTTING_DOWN', 1503)); return; }
      if(url.pathname.startsWith('/manage/')){
        if(!['GET','POST'].includes(req.method)){req.resume();send(res,405,failure('METHOD_NOT_ALLOWED',1405));return;}
        const lease=acquire();res.once('finish',lease.release);res.once('close',lease.release);res.setTimeout(config.clientTimeoutMs,()=>res.destroy());
        const body=req.method==='POST'?await readBody(req,65536,lease.reserve):{};
        send(res,200,await management.handle(url.pathname.slice(8),req.method,body));return;
      }
      if (req.method === 'GET' && url.pathname === '/health') { send(res, 200, status()); return; }
      if (!['GET', 'POST'].includes(req.method)) { req.resume(); send(res, 405, failure('METHOD_NOT_ALLOWED', 1405)); return; }
      const lease = acquire();
      res.once('finish', lease.release); res.once('close', lease.release);
      res.setTimeout(config.clientTimeoutMs, () => res.destroy());
      let request;
      if (req.method === 'POST') {
        const body = await readBody(req, config.maxBodyBytes, lease.reserve);
        request = url.pathname === '/' ? body : { action: url.pathname.slice(1), params: body };
      } else {
        const params = Object.create(null);
        for (const [key, value] of url.searchParams) {
          if (key === 'access_token') continue;
          let parsed = value;
          try { const candidate = JSON.parse(value); if (typeof candidate !== 'number' || Number.isSafeInteger(candidate)) parsed = candidate; } catch { /* Plain OneBot query strings remain strings. */ }
          params[key] = parsed;
        }
        request = { action: url.pathname.slice(1), params };
      }
      const result = await dispatch(request, lease); send(res, result.code, result.body);
    } catch (error) {
      req.resume();
      if (res.headersSent) res.destroy();
      else send(res, error.httpStatus ?? 500, failure(error.code ?? 'INTERNAL_ERROR', error.httpStatus ?? 1500));
    }
  });
  server.maxConnections = config.maxConnections;
  server.on('connection', socket => {
    connections.add(socket); socket.once('close', () => connections.delete(socket));
    socket.setTimeout(config.clientTimeoutMs, () => socket.destroy());
  });
  server.requestTimeout = Math.max(config.sendTimeoutMs + 5000, 30000);
  server.headersTimeout = 15000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxBodyBytes, perMessageDeflate: false });
  const wsSend = (client, value, done = () => {}) => {
    if (client.readyState !== WebSocket.OPEN) { done(); return; }
    if (client.bufferedAmount > config.maxResponseBytes) { droppedClients++; client.terminate(); done(); return; }
    let bytes = 0; let released = false;
    const release = () => {
      if (released) return; released = true;
      bufferedBytes -= bytes; clientCleanup.get(client)?.delete(release); done();
    };
    try {
      const json = JSON.stringify(value); const size = Buffer.byteLength(json);
      if (bufferedBytes + size > config.maxBufferedBytes) { droppedClients++; client.terminate(); done(); return; }
      bytes = size; bufferedBytes += bytes;
      clientCleanup.get(client)?.add(release);
      client.send(json, error => { if (error) client.terminate(); release(); });
    } catch { droppedClients++; client.terminate(); release(); }
  };
  server.on('upgrade', (req, socket, head) => {
    let url; try { url = new URL(req.url, 'http://127.0.0.1'); } catch { socket.destroy(); return; }
    const route = url.pathname.replace(/\/$/, '') || '/';
    if (!['/', '/events', '/event', '/api'].includes(route) || !validOrigin(req) || !authorize(req, url)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    if (stopped || clients.size >= config.maxWsClients) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, client => {
      socket.setTimeout(0);
      clients.add(client);
      if (route === '/api') apiClients.add(client);
      clientCleanup.set(client, new Set());
      client.on('error', () => {});
      client.on('close', () => {
        clients.delete(client);
        for (const release of clientCleanup.get(client) ?? []) release();
      });
      if (route === '/event') return;
      client.on('message', async (data, binary) => {
        if (binary) { wsSend(client, failure('TEXT_JSON_REQUIRED', 1400)); return; }
        let lease;
        let timer;
        const finish = () => { clearTimeout(timer); clientCleanup.get(client)?.delete(finish); lease?.release(); };
        try {
          lease = acquire(); lease.reserve(data.length);
          clientCleanup.get(client)?.add(finish);
          timer = setTimeout(() => { client.terminate(); finish(); }, config.clientTimeoutMs); timer.unref();
          let request; try { request = JSON.parse(data.toString('utf8')); } catch { throw new BridgeError('INVALID_JSON', 400); }
          wsSend(client, (await dispatch(request, lease)).body, finish);
        } catch (error) { wsSend(client, failure(error.code ?? 'INTERNAL_ERROR', error.httpStatus ?? 1500), finish); }
      });
    });
  });
  async function closeResources() {
    await binding?.catch(() => {});
    const serverClosed = server.listening ? new Promise(resolve => server.close(resolve)) : null;
    let failure;
    const outboundClosed = outbound.close().catch(error => { failure = error; });
    try { await nativeResume?.close(); } catch (error) { failure ??= error; }
    try { await backend.close(); } catch (error) { failure ??= error; }
    await outboundClosed;
    for (const client of clients) client.terminate();
    wss.close();
    for (const socket of connections) socket.destroy();
    server.closeAllConnections();
    await serverClosed;
    if (failure) throw failure;
  }

  function close() {
    if (!closing) {
      stopped = true;
      closing = closeResources();
    }
    return closing;
  }

  async function start() {
    binding = new Promise((resolve, reject) => {
      const onError = error => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.listen(config.listen.port, config.listen.host, onListening);
    });
    await binding;
    if (stopped) throw new BridgeError('SHUTTING_DOWN', 503);
    try {
      backend.start(event => {
        for (const client of clients) if (!apiClients.has(client)) wsSend(client, event);
        outbound.publish(event);
      });
      outbound.start();
      nativeResume?.start(() => management.log('warn', 'native', '上次选择的 QQ 进程无法恢复连接，请检查并手动连接。'));
    } catch (error) { await close(); throw error; }
    const address = server.address();
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    const httpUrl = `http://${host}:${address.port}`;
    return { httpUrl, wsUrl: httpUrl.replace('http:', 'ws:') + '/events' };
  }

  function listen() {
    if (stopped) return Promise.reject(new BridgeError('SHUTTING_DOWN', 503));
    if (!starting) {
      starting = start();
      starting.catch(() => { starting = null; });
    }
    return starting;
  }

  return { backend, status, listen, close };
}
