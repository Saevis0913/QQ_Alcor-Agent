import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { test } from 'node:test';
import vm from 'node:vm';
import { WebSocketServer } from 'ws';
import { OneBotClient } from '../src/onebot.js';
import { SendQueue } from '../src/sender.js';
import { waitFor } from './helpers/wait-for.mjs';

async function listener(t, handler) {
  const server = http.createServer(handler);
  const sockets = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const events = [];
  const client = new OneBotClient({ wsUrl: 'ws://127.0.0.1:' + port, httpUrl: 'http://127.0.0.1:' + port,
    onEvent: event => events.push(event) });
  t.after(async () => {
    client.close();
    for (const peer of sockets.clients) peer.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { client, sockets, events };
}

function reply(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

for (const [name, status, body] of [
  ['gateway HTML', 502, null],
  ['gateway timeout', 504, { error: 'timeout' }],
  ['gateway timeout in a OneBot error envelope', 502, { status: 'failed', retcode: 1502, wording: 'UPSTREAM_TIMEOUT' }],
  ['empty success', 200, { status: 'ok', retcode: 0, data: {} }],
  ['zero receipt', 200, { status: 'ok', retcode: 0, data: { message_id: 0 } }],
  ['rounded numeric receipt', 200, { status: 'ok', retcode: 0, data: { message_id: 2 ** 54 } }],
  ['asynchronous acceptance', 200, { status: 'async', retcode: 1 }],
  ['inconsistent rejection', 200, { status: 'failed', retcode: 0 }]
]) {
  test('unconfirmed message blocks batch and repeated submission: ' + name, async t => {
    let calls = 0;
    const { client } = await listener(t, (req, res) => {
      calls++;
      if (body === null) { res.writeHead(status); res.end('<html>Bad Gateway</html>'); }
      else reply(res, status, body);
    });
    client.selfInfo = { user_id: 10001 };
    const queue = new SendQueue({ onebot: client, store: {} });
    const send = () => queue.sendTextBatch('private:10002', ['fixture-first', 'fixture-next']);
    await assert.rejects(send, { delivery: 'unknown', nonretryable: true });
    await assert.rejects(send, { delivery: 'unknown', nonretryable: true });
    assert.equal(calls, 1);
  });
}

test('message receipts, explicit rejections and query results keep their meaning', async t => {
  let result;
  let status = 200;
  const { client } = await listener(t, (req, res) => reply(res, status, result));
  for (const id of [-42, '91234567890123456789']) {
    result = { status: 'ok', retcode: 0, data: { message_id: id } };
    assert.deepEqual(await client.sendText('group', '10003', 'hi'), { message_id: id });
  }
  result = { status: 'ok', retcode: 0, data: null };
  assert.equal(await client.call('get_status'), null);
  assert.equal(await client.call('delete_msg', { message_id: -42 }), null);
  result = { status: 'failed', retcode: 1403, wording: 'READ_ONLY_MODE' };
  for (status of [200, 403]) {
    await assert.rejects(() => client.sendText('group', '10003', 'hi'), e => e.code === 'READ_ONLY_MODE' && !e.delivery);
  }
  status = 502;
  result = { status: 'failed', retcode: 502, wording: 'UPSTREAM_HTTP_403' };
  await assert.rejects(() => client.sendText('group', '10003', 'hi'), e => e.code === 'UPSTREAM_HTTP_403' && !e.delivery);
  result = { error: 'Bad Gateway' };
  await assert.rejects(() => client.call('get_status'), e => e.httpStatus === 502 && !e.delivery);
});

test('archive test-send submits once while pending and preserves drafts and outcome text', async () => {
  const nodes = new Map();
  const select = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', textContent: '', disabled: false,
      addEventListener(event, callback) { this[event] = callback; } });
    return nodes.get(selector);
  };
  const sent = [];
  const refreshes = [];
  let resolve, reject;
  const context = vm.createContext({ $: select, state: { currentChatKey: 'private:10002', chats: [] },
    CHAT_MSG_PAGE: 15, formatChatTitle: String, chatNameOf: String, esc: String, uiEnter() {},
    api(url, request) {
      sent.push(JSON.parse(request.body).text);
      return new Promise((ok, fail) => { resolve = ok; reject = fail; });
    } });
  vm.runInContext(await readFile(new URL('../ui/app/04-archive-usage.js', import.meta.url), 'utf8'), context);
  Object.assign(context, { bindArchiveActions() {}, updateChatMessagesBody() {}, loadChatMessages: key => refreshes.push(key) });
  context.renderChatMessages();
  const input = select('#test-send-text');
  const button = select('#chat-testsend-btn');
  const status = select('#chat-testsend-status');
  input.value = 'first';
  const first = button.click();
  assert.equal(button.disabled, true);
  await button.click();
  assert.deepEqual(sent, ['first']);
  reject(new Error('送达状态未知，请先在收件端核对。'));
  await first;
  assert.match(status.textContent, /核对/);
  assert.equal(input.value, 'first');
  assert.equal(button.disabled, false);
  assert.deepEqual(refreshes, []);
  input.value = 'second';
  const second = button.click();
  input.value = 'next draft';
  resolve({ ok: true, warning: '已取得发送回执，本地存档写入失败。' });
  await second;
  assert.match(status.textContent, /本地存档写入失败/);
  assert.equal(input.value, 'next draft');
  assert.equal(button.disabled, false);
  assert.deepEqual(refreshes, ['private:10002']);
});

for (const ending of ['reconnect', 'peer disconnect', 'close']) {
  test('account identity is cleared before disconnect observers run: ' + ending, async t => {
    let held;
    let round = 0;
    const { client, sockets, events } = await listener(t, (req, res) => {
      if (req.url !== '/get_login_info') { reply(res, 400, {}); return; }
      if (++round === 1) reply(res, 200, { status: 'ok', retcode: 0, data: { user_id: 10001 } });
      else held = res;
    });
    await client.connect();
    await waitFor(() => assert.equal(client.selfId, '10001'));
    const oldPeer = [...sockets.clients][0];
    const observed = [];
    client.onStatus(s => { if (!s.connected) observed.push(client.selfId); });
    if (ending === 'peer disconnect') oldPeer.terminate();
    else await client[ending]();
    await waitFor(() => assert.ok(observed.length > 0));
    assert.equal(observed[0], '');
    assert.equal(client.selfId, '');
    await assert.rejects(() => client.sendText('private', '10002', 'hi', { expected_self_id: '10001' }), { nonretryable: true });
    if (ending !== 'reconnect') return;
    await waitFor(() => assert.ok(held));
    reply(held, 200, { status: 'ok', retcode: 0, data: { user_id: 10009 } });
    await waitFor(() => assert.equal(client.selfId, '10009'));
    const peer = [...sockets.clients].find(item => item !== oldPeer);
    peer.send(JSON.stringify({ message_id: 1, self_id: 10009 }));
    await waitFor(() => assert.ok(events.length > 0));
    assert.deepEqual(events, [{ message_id: 1, self_id: 10009 }]);
  });
}
