import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from '../vendor/ws/wrapper.mjs';
import { loadConfig, normalizeConfig } from '../src/config.mjs';
import { createManagement } from '../src/management.mjs';
import { createOutboundTransports } from '../src/outbound-transports.mjs';
import { createBridge } from '../src/server.mjs';
import { NativeBackend } from '../src/native-backend.mjs';
import { BridgeError } from '../src/backend.mjs';
import manifest from '../package.json' with { type: 'json' };

const token = 'test-alcor-token-01';
const run = promisify(execFile);

function configFor(port, host = '127.0.0.1') {
  return {
    listen: { host, port: 0, token },
    backend: { type: 'onebot', httpUrl: 'http://127.0.0.1:' + port, wsUrl: 'ws://127.0.0.1:' + port },
    requestTimeoutMs: 1000
  };
}

async function tempDirectory(t) {
  const parent = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'alcor-core-service-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(directory)), parent);
    await fs.rm(directory, { recursive: true });
  });
  return directory;
}

async function upstream(t, handle) {
  const server = http.createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    if (handle?.(req, res)) return;
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { online: true }, echo: 'upstream-only' }));
  });
  const ws = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const peer of ws.clients) peer.terminate();
    ws.close();
    await new Promise(resolve => server.close(resolve));
  });
  return { port: server.address().port, ws };
}

async function bridgeWith(t, options = {}) {
  const mock = await upstream(t);
  const backendConnected = once(mock.ws, 'connection');
  const bridge = createBridge(configFor(mock.port, options.host));
  t.after(() => bridge.close());
  const endpoints = await bridge.listen();
  const [upstreamSocket] = await backendConnected;
  return { bridge, upstreamSocket, ...endpoints };
}

async function socketAt(t, url) {
  const socket = new WebSocket(url, { headers: { authorization: 'Bearer ' + token } });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  return socket;
}

test('accepts bracketed IPv6 in config and uses bare IPv6 for binding', () => {
  const configuration = normalizeConfig(configFor(5311, '[::1]'));
  assert.equal(configuration.listen.host, '::1');
});

test('an identity failure keeps its original wording even when a module is present', async () => {
  for (const row of [{ alcorHostLoaded: true }, { foreignModules: ['fixture'] }]) {
    let attempts = 0;
    const manager = createManagement({ config: { backend: { type: 'native' } },
      inventory: async () => [{ pid: 123, ...row }],
      backend: { controller: {}, connect: async () => { attempts++; throw new Error('QQ_LOGIN_NOT_CONFIRMED'); } } });
    await assert.rejects(manager.handle('native/connect', 'POST', { pid: 123 }), { code: 'QQ_LOGIN_NOT_CONFIRMED' });
    assert.equal(attempts, 1);
    const { entries } = await manager.handle('logs', 'GET');
    assert.match(entries.at(-1).message, /QQ_LOGIN_NOT_CONFIRMED/);
  }
});

test('native check needs a verified listener, online account and ready event channel', async t => {
  const directory = await tempDirectory(t);
  const configFile = path.join(directory, 'isolated.json');
  const backend = { type: 'native', connected: true, qqOnline: false, receiveReady: true, serviceBound: false };
  const health = { name: 'Alcor', listening: true, ready: false, backend };
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push([req.method, req.url]);
    res.end(JSON.stringify(health));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await fs.writeFile(configFile, JSON.stringify({ listen: { port: server.address().port, token }, backend: { type: 'native' } }));
  const check = () => run(process.execPath, [fileURLToPath(new URL('../src/main.mjs', import.meta.url)), '--check', '--config', configFile]);
  await assert.rejects(check(), { code: 2 });
  health.ready = true;
  await assert.rejects(check(), { code: 2 });
  backend.qqOnline = true;
  backend.receiveReady = false;
  await assert.rejects(check(), { code: 2 });
  backend.receiveReady = true;
  backend.serviceBound = true;
  const { stdout } = await check();
  assert.equal(JSON.parse(stdout).ready, true);
  assert.equal(JSON.parse(stdout).messagesSent, 0);
  health.name = 'fixture';
  await assert.rejects(check(), { code: 1 });
  assert.deepEqual(requests, Array.from({ length: 5 }, () => ['GET', '/health']));
});

