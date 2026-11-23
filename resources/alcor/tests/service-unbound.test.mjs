import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NativeController } from '../native-core/controller.mjs';
import { NativeBackend } from '../src/native-backend.mjs';

const mediaFile = () => path.join(os.tmpdir(), 'alcor-service-unbound-' + process.pid + '.json');
const owner = (overrides = {}) => ({ pid: 4242, account: '123456789', identitySource: 'memory', serviceBound: false, generation: 1, ...overrides });

test('a memory session upgrades to host as soon as QQ hands over the service', async () => {
  const controller = new NativeController({ query: async () => ({ status: 0, flags: 15, account: '123456789' }) });
  const live = owner();
  controller.owner = live;
  let announced = null;
  controller.onServiceBound = snapshot => { announced = snapshot; };
  assert.equal(controller.snapshot().serviceBound, false);
  assert.equal(await controller.rebindService(live), true);
  assert.equal(live.identitySource, 'host');
  assert.equal(live.serviceBound, true);
  assert.equal(controller.snapshot().serviceBound, true);
  assert.equal(controller.snapshot().rebindAttempts, 1);
  assert.ok(controller.snapshot().reboundAt);
  assert.equal(announced?.serviceBound, true);
});

test('a memory session stays identity-only while the host still reports no session', async () => {
  const controller = new NativeController({ query: async () => ({ status: 6, flags: 0, account: '0' }) });
  const live = owner();
  controller.owner = live;
  assert.equal(await controller.rebindService(live), false);
  assert.equal(live.identitySource, 'memory');
  assert.equal(live.serviceBound, false);
  assert.equal(controller.rebind.lastStatus, 6);
});

test('an account change during rebind is refused instead of adopted', async () => {
  const controller = new NativeController({ query: async () => ({ status: 0, flags: 15, account: '987654321' }) });
  const live = owner();
  controller.owner = live;
  assert.equal(await controller.rebindService(live), false);
  assert.equal(live.identitySource, 'memory');
  assert.equal(live.serviceBound, false);
});

test('an unbound service is reported as not ready and refused before any send', async () => {
  const controller = { snapshot: () => ({ connected: true, serviceBound: false, identitySource: 'memory' }) };
  const backend = new NativeBackend({}, { controller, mediaFile: mediaFile() });
  backend.account = '123456789';
  backend.receiving = true;
  const snapshot = backend.snapshot();
  assert.equal(snapshot.receiveReady, false);
  assert.equal(snapshot.deliveryMode, 'identity-only');
  const status = await backend.call('get_status');
  assert.equal(status.data.reason, 'NATIVE_SERVICE_UNBOUND');
  await assert.rejects(backend.call('send_private_msg', { user_id: 10001, message: 'hi' }),
    error => error.code === 'NATIVE_SEND_SERVICE_UNBOUND' && error.httpStatus === 503 && error.delivery === 'unavailable');
});

test('a host-bound session keeps the native delivery mode', () => {
  const controller = { snapshot: () => ({ connected: true, serviceBound: null, identitySource: 'host' }) };
  const backend = new NativeBackend({}, { controller, mediaFile: mediaFile() });
  backend.receiving = true;
  const snapshot = backend.snapshot();
  assert.equal(snapshot.receiveReady, true);
  assert.equal(snapshot.deliveryMode, 'native');
});
test('a session that cannot bind the service is kept for a later upgrade instead of failing connect', async () => {
  const calls = [];
  const controller = {
    connect: async () => ({ connected: true, serviceBound: false, identitySource: 'memory' }),
    request: async action => {
      calls.push(action);
      if (action === 'identity') return { status: 0, flags: 15, account: '123456789' };
      if (action === 'receiveStart') return { status: 1 };
      return { status: 0 };
    },
    snapshot: () => ({ connected: true, serviceBound: false, identitySource: 'memory' }),
    disconnect: async () => {},
  };
  const backend = new NativeBackend({}, { controller, mediaFile: mediaFile() });
  const result = await backend.openConnection(4242);
  assert.equal(result.receiveReady, false);
  assert.equal(backend.receiving, false);
  assert.equal(calls.includes('receiveStart'), false, '未绑定服务时不该去开收信');
});

test('the controller callback starts receiving once the service is adopted', async () => {
  const calls = [];
  let bound = false;
  const controller = {
    connect: async () => ({ connected: true, serviceBound: false, identitySource: 'memory' }),
    request: async action => {
      calls.push(action);
      if (action === 'identity') return { status: 0, flags: 15, account: '123456789' };
      return { status: 0 };
    },
    snapshot: () => ({ connected: true, serviceBound: bound, identitySource: bound ? 'host' : 'memory' }),
    disconnect: async () => {},
  };
  const backend = new NativeBackend({}, { controller, mediaFile: mediaFile() });
  await backend.openConnection(4242);
  assert.equal(backend.receiving, false);
  bound = true;
  await controller.onServiceBound();
  assert.equal(backend.receiving, true);
  assert.equal(calls.filter(item => item === 'receiveStart').length, 1);
  assert.equal(backend.snapshot().receiveReady, true);
  backend.stopReceiving();
});
