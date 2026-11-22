import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Backend } from '../src/backend.mjs';
import { loadConfig, normalizeConfig } from '../src/config.mjs';
import { createBridge } from '../src/server.mjs';
import WebSocket, { WebSocketServer } from '../vendor/ws/wrapper.mjs';

const bridgeToken = 'alcor-fixture-token';
const upstreamToken = 'onebot-fixture-token';
const testOptions = { timeout: 7000 };

function reply(action, echo) {
  const data = action === 'get_status' ? { online: true, good: true } : { message_id: 7001 };
  return { status: 'ok', retcode: 0, data, ...(echo === undefined ? {} : { echo }) };
}

async function mockUpstream(t, {
  mode = 'ws', host = '127.0.0.1', delayed = false, authenticated = true, onRequest
} = {}) {
  const auth = authenticated ? 'Bearer ' + upstreamToken : undefined;
  const calls = [];
  function respond(action, echo, transport, send, socket) {
    calls.push({ action, transport });
    if (onRequest?.({ action, echo, transport, send, socket })) return;
    send(reply(action, echo));
  }

  const server = http.createServer((req, res) => {
    req.resume();
    if (mode === 'ws') return res.writeHead(404).end();
    if (req.headers.authorization !== auth) return res.writeHead(401).end();
    res.setHeader('content-type', 'application/json');
    respond(req.url.slice(1), undefined, 'http', (result) => res.end(JSON.stringify(result)));
  });
  const ws = new WebSocketServer({
    server,
    verifyClient(info, done) {
      const verify = () => done(info.req.headers.authorization === auth, 401);
      if (delayed) setTimeout(verify, 35);
      else verify();
    }
  });
  ws.on('connection', (socket) => {
    socket.on('message', (bytes) => {
      const { action, echo } = JSON.parse(bytes);
      respond(action, echo, 'websocket', (result) => socket.send(JSON.stringify(result)), socket);
    });
  });
  const open = once(server, 'listening');
  server.listen(0, host);
  await open;
  const address = host === '::1' ? '[::1]' : host;
  const origin = address + ':' + server.address().port;
  const config = {
    listen: { host: address, port: 0, token: bridgeToken },
    backend: {
      type: 'onebot', wsUrl: 'ws://' + origin + '/', wsToken: authenticated ? upstreamToken : '',
      ...(mode === 'http' ? { httpUrl: 'http://' + origin, httpToken: authenticated ? upstreamToken : '' } : {})
    },
    readOnly: false,
    requestTimeoutMs: 2000,
    sendTimeoutMs: 2000,
    reconnectMinMs: 20,
    reconnectMaxMs: 40
  };
  t.after(async () => {
    for (const socket of ws.clients) socket.terminate();
    const wsClosed = new Promise(resolve => ws.close(resolve));
    const httpClosed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await Promise.all([wsClosed, httpClosed]);
  });
  return { config, ws, calls };
}

async function fixtureConfig(t, raw, encoding) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'alcor-onebot-matrix-'));
  const file = path.join(root, '连接配置.json');
  t.after(async () => {
    if (await fs.realpath(path.dirname(root)) !== parent) throw new Error('Invalid fixture directory');
    await fs.unlink(file);
    await fs.rmdir(root);
  });
  const json = JSON.stringify(raw);
  const bytes = encoding === 'utf16le' ? Buffer.from('\uFEFF' + json, 'utf16le')
    : Buffer.from(encoding === 'utf8-bom' ? '\uFEFF' + json : json);
  await fs.writeFile(file, bytes);
  return loadConfig(file);
}