// Exercise the public Alcor listener. Nothing in these tests opens or connects to a desktop process.
async function nativeInterfaceFixture(t, call, snapshot = { type: 'native', connected: true, receiveReady: true, qqOnline: true }) {
  let publish;
  t.mock.method(NativeBackend.prototype, 'start', callback => { publish = callback; });
  t.mock.method(NativeBackend.prototype, 'close', async () => {});
  t.mock.method(NativeBackend.prototype, 'call', call);
  t.mock.method(NativeBackend.prototype, 'snapshot', () => snapshot);
  const bridge = createBridge({ listen: { port: 0, token }, backend: { type: 'native' },
    readOnly: false, clientTimeoutMs: 200 });
  t.after(() => bridge.close());
  const endpoints = await bridge.listen();
  return { bridge, ...endpoints, publish, socket: await socketAt(t, endpoints.wsUrl) };
}

for (const transport of ['http', 'ws']) {
  test('native listener preserves the event stream and identifies an unconfirmed ' + transport + ' send', { timeout: 5000 }, async t => {
    let release;
    let attempts = 0;
    const pending = new Promise(resolve => { release = resolve; });
    const { httpUrl, socket, publish, bridge } = await nativeInterfaceFixture(t, async action => {
      assert.equal(action, 'send_private_msg');
      attempts++;
      return pending;
    });
    t.after(() => release({ status: 'ok', retcode: 0, data: { message_id: 88 } }));
    const request = { action: 'send_private_msg', params: { user_id: 102, message: 'fixture' }, echo: 'slow-send' };
    const frames = [];
    socket.on('message', chunk => frames.push(JSON.parse(chunk)));
    let reply;
    if (transport === 'http') {
      const response = await fetch(httpUrl, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(request) });
      assert.equal(response.status, 504);
      reply = await response.json();
    } else {
      socket.send(JSON.stringify(request));
      await t.waitFor(() => assert.ok(frames.length), { timeout: 1200 });
      reply = frames[0];
    }
    assert.deepEqual([reply.wording, reply.delivery, reply.echo], ['CLIENT_TIMEOUT', 'unknown', 'slow-send']);
    assert.equal(bridge.status().activeRequests, 1, 'the underlying send is still outstanding');
    const received = once(socket, 'message');
    publish({ post_type: 'message', message_type: 'private', self_id: 101, user_id: 102, message_id: 89 });
    assert.equal(JSON.parse((await received)[0]).message_id, 89);
    release({ status: 'ok', retcode: 0, data: { message_id: 88 } });
    await t.waitFor(() => assert.equal(bridge.status().activeRequests, 0));
    const next = once(socket, 'message');
    socket.send(JSON.stringify({ action: 'get_version_info', echo: 'next' }));
    assert.equal(JSON.parse((await next)[0]).echo, 'next');
    assert.equal(frames.filter(row => row.echo === 'slow-send').length, transport === 'ws' ? 1 : 0);
    assert.equal(attempts, 1);
  });
}

test('native listener forwards private and group events and returns a distinct confirmed receipt for each send', async t => {
  const sends = [];
  const { httpUrl, socket, publish } = await nativeInterfaceFixture(t, async (action, params) => {
    sends.push({ action, params });
    return { status: 'ok', retcode: 0, data: { message_id: 100 + sends.length } };
  });
  for (const [index, type] of ['private', 'group'].entries()) {
    const address = type === 'group' ? { group_id: 103 } : { user_id: 102 };
    const event = { post_type: 'message', message_type: type, ...address, self_id: 101, message_id: index + 1, raw_message: 'incoming fixture' };
    const received = once(socket, 'message');
    publish(event);
    assert.deepEqual(JSON.parse((await received)[0]), event);
    const action = 'send_' + type + '_msg';
    const params = { ...address, message: 'outgoing fixture' };
    const response = await fetch(httpUrl + '/' + action, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(params) });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, { message_id: 101 + index });
    assert.deepEqual(sends[index], { action, params });
  }
  assert.equal(sends.length, 2);
});

