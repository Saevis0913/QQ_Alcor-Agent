import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NativeController } from '../native-core/controller.mjs';
import { NativeBackend } from '../src/native-backend.mjs';

const mediaFile = () => path.join(os.tmpdir(), 'alcor-connection-state-' + process.pid + '.json');

test('adoption budget restarts when the user reconnects to a different QQ process', () => {
  const controller = new NativeController({ query: async () => ({ status: 6, flags: 0, account: '0' }) });
  controller.service.attempts = 8;
  controller.service.neverCreatedAt = '2026-11-24T00:00:00.000Z';
  assert.equal(controller.noteServiceOwner(100), true, '换了 pid 必须重新给机会');
  assert.equal(controller.snapshot().serviceAdopt.attempts, 0);
  assert.equal(controller.snapshot().serviceAdopt.neverCreatedAt, null, '旧进程的「从未创建」结论不能留给新进程');
  controller.service.attempts = 8;
  assert.equal(controller.noteServiceOwner(100), false, '同一个 pid 重连不清零，否则 45 秒节流失效');
  assert.equal(controller.snapshot().serviceAdopt.attempts, 8);
});

test('a poll that outlives its generation cannot release the next poll lock', async () => {
  const pending = [];
  const controller = {
    snapshot: () => ({ connected: true, serviceBound: true, identitySource: 'host' }),
    request: op => new Promise(resolve => pending.push({ op, resolve })),
  };
  const backend = new NativeBackend({}, { controller, mediaFile: mediaFile() });
  backend.account = '123456789';

  backend.receiving = true;
  const first = backend.poll();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(pending.length, 1);

  // 停收再开收：旧轮询还挂在 await 上，新一轮已经拿到锁
  backend.stopReceiving();
  backend.receiving = true;
  const second = backend.poll();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(pending.length, 2);
  assert.equal(backend.polling, true);

  pending[0].resolve({ status: 0, payload: [] });
  await first;
  assert.equal(backend.polling, true, '旧轮询的 finally 不能清掉新轮询的锁');

  const third = backend.poll();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(pending.length, 2, '锁还在，第三次 poll 直接返回，不再向宿主发请求');
  await third;

  pending[1].resolve({ status: 0, payload: [] });
  await second;
  assert.equal(backend.polling, false);
});

test('stopping receive clears a stuck poll lock so a reconnect can poll again', () => {
  const controller = { snapshot: () => ({ connected: true, serviceBound: true }), request: async () => ({ status: 0, payload: [] }) };
  const backend = new NativeBackend({}, { controller, mediaFile: mediaFile() });
  backend.receiving = true;
  backend.polling = true;
  backend.stopReceiving();
  assert.equal(backend.polling, false);
});
