import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeController, profileByVersion } from '../native-core/controller.mjs';

const owner = (overrides = {}) => ({
  pid: 4242, account: '123456789', identitySource: 'memory', serviceBound: false, generation: 1,
  rvas: { service_global: 0x6a104a8, service_vtable: 0x412fd88, account_pair: 0x6a13468 },
  ...overrides,
});

test('an adopted service object lets the session upgrade to host on the same rebind', async () => {
  const calls = [];
  const controller = new NativeController({
    adopt: async args => { calls.push(args); return { ok: true, report: { object: 0x1afd37c0000 } }; },
    query: async () => ({ status: 0, flags: 15, account: '123456789' }),
  });
  const live = owner();
  controller.owner = live;
  assert.equal(await controller.rebindService(live), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { pid: 4242, vtableRva: 0x412fd88, globalRva: 0x6a104a8, controlRva: 0x6a104b0 });
  assert.equal(live.identitySource, 'host');
  assert.equal(live.serviceBound, true);
  assert.equal(controller.snapshot().serviceAdopt.found, 1);
  assert.equal(controller.snapshot().serviceAdopt.lastObject, 0x1afd37c0000);
});

test('a missing service object is reported and throttled instead of scanned every heartbeat', async () => {
  let calls = 0;
  const controller = new NativeController({
    adopt: async () => { calls++; return { ok: false, code: 'SERVICE_OBJECT_MISSING' }; },
    query: async () => ({ status: 6, flags: 0, account: '0' }),
  });
  const live = owner();
  controller.owner = live;
  assert.equal(await controller.rebindService(live), false);
  assert.equal(await controller.rebindService(live), false);
  assert.equal(calls, 1, '第二个心跳应被 45 秒节流挡住');
  const snapshot = controller.snapshot();
  assert.equal(snapshot.serviceBound, false);
  assert.equal(snapshot.serviceAdopt.lastCode, 'SERVICE_OBJECT_MISSING');
  assert.equal(snapshot.serviceAdopt.attempts, 1);
});

test('adoption stops after its own attempt budget', async () => {
  let calls = 0;
  const controller = new NativeController({
    adopt: async () => { calls++; controller.service.lastAt = 0; return { ok: false, code: 'SERVICE_OBJECT_MISSING' }; },
    query: async () => ({ status: 6, flags: 0, account: '0' }),
  });
  const live = owner();
  controller.owner = live;
  for (let i = 0; i < 12; i++) await controller.rebindService(live);
  assert.equal(calls, 8);
  assert.equal(controller.snapshot().serviceAdopt.attempts, 8);
});

test('a session without profile rvas never spawns the memory scan', async () => {
  let calls = 0;
  const controller = new NativeController({
    adopt: async () => { calls++; return { ok: true, report: {} }; },
    query: async () => ({ status: 6, flags: 0, account: '0' }),
  });
  const live = owner({ rvas: null });
  controller.owner = live;
  assert.equal(await controller.rebindService(live), false);
  assert.equal(calls, 0);
  assert.equal(controller.snapshot().serviceAdopt.attempts, 0);
});

test('an adopted object alone does not fake a host identity', async () => {
  const controller = new NativeController({
    adopt: async () => ({ ok: true, report: { object: 0x1afd37c0000 } }),
    query: async () => ({ status: 6, flags: 0, account: '0' }),
  });
  const live = owner();
  controller.owner = live;
  assert.equal(await controller.rebindService(live), false);
  assert.equal(live.identitySource, 'memory');
  assert.equal(controller.snapshot().serviceAdopt.found, 1);
});
test('a hotfix build borrows the same-version rvas so adoption can still run', () => {
  const profile = profileByVersion('9.9.37-55001');
  assert.ok(profile, '9.9.37 前缀应借到 profile');
  assert.equal(profile.version, '9.9.37-54395');
  assert.equal(profile.rvas.service_vtable, 0x412fd88);
  assert.equal(profileByVersion(''), null);
  assert.equal(profileByVersion('8.8.8-1'), null);
});