test('an explicit unconfirmed receipt reaches the HTTP caller and leaves an unbound native session unready', async t => {
  let attempts = 0;
  const snapshot = { type: 'native', connected: true, receiveReady: true, qqOnline: false, serviceBound: false, events: 0 };
  const { httpUrl, bridge } = await nativeInterfaceFixture(t, async action => {
    assert.equal(action, 'send_private_msg');
    attempts++;
    throw new BridgeError('NATIVE_SEND_UNCONFIRMED', 502, 'unknown');
  }, snapshot);
  const response = await fetch(httpUrl + '/send_private_msg', { method: 'POST',
    headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ user_id: 102, message: 'fixture' }) });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.deepEqual([body.status, body.data, body.wording, body.delivery], ['failed', null, 'NATIVE_SEND_UNCONFIRMED', 'unknown']);
  assert.equal(bridge.status().ready, false);
  assert.equal(bridge.status().backend.events, 0);
  assert.equal(attempts, 1);
});

test('native message sends only report success for a usable message receipt', async t => {
  const samples = [
    { body: { status: 'failed', retcode: 502, wording: 'NATIVE_SEND_UNCONFIRMED' }, status: 502 },
    { error: new BridgeError('NATIVE_SEND_UNCONFIRMED', 502), status: 502 },
    { body: { status: 'failed', retcode: 502, code: 'NATIVE_SEND_UNCONFIRMED' }, status: 502 },
    { body: { status: 'ok', retcode: 0, data: null }, status: 502 },
    { body: { status: 'ok', retcode: 0, data: { message_id: 0 } }, status: 502 },
    { body: { status: 'ok', retcode: 0, data: { message_id: {} } }, status: 502 },
    { body: { status: 'ok', retcode: 0, delivery: 'unknown', data: { message_id: 75 } }, status: 502 },
    { body: { status: 'ok', retcode: 0, data: { message_id: 515 } }, status: 200 },
    { body: { status: 'ok', retcode: 0, data: { message_id: '-51' } }, status: 200 }
  ];
  let calls = 0;
  const { httpUrl } = await nativeInterfaceFixture(t, async () => {
    const sample = samples[calls++];
    if (sample.error) throw sample.error;
    return sample.body;
  });
  for (const [index, sample] of samples.entries()) {
    const reply = await fetch(httpUrl, { method: 'POST', headers: { authorization: 'Bearer ' + token },
      body: JSON.stringify({ action: index % 2 ? 'send_private_msg' : 'send_group_msg', params: {}, echo: index }) });
    const body = await reply.json();
    assert.equal(reply.status, sample.status);
    assert.equal(body.echo, index);
    if (sample.status === 502) {
      assert.deepEqual([body.status, body.wording, body.delivery, body.data], ['failed', 'NATIVE_SEND_UNCONFIRMED', 'unknown', null]);
    } else {
      assert.deepEqual(body.data, sample.body.data);
    }
    assert.equal(calls, index + 1);
  }
});

test('bridge info reports only a valid account and a successful login query', async t => {
  let login;
  const { httpUrl } = await nativeInterfaceFixture(t, async action => action === 'get_login_info' ? login :
    { status: 'ok', retcode: 0, data: {} });
  for (const [id, retcode, expected] of [[0, 0, null], [null, 0, null], ['unknown', 0, null],
    [['123456'], 0, null], ['123456', 12, null], [123456, 0, '3456']]) {
    login = { status: 'ok', retcode, data: { user_id: id } };
    const res = await fetch(httpUrl + '/get_bridge_info', { headers: { authorization: 'Bearer ' + token } });
    const { data } = await res.json();
    assert.equal(data.accountLastFour, expected);
    assert.equal(data.backendQueriesSucceeded, retcode === 0);
  }
});