// Fixed local matrix. Negative cases below do not contribute to the compatibility rate.
for (const mode of ['http', 'ws']) {
  for (const host of ['127.0.0.1', '::1']) {
    for (const encoding of ['utf8', 'utf8-bom', 'utf16le']) {
      for (const delayed of [false, true]) {
        for (const authenticated of [false, true]) {
          const name = ['matrix', mode, host, encoding, delayed ? 'delayed' : 'immediate',
            authenticated ? 'authenticated' : 'local'].join(' ');
          test(name, testOptions, async (t) => {
            const mock = await mockUpstream(t, { mode, host, delayed, authenticated });
            const config = await fixtureConfig(t, mock.config, encoding);
            const bridge = createBridge(config);
            const peerConnected = once(mock.ws, 'connection');
            t.after(() => bridge.close());
            const endpoints = await bridge.listen();
            const client = new WebSocket(endpoints.wsUrl, { headers: { authorization: 'Bearer ' + bridgeToken } });
            t.after(() => client.terminate());
            await once(client, 'open');

            const call = async (action, params = {}) => {
              const response = await fetch(endpoints.httpUrl + '/' + action, {
                method: 'POST', headers: { authorization: 'Bearer ' + bridgeToken, 'content-type': 'application/json' },
                body: JSON.stringify(params), signal: AbortSignal.timeout(3000)
              });
              assert.equal(response.status, 200);
              return response.json();
            };
            assert.equal((await call('get_status')).data.online, true);
            const [peer] = await peerConnected;
            const received = once(client, 'message');
            peer.send(JSON.stringify({ post_type: 'message', message_type: 'private', self_id: 101, message_id: 9001 }));
            assert.equal(JSON.parse((await received)[0]).message_id, 9001);
            assert.equal((await call('send_private_msg', { user_id: 102, message: 'fixture message' })).data.message_id, 7001);
            const sends = mock.calls.filter(row => row.action === 'send_private_msg');
            assert.deepEqual(sends, [{ action: 'send_private_msg', transport: mode === 'http' ? 'http' : 'websocket' }]);
          });
        }
      }
    }
  }
}

function startBackend(t, raw) {
  const backend = new Backend(normalizeConfig(raw));
  t.after(() => backend.close());
  backend.start(() => {});
  return backend;
}

test('matches reverse-order upstream replies to concurrent WebSocket calls', testOptions, async (t) => {
  const replies = [];
  const mock = await mockUpstream(t, {
    onRequest(request) {
      replies.push(request);
      if (replies.length === 2) {
        for (const row of replies.reverse()) row.send({ status: 'ok', retcode: 0, echo: row.echo, data: row.action });
      }
      return true;
    }
  });
  const backend = startBackend(t, mock.config);
  const [a, b] = await Promise.all([backend.call('get_status', {}), backend.call('get_login_info', {})]);
  assert.equal(a.data, 'get_status');
  assert.equal(b.data, 'get_login_info');
});

test('WebSocket handshake rejection fails calls without retrying authentication', testOptions, async (t) => {
  const mock = await mockUpstream(t);
  mock.config.backend.wsToken = 'incorrect-fixture-token';
  const backend = startBackend(t, mock.config);
  await assert.rejects(backend.call('get_status', {}), { code: 'UPSTREAM_WS_AUTH_FAILED' });
  assert.equal(backend.snapshot().ws, 'auth_failed');
  assert.equal(backend.snapshot().reconnects, 0);
  assert.deepEqual(mock.calls, []);
});

test('unconfirmed WebSocket writes are not replayed after reconnect', testOptions, async (t) => {
  let firstWrite = true;
  const mock = await mockUpstream(t, {
    onRequest({ action, socket }) {
      if (action !== 'send_private_msg' || !firstWrite) return false;
      firstWrite = false;
      socket.terminate();
      return true;
    }
  });
  const backend = startBackend(t, mock.config);
  await backend.call('get_status', {});
  await assert.rejects(backend.call('send_private_msg', { user_id: 102, message: 'fixture message' }), {
    code: 'UPSTREAM_WS_DISCONNECTED', delivery: 'unknown'
  });
  assert.equal((await backend.call('get_status', {})).data.online, true);
  assert.equal(mock.calls.filter(row => row.action === 'send_private_msg').length, 1);
});

test('WebSocket API replies have a deadline and a new query can complete after a timeout', testOptions, async (t) => {
  const mock = await mockUpstream(t, { onRequest: ({ action }) => action === 'get_uncorrelated_status' });
  mock.config.requestTimeoutMs = 250;
  const backend = startBackend(t, mock.config);
  assert.equal((await backend.call('get_status', {})).data.online, true);
  await assert.rejects(backend.call('get_uncorrelated_status', {}), { code: 'UPSTREAM_TIMEOUT' });
  assert.equal((await backend.call('get_status', {})).data.online, true);
});

