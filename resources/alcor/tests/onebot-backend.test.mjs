import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { Backend } from '../src/backend.mjs';
import { WebSocketServer } from '../vendor/ws/wrapper.mjs';

const token = 'mock-upstream-token';
const testOptions = { timeout: 5000 };

async function mockBackend(t, handleRequest = (_request, response) => response.writeHead(404).end()) {
  const server = http.createServer(handleRequest);
  const webSockets = new WebSocketServer({
    server,
    verifyClient: ({ req }) => req.headers.authorization === `Bearer ${token}`
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;

  const { port } = server.address();
  const backend = new Backend({
    backend: { httpUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}`, wsToken: token },
    requestTimeoutMs: 3000,
    sendTimeoutMs: 3000,
    maxResponseBytes: 65536,
    maxJsonDepth: 16,
    wsHeartbeatMs: 1000,
    reconnectMinMs: 1000,
    reconnectMaxMs: 1000
  });
  t.after(async () => {
    await backend.close();
    for (const peer of webSockets.clients) peer.terminate();
    const wsClosed = new Promise(resolve => webSockets.close(resolve));
    const httpClosed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await Promise.all([wsClosed, httpClosed]);
  });

  const events = new EventEmitter();
  return {
    backend,
    async connect() {
      const peerConnected = once(webSockets, 'connection');
      backend.start(event => events.emit('event', event));
      const [[peer]] = await Promise.all([peerConnected, once(backend.socket, 'open')]);
      return peer;
    },
    async sendEvent(peer, event) {
      const received = once(events, 'event');
      peer.send(JSON.stringify(event));
      await received;
    }
  };
}

function heartbeat(online) {
  return { time: 1, self_id: 10000, post_type: 'meta_event', meta_event_type: 'heartbeat',
    status: { online, good: true }, interval: 5000 };
}

function sendStatus(response, online) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { online, good: true } }));
}

test('uses boolean online status from authenticated OneBot heartbeats', testOptions, async t => {
  const { backend, connect, sendEvent } = await mockBackend(t);
  const peer = await connect();
  assert.equal(backend.snapshot().qqOnline, null);

  await sendEvent(peer, heartbeat(true));
  assert.equal(backend.snapshot().qqOnline, true);
  await sendEvent(peer, heartbeat(false));
  assert.equal(backend.snapshot().qqOnline, false);
  await sendEvent(peer, heartbeat('true'));
  assert.equal(backend.snapshot().qqOnline, false);
  await sendEvent(peer, { ...heartbeat(true), meta_event_type: 'lifecycle', sub_type: 'connect' });
  assert.equal(backend.snapshot().qqOnline, false);
});

test('reports receive readiness while the socket is open and clears it on shutdown', testOptions, async t => {
  const { backend, connect } = await mockBackend(t, (_request, response) => sendStatus(response, true));
  assert.equal(backend.snapshot().receiveReady, false);

  await connect();
  assert.equal(backend.snapshot().receiveReady, true);
  await backend.call('get_status', {});
  assert.equal(backend.snapshot().qqOnline, true);

  await backend.close();
  assert.equal(backend.snapshot().receiveReady, false);
  assert.equal(backend.snapshot().qqOnline, null);
});

test('keeps confirmed online status when an unrelated HTTP query fails', testOptions, async t => {
  const { backend, connect } = await mockBackend(t, (request, response) => {
    if (request.url === '/get_status') sendStatus(response, true);
    else response.writeHead(503).end();
  });
  await connect();
  await backend.call('get_status', {});

  await assert.rejects(backend.call('get_version_info', {}), { code: 'UPSTREAM_HTTP_503' });
  assert.equal(backend.snapshot().http, 'failed');
  assert.equal(backend.snapshot().qqOnline, true);
});

test('ignores an HTTP status response from a disconnected WebSocket session', testOptions, async t => {
  const pendingResponse = Promise.withResolvers();
  let first = true;
  const { backend, connect } = await mockBackend(t, (_request, response) => {
    if (first) {
      first = false;
      sendStatus(response, true);
    } else {
      pendingResponse.resolve(response);
    }
  });
  const peer = await connect();
  await backend.call('get_status', {});
  assert.equal(backend.snapshot().qqOnline, true);

  const result = backend.call('get_status', {});
  const response = await pendingResponse.promise;
  const disconnected = once(backend.socket, 'close');
  peer.terminate();
  await disconnected;
  assert.equal(backend.snapshot().qqOnline, null);

  sendStatus(response, true);
  assert.equal((await result).data.online, true);
  assert.equal(backend.snapshot().qqOnline, null);
});

test('accepts UTF-8 BOM JSON replies from a local HTTP backend', testOptions, async t => {
  const { backend, connect } = await mockBackend(t, (_req, res) => {
    res.end('\uFEFF' + JSON.stringify({ status: 'ok', retcode: 0, data: { online: true } }));
  });
  await connect();
  assert.equal((await backend.call('get_status', {})).data.online, true);
  assert.equal(backend.snapshot().qqOnline, true);
});

for (const [status, response, code, uncertain] of [
  [200, '<not-json>', 'UPSTREAM_INVALID_JSON', true],
  [503, '', 'UPSTREAM_HTTP_503', true],
  [403, '', 'UPSTREAM_HTTP_403', false]
]) {
  test('classifies delivery after HTTP ' + status + ' without repeating a send', testOptions, async t => {
    const calls = [];
    const { backend, connect } = await mockBackend(t, (req, res) => {
      calls.push(req.url);
      res.writeHead(status).end(response);
    });
    await connect();
    await assert.rejects(backend.call('send_private_msg', {}), error => {
      assert.equal(error.code, code);
      assert.equal(error.delivery, uncertain ? 'unknown' : undefined);
      return true;
    });
    await assert.rejects(backend.call('get_status', {}), error => error.code === code && error.delivery === undefined);
    assert.deepEqual(calls, ['/send_private_msg', '/get_status']);
  });
}

test('ignores an old socket close after the backend restarts', testOptions, async t => {
  const { backend, connect } = await mockBackend(t);
  await connect();

  const oldSocketClosed = once(backend.socket, 'close');
  const stopping = backend.close();
  await Promise.all([connect(), oldSocketClosed, stopping]);

  assert.equal(backend.snapshot().ws, 'open');
  assert.equal(backend.snapshot().reconnects, 0);
});