test('reads a UTF-8 BOM in Alcor and imported OneBot JSON files', async (t) => {
  const directory = await tempDirectory(t);
  const file = path.join(directory, 'alcor.json');
  const config = configFor(5311);
  config.backend.wsUrl = 'ws://127.0.0.1:5312';
  config.backend.onebotConfigFile = '连接设置.json';
  await fs.writeFile(file, '\uFEFF' + JSON.stringify(config));
  await fs.writeFile(path.join(directory, config.backend.onebotConfigFile), '\uFEFF' + JSON.stringify({
    network: { httpServers: [{ port: 5311, token: 'http-fixture' }], wsServers: [{ port: 5312, token: 'ws-fixture' }] }
  }));
  const parsed = loadConfig(file);
  assert.equal(parsed.backend.httpToken, 'http-fixture');
  assert.equal(parsed.backend.wsToken, 'ws-fixture');
});

test('imports secure loopback endpoints and ignores disabled duplicate profiles', async (t) => {
  const directory = await tempDirectory(t);
  const file = path.join(directory, 'alcor.json');
  const config = configFor(5311);
  config.backend.httpUrl = 'https://localhost:5311';
  config.backend.wsUrl = 'wss://localhost:5312/events';
  config.backend.onebotConfigFile = 'onebot.json';
  await fs.writeFile(file, JSON.stringify(config));
  await fs.writeFile(path.join(directory, 'onebot.json'), JSON.stringify({
    networks: {
      httpServers: [{ enable: false, port: 5311, token: 'inactive' }, { enable: true, port: 5311, token: 'http-fixture' }],
      wsServers: [{ port: 5312, accessToken: 'ws-fixture' }]
    }
  }));
  const parsed = loadConfig(file);
  assert.equal(parsed.backend.httpToken, 'http-fixture');
  assert.equal(parsed.backend.wsUrl, 'wss://localhost:5312/events');
  assert.equal(parsed.backend.wsToken, 'ws-fixture');
});

test('rejects a backend endpoint that would connect to the same bridge listener', () => {
  const config = configFor(5311);
  config.listen.port = 5311;
  assert.throws(() => normalizeConfig(config), /backend\.httpUrl/);
});

test('imports tokens for the selected loopback address when both families use the same port', async t => {
  const directory = await tempDirectory(t);
  const file = path.join(directory, 'alcor.json');
  const config = configFor(5311);
  config.backend.onebotConfigFile = 'onebot.json';
  config.backend.httpUrl = 'http://127.0.0.1:5311';
  config.backend.wsUrl = 'ws://[::1]:5311';
  const entries = [{ host: '[::1]', port: 5311, token: 'v6-fixture' }, { host: '127.0.0.1', port: 5311, token: 'v4-fixture' }];
  await fs.writeFile(file, JSON.stringify(config));
  await fs.writeFile(path.join(directory, 'onebot.json'), JSON.stringify({ network: { httpServers: entries, wsServers: entries } }));
  assert.equal(loadConfig(file).backend.httpToken, 'v4-fixture');
  assert.equal(loadConfig(file).backend.wsToken, 'v6-fixture');
  config.backend.wsUrl = 'ws://localhost:5311';
  await fs.writeFile(file, JSON.stringify(config));
  assert.throws(() => loadConfig(file), /ambiguous or missing/);
  config.backend.wsUrl = 'ws://[::1]:5311';
  await fs.writeFile(file, JSON.stringify(config));
  await fs.writeFile(path.join(directory, 'onebot.json'), JSON.stringify({ network: { httpServers: entries, wsServers: [entries[1]] } }));
  assert.throws(() => loadConfig(file), /ambiguous or missing/);
});

test('reports the installed package version through health and OneBot', async (t) => {
  const { httpUrl } = await bridgeWith(t);
  const headers = { authorization: 'Bearer ' + token };
  const health = await fetch(httpUrl + '/health', { headers }).then(res => res.json());
  const info = await fetch(httpUrl + '/get_version_info', { headers }).then(res => res.json());
  assert.equal(health.version, manifest.version);
  assert.equal(info.data.app_version, manifest.version);
});

