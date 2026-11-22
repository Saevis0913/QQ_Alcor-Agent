import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from '../vendor/ws/wrapper.mjs';
import { loadConfig, normalizeConfig } from '../src/config.mjs';
import { createManagement } from '../src/management.mjs';
import { createOutboundTransports } from '../src/outbound-transports.mjs';
import { createBridge } from '../src/server.mjs';
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
