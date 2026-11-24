import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeController } from '../native-core/controller.mjs';

const owner = (overrides = {}) => ({
  pid: 4242, account: '123456789', identitySource: 'memory', serviceBound: false, generation: 1,
  rvas: { service_global: 0x6a104a8, service_vtable: 0x412fd88, account_pair: 0x6a13468 },
  ...overrides,
});

test('a zero-hit scan records the scan cost and the first time the object was proven absent', async () => {
  const controller = new NativeController({
    adopt: async () => ({ ok: false, code: 'SERVICE_OBJECT_MISSING', report: { hits: 0, millis: 157, scanned: 35217408 } }),
    query: async () => ({ status: 6, flags: 0, account: '0' }),
  });
  const live = owner();
  controller.owner = live;
  assert.equal(await controller.rebindService(live), false);
  const first = controller.snapshot().serviceAdopt;
  assert.equal(first.lastCode, 'SERVICE_OBJECT_MISSING');
  assert.equal(first.lastHits, 0);
  assert.equal(first.lastMillis, 157);
  assert.match(first.neverCreatedAt, /^\d{4}-\d{2}-\d{2}T/);
  controller.service.lastAt = 0;
  assert.equal(await controller.rebindService(live), false);
  assert.equal(controller.snapshot().serviceAdopt.neverCreatedAt, first.neverCreatedAt, '首扫时间只记一次');
  assert.equal(controller.snapshot().serviceAdopt.attempts, 2);
});

test('a successful adoption clears the absent verdict and keeps the hit count', async () => {
  const controller = new NativeController({
    adopt: async () => ({ ok: true, code: null, report: { hits: 3, millis: 157, object: 0x1afd37c0000 } }),
    query: async () => ({ status: 0, flags: 15, account: '123456789' }),
  });
  const live = owner();
  controller.owner = live;
  assert.equal(await controller.rebindService(live), true);
  const snapshot = controller.snapshot().serviceAdopt;
  assert.equal(snapshot.lastHits, 3);
  assert.equal(snapshot.neverCreatedAt, null);
  assert.equal(live.identitySource, 'host');
});