test('accepts standard WebSocket event and API paths and keeps their traffic separate', { timeout: 5000 }, async (t) => {
  const { wsUrl, upstreamSocket } = await bridgeWith(t);
  const base = new URL(wsUrl).origin;
  const events = await socketAt(t, base + '/event/');
  const api = await socketAt(t, base + '/api/');
  const eventResponse = once(events, 'message');
  const apiResponse = once(api, 'message');
  upstreamSocket.send(JSON.stringify({ post_type: 'message', self_id: 1, message_id: 44 }));
  const [event] = await eventResponse;
  assert.equal(JSON.parse(event).message_id, 44);
  api.send(JSON.stringify({ action: 'get_status', echo: 72 }));
  const [reply] = await apiResponse;
  assert.equal(JSON.parse(reply).echo, 72);
  assert.equal(JSON.parse(reply).status, 'ok');
});

test('uses only local request echo for a proxied response', async (t) => {
  const { httpUrl } = await bridgeWith(t);
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const call = body => fetch(httpUrl + '/', { method: 'POST', headers, body: JSON.stringify(body) }).then(res => res.json());
  const noEcho = await call({ action: 'get_status' });
  const withEcho = await call({ action: 'get_status', echo: { correlation: 'same' } });
  assert.equal(Object.hasOwn(noEcho, 'echo'), false);
  assert.deepEqual(withEcho.echo, { correlation: 'same' });
});

test('preserves the previous settings when the atomic save fails', async (t) => {
  const directory = await tempDirectory(t);
  const stateFile = path.join(directory, 'settings.json');
  await fs.mkdir(stateFile);
  const management = createManagement({ config: normalizeConfig(configFor(5311)), stateFile });
  assert.equal((await management.handle('settings', 'GET')).theme, 'system');
  await assert.rejects(management.handle('settings', 'POST', { theme: 'dark' }));
  assert.equal((await management.handle('settings', 'GET')).theme, 'system');
});

test('closing during startup leaves no listening bridge and cannot be restarted', async (t) => {
  const mock = await upstream(t);
  const source = [
    "import assert from 'node:assert/strict';",
    "const { createBridge } = await import(" + JSON.stringify(new URL('../src/server.mjs', import.meta.url).href) + ");",
    "const bridge = createBridge(" + JSON.stringify(configFor(mock.port)) + ");",
    "try {",
    "  const starting = bridge.listen().then(() => 'started', (error) => error.code);",
    "  await bridge.close();",
    "  assert.equal(await starting, 'SHUTTING_DOWN');",
    "  assert.equal(bridge.status().listening, false);",
    "  await assert.rejects(bridge.listen(), { code: 'SHUTTING_DOWN' });",
    "} catch (error) { console.error(error); process.exit(1); }"
  ].join('\n');
  await run(process.execPath, ['--input-type=module', '--eval', source], { timeout: 5000 });
});

test('preserves previously staged node values across partial saves', async (t) => {
  const directory = await tempDirectory(t);
  const configFile = path.join(directory, 'alcor.json');
  const config = configFor(5311);
  config.listen.port = 5310;
  await fs.writeFile(configFile, JSON.stringify(config));
  const management = createManagement({ config: normalizeConfig(config), configFile });
  await management.handle('nodes', 'POST', { host: '::1' });
  await management.handle('nodes', 'POST', { readOnly: false });
  const staged = await management.handle('nodes', 'GET');
  assert.equal(staged.pending.host, '::1');
  assert.equal(staged.pending.readOnly, false);
  assert.equal(loadConfig(configFile).listen.host, '::1');
});

test('validates callbacks against the staged listener port', async (t) => {
  const directory = await tempDirectory(t);
  const configFile = path.join(directory, 'alcor.json');
  const config = configFor(5311);
  config.listen.port = 5310;
  await fs.writeFile(configFile, JSON.stringify(config));
  const management = createManagement({ config: normalizeConfig(config), configFile });
  await management.handle('nodes', 'POST', { port: 5318 });
  await assert.rejects(management.handle('transports', 'POST', {
    httpCallbacks: [{ url: 'http://127.0.0.1:5318/events' }], reverseWebSockets: []
  }), { code: 'INVALID_MANAGEMENT_SETTINGS' });
  assert.deepEqual(loadConfig(configFile).httpCallbacks, []);
});

