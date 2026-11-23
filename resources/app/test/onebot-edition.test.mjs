import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onebotEditionEnabled, editionMarkerPath, enableOneBotEdition, disableOneBotEdition,
  readEditionRequest, connectionHitsPort, probeOneBotConnection } from '../src/onebot-edition.js';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-edition-'));

test('enable writes the marker app.js checks and records the endpoints', () => {
  const installRoot = root();
  assert.equal(onebotEditionEnabled(installRoot), false);
  const saved = enableOneBotEdition({ installRoot, connection: { httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001' }, now: '2026-11-23T00:00:00.000Z' });
  assert.ok(onebotEditionEnabled(installRoot));
  assert.equal(saved.marker, editionMarkerPath(installRoot));
  const body = JSON.parse(fs.readFileSync(saved.marker, 'utf8'));
  assert.deepEqual(body, { edition: 'onebot', switchedInPlace: true, enabledAt: '2026-11-23T00:00:00.000Z',
    httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001' });
});

test('disable removes it, and removing twice is not an error', () => {
  const installRoot = root();
  enableOneBotEdition({ installRoot, connection: { httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001' } });
  disableOneBotEdition({ installRoot });
  assert.equal(onebotEditionEnabled(installRoot), false);
  assert.doesNotThrow(() => disableOneBotEdition({ installRoot }));
});

test('enable refuses a half connection', () => {
  const installRoot = root();
  assert.throws(() => enableOneBotEdition({ installRoot, connection: { httpUrl: 'http://127.0.0.1:3000' } }), /HTTP 与 WebSocket/);
  assert.equal(onebotEditionEnabled(installRoot), false);
});

test('request validation keeps the address on loopback and out of the URL credentials', () => {
  const good = readEditionRequest({ httpUrl: 'http://127.0.0.1:3000/', wsUrl: 'ws://127.0.0.1:3001' });
  assert.deepEqual(good, { httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001', accessToken: '', httpAccessToken: '',
    autoLaunch: false, dir: '', configFile: '' });
  assert.throws(() => readEditionRequest({ httpUrl: 'http://10.0.0.5:3000', wsUrl: 'ws://127.0.0.1:3001' }), /本机地址/);
  assert.throws(() => readEditionRequest({ httpUrl: 'http://token@127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001' }), /本机地址/);
  assert.throws(() => readEditionRequest({ httpUrl: 'http://127.0.0.1:3000' }), /WebSocket/);
  assert.throws(() => readEditionRequest(null), /格式无效/);
});

test('connectionHitsPort catches pointing the backend at the agent itself', () => {
  const connection = { httpUrl: 'http://127.0.0.1:5320', wsUrl: 'ws://127.0.0.1:3001' };
  assert.equal(connectionHitsPort(connection, 5320), true);
  assert.equal(connectionHitsPort(connection, 3001), true);
  assert.equal(connectionHitsPort(connection, 5321), false);
  assert.equal(connectionHitsPort({}, 5320), false);
});

test('probeOneBotConnection reports HTTP actions and the event channel separately', async () => {
  const http = await import('node:http');
  const { WebSocketServer } = await import('ws');
  let retcode = 0;
  const server = http.default.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(retcode === 0
        ? { status: 'ok', retcode: 0, data: { user_id: 2790528295, nickname: 'probe' } }
        : { status: 'failed', retcode, message: 'bad token' }));
    });
  });
  const wss = new WebSocketServer({ server, path: '/event' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const connection = { httpUrl: 'http://127.0.0.1:' + port, wsUrl: 'ws://127.0.0.1:' + port + '/event' };

  const good = await probeOneBotConnection(connection, { timeoutMs: 4000 });
  assert.equal(good.ok, true);
  assert.equal(good.http.account, '2790528295');
  assert.equal(good.ws.ok, true);
  assert.match(good.message, /2790528295/);

  retcode = 100;
  const rejected = await probeOneBotConnection(connection, { timeoutMs: 4000 });
  assert.equal(rejected.ok, false);
  assert.match(rejected.http.error, /retcode 100/);

  const offline = await probeOneBotConnection({ httpUrl: 'http://127.0.0.1:1', wsUrl: 'ws://127.0.0.1:1/event' }, { timeoutMs: 1500 });
  assert.equal(offline.ok, false);
  assert.ok(offline.http.error.length > 0 && offline.ws.error.length > 0);
  wss.close();
  await new Promise((resolve) => server.close(resolve));
});

