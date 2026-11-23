import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onebotEditionEnabled, editionMarkerPath, enableOneBotEdition, disableOneBotEdition,
  readEditionRequest, connectionHitsPort } from '../src/onebot-edition.js';

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
