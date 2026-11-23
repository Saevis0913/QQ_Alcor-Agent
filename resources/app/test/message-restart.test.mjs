import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { OneBotClient } from '../src/onebot.js';
import { SendQueue } from '../src/sender.js';
import { waitFor } from './helpers/wait-for.mjs';

const workerFile = fileURLToPath(new URL('./fixtures/send-after-restart.mjs', import.meta.url));
const message = 'fixture-cross-restart-原文';
async function setup(t) {
  const tmp = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(tmp, 'alcor-receipt-test-'));
  const state = { account: 10001, calls: 0, mode: 'unknown' };
  const server = http.createServer((req, res) => {
    req.resume();
    let data = [];
    if (req.url === '/get_login_info') data = { user_id: state.account, nickname: 'fixture' };
    if (['/send_group_msg', '/send_private_msg'].includes(req.url)) {
      state.calls++;
      if (state.mode === 'hold' && state.calls === 1) { state.held = res; return; }
      if (state.mode === 'unknown') { res.writeHead(502); res.end('Bad Gateway'); return; }
      if (state.mode === 'deny') { res.writeHead(403); res.end('Forbidden'); return; }
      data = { message_id: -state.calls };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  });
  const ws = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ server: { startPaused: true }, allow: { private: ['10002'] },
    alcor: { httpUrl: 'http://127.0.0.1:' + port, wsUrl: 'ws://127.0.0.1:' + port, autoLaunch: false } }));
  const children = new Set();
  function start(entry = 'client', kind = 'private', target = '10002', text = message) {
    const child = spawn(process.execPath, [workerFile, kind, target, text, entry], {
      env: { ...process.env, ALCOR_AGENT_DATA_DIR: dir }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.add(child);
    let result, stderr = '';
    child.on('message', value => { result = value; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const exited = once(child, 'exit').then(([code]) => { children.delete(child); return { code, result, stderr }; });
    return { child, exited };
  }
  async function send(...args) {
    const { code, result, stderr } = await start(...args).exited;
    assert.equal(code, 0, stderr);
    assert.ok(result, stderr);
    return result;
  }
  t.after(async () => {
    for (const child of children) child.kill();
    for (const client of ws.clients) client.terminate();
    ws.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(await fs.realpath(dir)), tmp);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
  });
  return { dir, state, send, start };
}

test('unknown delivery survives a real process restart across queue and manual-client entry points', { timeout: 25000 }, async t => {
  const { state, send } = await setup(t);
  assert.equal((await send('queue')).delivery, 'unknown');
  state.mode = 'confirm';
  const retry = await send();
  assert.equal(retry.delivery, 'unknown');
  assert.equal(retry.nonretryable, true);
  assert.equal(state.calls, 1);
  assert.ok((await send('client', 'group')).ok);
  assert.ok((await send('client', 'private', '10003')).ok);
  assert.ok((await send('client', 'private', '10002', message + ' different')).ok);
  state.account = 10009;
  assert.ok((await send()).ok);
  assert.equal(state.calls, 5);
});

test('termination while the gateway holds the reply does not dispatch the message again', { timeout: 15000 }, async t => {
  const { state, send, start } = await setup(t);
  state.mode = 'hold';
  const { child, exited } = start();
  await waitFor(() => assert.equal(state.calls, 1), { timeout: 6000 });
  child.kill();
  await exited;
  state.mode = 'confirm';
  assert.equal((await send('queue')).delivery, 'unknown');
  assert.equal(state.calls, 1);
});

test('a blocked concurrent send does not poison the queue after the first sender gets its receipt', async t => {
  const { dir, state } = await setup(t);
  const settings = JSON.parse(await fs.readFile(path.join(dir, 'config.json')));
  const client = new OneBotClient({ ...settings.alcor, receiptDirectory: path.join(dir, 'pending-message-sends') });
  client.selfInfo = { user_id: state.account };
  const queue = new SendQueue({ onebot: client, store: { appendSelf() {} } });
  state.mode = 'hold';
  const first = client.sendText('private', '10002', message);
  await waitFor(() => assert.equal(state.calls, 1));
  const repeat = () => queue.sendTextBatch('private:10002', [message]);
  try {
    await assert.rejects(repeat, { delivery: 'unknown' });
    assert.equal(state.calls, 1);
  } finally {
    state.held.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 } }));
    await first;
  }
  state.mode = 'confirm';
  await repeat();
  assert.equal(state.calls, 2);
});

test('explicit rejection and valid receipt each release the next process to send', { timeout: 15000 }, async t => {
  const { state, send } = await setup(t);
  state.mode = 'deny';
  const denied = await send();
  assert.equal(denied.ok, false);
  assert.equal(denied.delivery, undefined);
  state.mode = 'confirm';
  assert.ok((await send()).ok);
  assert.ok((await send()).ok);
  assert.equal(state.calls, 3);
});

test('unwritable receipt storage stops before the HTTP send', { timeout: 10000 }, async t => {
  const { dir, state, send } = await setup(t);
  await fs.writeFile(path.join(dir, 'pending-message-sends'), 'not a directory');
  state.mode = 'confirm';
  assert.equal((await send()).code, 'SEND_RECEIPT_STORE_UNAVAILABLE');
  assert.equal(state.calls, 0);
});

test('a locked expired marker for another message does not prevent sending', async t => {
  const { dir, state } = await setup(t);
  const settings = JSON.parse(await fs.readFile(path.join(dir, 'config.json')));
  const directory = path.join(dir, 'pending-message-sends');
  await fs.mkdir(directory);
  const stale = path.join(directory, 'e'.repeat(64));
  await fs.writeFile(stale, '');
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await fs.utimes(stale, old, old);
  const unlink = fsSync.unlinkSync;
  t.mock.method(fsSync, 'unlinkSync', file => {
    if (file === stale) throw Object.assign(new Error('fixture file temporarily busy'), { code: 'EBUSY' });
    return unlink(file);
  });
  const client = new OneBotClient({ ...settings.alcor, receiptDirectory: directory });
  client.selfInfo = { user_id: state.account };
  state.mode = 'confirm';
  assert.deepEqual(await client.sendText('private', '10002', message), { message_id: -1 });
  assert.equal(state.calls, 1);
});

for (const entry of ['archive-error', 'notify-error', 'account-switch']) {
  test('a confirmed manual send preserves its receipt on local ' + entry, { timeout: 10000 }, async t => {
    const { state, send } = await setup(t);
    state.mode = 'confirm';
    const r = await send(entry);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.messageId, -1);
    assert.equal(r.body.archived, entry === 'notify-error');
    assert.equal(r.inArchive, r.body.archived);
    assert.match(r.body.warning, /已取得发送回执/);
    assert.equal(state.calls, 1);
  });
}

test('unconfirmed markers contain no message text and expire for a later intentional send', { timeout: 15000 }, async t => {
  const { dir, state, send } = await setup(t);
  assert.equal((await send()).delivery, 'unknown');
  const directory = path.join(dir, 'pending-message-sends');
  const names = await fs.readdir(directory);
  assert.equal(names.length, 1);
  assert.match(names[0], /^[a-f0-9]{64}$/);
  const marker = path.join(directory, names[0]);
  assert.equal((await fs.stat(marker)).size, 0);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await fs.utimes(marker, old, old);
  state.mode = 'confirm';
  assert.ok((await send()).ok);
  assert.equal(state.calls, 2);
  assert.deepEqual(await fs.readdir(directory), []);
});