test('an event-only or API-only address is insufficient for WebSocket-only mode', () => {
  for (const route of ['/event/', '/api/']) {
    assert.throws(() => normalizeConfig({
      listen: { token: bridgeToken },
      backend: { type: 'onebot', wsUrl: 'ws://127.0.0.1:5700' + route }
    }), /universal WebSocket/);
  }
});

test('a write requested during handshake is not queued for a later WebSocket', testOptions, async (t) => {
  const mock = await mockUpstream(t, { delayed: true });
  const backend = startBackend(t, mock.config);
  await assert.rejects(backend.call('send_private_msg', { user_id: 102, message: 'fixture message' }), {
    code: 'UPSTREAM_WS_NOT_READY'
  });
  assert.equal((await backend.call('get_status', {})).data.online, true);
  assert.deepEqual(mock.calls, [{ action: 'get_status', transport: 'websocket' }]);
});

test('an unavailable configured HTTP API is not silently replaced with WebSocket writes', testOptions, async (t) => {
  const mock = await mockUpstream(t, { mode: 'http' });
  mock.config.backend.httpToken = 'incorrect-fixture-token';
  const backend = startBackend(t, mock.config);
  await once(backend.socket, 'open');
  await assert.rejects(backend.call('send_private_msg', { user_id: 102, message: 'fixture message' }), {
    code: 'UPSTREAM_HTTP_401'
  });
  assert.equal(backend.snapshot().apiTransport, 'http');
  assert.deepEqual(mock.calls, []);
});

test('shutdown clears WebSocket requests and their timeout state', testOptions, async (t) => {
  const received = Promise.withResolvers();
  const mock = await mockUpstream(t, {
    onRequest({ action }) {
      if (action !== 'get_suspended_status') return false;
      received.resolve();
      return true;
    }
  });
  const backend = startBackend(t, mock.config);
  const request = backend.call('get_suspended_status', {});
  const rejected = assert.rejects(request, { code: 'UPSTREAM_WS_STOPPED' });
  await received.promise;
  await backend.close();
  await rejected;
  assert.equal(backend.snapshot().receiveReady, false);
  assert.equal(backend.controllers.size, 0);
  assert.equal(backend.wsRequests.size, 0);
});

test('heartbeats alone do not advertise API readiness in WebSocket-only mode', testOptions, async (t) => {
  const mock = await mockUpstream(t);
  const bridge = createBridge(mock.config);
  t.after(() => bridge.close());
  const connected = once(mock.ws, 'connection');
  const endpoints = await bridge.listen();
  const [peer] = await connected;
  const consumer = new WebSocket(endpoints.wsUrl, { headers: { authorization: 'Bearer ' + bridgeToken } });
  t.after(() => consumer.terminate());
  await once(consumer, 'open');
  const forwarded = once(consumer, 'message');
  peer.send(JSON.stringify({
    post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true }, self_id: 101
  }));
  await forwarded;

  assert.equal(bridge.status().backend.qqOnline, true);
  assert.equal(bridge.status().ready, false);
  await bridge.backend.call('get_status', {});
  assert.equal(bridge.status().ready, true);
});

for (const mode of ['http', 'ws']) {
  test('a stalled status API clears bridge readiness with an active ' + mode + ' event channel', testOptions, async (t) => {
    let stalled = false;
    const mock = await mockUpstream(t, { mode, onRequest: ({ action }) => stalled && action === 'get_status' });
    const bridge = createBridge({ ...mock.config, requestTimeoutMs: 250 });
    t.after(() => bridge.close());
    await bridge.listen();
    if (!bridge.backend.snapshot().receiveReady) await once(bridge.backend.socket, 'open');

    await bridge.backend.call('get_status', {});
    assert.equal(bridge.status().ready, true);
    stalled = true;
    await assert.rejects(bridge.backend.call('get_status', {}), { code: 'UPSTREAM_TIMEOUT' });
    assert.equal(bridge.status().backend.receiveReady, true);
    assert.equal(bridge.status().ready, false);

    stalled = false;
    await bridge.backend.call('get_status', {});
    assert.equal(bridge.status().ready, true);
  });
}
