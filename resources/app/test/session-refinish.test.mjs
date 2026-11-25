import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-refinish-'));
process.env.ALCOR_AGENT_DATA_DIR = dataDir;

const src = (name) => pathToFileURL(path.resolve(here, '..', 'src', name)).href;
const { SessionRegistry } = await import(src('sessions.js'));
const { sessionStatus } = await import(src('session-effects.js'));

const readSession = (id) => JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions', `${id}.json`), 'utf8'));
const usageRuns = () => {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'usage-today.json'), 'utf8')).runs || 0; } catch { return 0; }
};

test('补发后重新结算：noreply 改成 done，磁盘与索引同步', () => {
  const registry = new SessionRegistry(0);
  const session = registry.create({ chatKey: 'group:1', trigger: [], triggerSummary: 'hi' });
  session.usage.calls = 1;                       // 有真实消耗的会话才记今日用量
  session.usage.promptTokens = 1200;
  session.usage.totalTokens = 1300;
  registry.finish(session.id, 'noreply');
  assert.equal(readSession(session.id).status, 'noreply');
  assert.equal(usageRuns(), 1);

  // 补发那一轮真正发出了一条 —— 只有内存里的活对象知道
  session.sent.push({ mid: 1, text: 'hello' });
  registry.refinish(session, 'done');

  const file = readSession(session.id);
  assert.equal(file.status, 'done');
  assert.equal(file.sent.length, 1);
  assert.equal(registry.index.find((e) => e.id === session.id)?.status, 'done');
  assert.equal(usageRuns(), 1, '重新结算不能把今日用量再记一遍');
});

test('补发后仍然没发：保留 noreply，并落下补发原因', () => {
  const registry = new SessionRegistry(0);
  const session = registry.create({ chatKey: 'group:2', trigger: [], triggerSummary: 'hi' });
  registry.finish(session.id, 'noreply');
  session.finishReason = '补发一轮后仍然只生成了正文、没有调用发送工具';
  registry.refinish(session, sessionStatus(session));

  const file = readSession(session.id);
  assert.equal(file.status, 'noreply');
  assert.match(file.finishReason, /没有调用发送工具/);
  assert.equal(registry.current.size, 0);
});

test('终态判定：出错优先，其次看有没有实际动作', () => {
  assert.equal(sessionStatus({ sent: [{ mid: 1 }] }), 'done');
  assert.equal(sessionStatus({ sent: [], sideEffects: [{ tool: 'x' }] }), 'done');
  assert.equal(sessionStatus({ sent: [], deliveryUnknown: true }), 'done');
  assert.equal(sessionStatus({}), 'noreply');
  assert.equal(sessionStatus({ error: 'boom', sent: [{ mid: 1 }] }), 'error');
});

test('补发后收件状态从「未回复」翻成「已回复」', async () => {
  const { InboxStore } = await import(src('inbox.js'));
  const inbox = new InboxStore({ file: path.join(dataDir, 'inbox-case.json'), onChange: () => {} });
  const { receipt } = inbox.receive({ chatKey: 'group:3', mid: 9001, ts: 1, senderId: '1', senderName: 'S', text: 'hi' });
  const registry = new SessionRegistry(0);
  const session = registry.create({ chatKey: 'group:3', trigger: [{ receiptId: receipt.id, text: 'hi' }], triggerSummary: 'hi' });
  registry.finish(session.id, 'noreply');

  // app.js 在会话已结束时读的就是这份磁盘快照
  inbox.syncSession(registry.get(session.id));
  assert.equal(inbox.messages.find((m) => m.id === receipt.id).status, 'noreply');

  session.sent.push({ mid: 2, text: 'reply' });
  registry.refinish(session, 'done');
  inbox.syncSession(registry.get(session.id));
  const after = inbox.messages.find((m) => m.id === receipt.id);
  assert.equal(after.status, 'replied');
  assert.equal(after.sessionId, session.id);
});

test('仍没发出时，收件理由用补发原因而不是笼统文案', async () => {
  const { InboxStore } = await import(src('inbox.js'));
  const inbox = new InboxStore({ file: path.join(dataDir, 'inbox-case2.json'), onChange: () => {} });
  const { receipt } = inbox.receive({ chatKey: 'group:4', mid: 9002, ts: 1, senderId: '1', senderName: 'S', text: 'hi' });
  const registry = new SessionRegistry(0);
  const session = registry.create({ chatKey: 'group:4', trigger: [{ receiptId: receipt.id, text: 'hi' }], triggerSummary: 'hi' });
  registry.finish(session.id, 'noreply');
  session.finishReason = '补发一轮后仍然只生成了正文、没有调用发送工具';
  registry.refinish(session, sessionStatus(session));
  inbox.syncSession(registry.get(session.id));
  assert.match(inbox.messages.find((m) => m.id === receipt.id).reason, /没有调用发送工具/);
});