test('accepts an HTTP callback response without parsing the body when replies are disabled', async (t) => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-length': '70000' });
    res.end('x'.repeat(70_000));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = normalizeConfig({
    ...configFor(server.address().port),
    httpCallbacks: [{ url: 'http://127.0.0.1:' + server.address().port, quickReply: false }]
  });
  const transports = createOutboundTransports(config, {
    getAccount: async () => '101',
    execute: async () => assert.fail('disabled quick replies must never execute actions')
  });
  t.after(() => transports.close());
  transports.publish({ self_id: 101, post_type: 'message', message_type: 'private', user_id: 102 });
  const deadline = Date.now() + 1000;
  while (transports.snapshot().httpCallbacks[0].pending && Date.now() < deadline) await delay(10);
  assert.equal(transports.snapshot().httpCallbacks[0].delivered, 1);
  assert.equal(transports.snapshot().httpCallbacks[0].failed, 0);
});

test('reads UTF-16 local configuration written by Windows editors', async (t) => {
  const directory = await tempDirectory(t);
  const file = path.join(directory, 'alcor.json');
  const configuration = configFor(5311);
  await fs.writeFile(file, Buffer.from('\uFEFF' + JSON.stringify(configuration), 'utf16le'));
  assert.equal(loadConfig(file).listen.host, '127.0.0.1');
});

test('correlates a timed-out reverse WebSocket query with its original echo', { timeout: 5000 }, async (t) => {
  const mock = await upstream(t, (req, res) => {
    if (req.url === '/get_login_info') {
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 101 } }));
      return true;
    }
    return req.url === '/get_delayed_status';
  });
  const receiver = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  t.after(() => {
    for (const client of receiver.clients) client.terminate();
    receiver.close();
  });
  await once(receiver, 'listening');
  const reverseConnected = once(receiver, 'connection');
  const upstreamConnected = once(mock.ws, 'connection');
  const bridge = createBridge({
    ...configFor(mock.port),
    clientTimeoutMs: 80,
    reverseWebSockets: [{ url: 'ws://127.0.0.1:' + receiver.address().port }]
  });
  t.after(() => bridge.close());
  await bridge.listen();
  const [upstreamSocket] = await upstreamConnected;
  upstreamSocket.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', self_id: 101 }));
  const [client] = await reverseConnected;
  const response = once(client, 'message');
  client.send(JSON.stringify({ action: 'get_delayed_status', echo: 'request-42' }));
  const [data] = await response;
  const reply = JSON.parse(data);
  assert.equal(reply.wording, 'CLIENT_TIMEOUT');
  assert.equal(reply.echo, 'request-42');
});

test('serves authenticated health over an IPv6 loopback listener', async (t) => {
  const mock = await upstream(t);
  const bridge = createBridge(configFor(mock.port, '[::1]'));
  t.after(() => bridge.close());
  let endpoints;
  try {
    endpoints = await bridge.listen();
  } catch (error) {
    if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(error.code)) throw error;
    t.skip('IPv6 loopback is unavailable on this runner');
    return;
  }
  assert.equal(new URL(endpoints.httpUrl).hostname, '[::1]');
  const unauthorized = await fetch(endpoints.httpUrl + '/health');
  assert.equal(unauthorized.status, 401);
  await unauthorized.body.cancel();
  const authorized = await fetch(endpoints.httpUrl + '/health', {
    headers: { authorization: 'Bearer ' + token }
  });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).listening, true);
});

test('the existing /events connection still supports requests and events', { timeout: 5000 }, async (t) => {
  const { wsUrl, upstreamSocket } = await bridgeWith(t);
  const client = await socketAt(t, wsUrl);
  const eventMessage = once(client, 'message');
  upstreamSocket.send(JSON.stringify({ post_type: 'message', self_id: 1, message_id: 91 }));
  const [event] = await eventMessage;
  assert.equal(JSON.parse(event).message_id, 91);
  const replyMessage = once(client, 'message');
  client.send(JSON.stringify({ action: 'get_version_info', echo: 'legacy-client' }));
  const [reply] = await replyMessage;
  assert.equal(JSON.parse(reply).echo, 'legacy-client');
  assert.equal(JSON.parse(reply).data.app_version, manifest.version);
});
