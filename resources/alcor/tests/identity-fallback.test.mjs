import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMemoryDump, pickAccount } from '../native-core/identity-fallback.mjs';
import { readIdentityHint } from '../native-core/controller.mjs';
import { QQ_BUILD_PROFILES } from '../native-core/qq-profiles.mjs';

test('parseMemoryDump reads base, size and 16-byte slots', () => {
  const uin = 2790528295n;
  const text = 'base 7ffa948c0000 size 76d7000 module wrapper.node\n'
    + 'rva 69c92b8 ' + uin.toString(16) + ' ' + uin.toString(16) + '\n'
    + 'rva 69c6300 228a4150000 0\n'
    + 'rva 761094 unreadable\n';
  const dump = parseMemoryDump(text);
  assert.equal(dump.base, 0x7ffa948c0000);
  assert.equal(dump.size, 0x76d7000);
  assert.equal(dump.values['69c92b8'].lo, uin);
  assert.equal(dump.values['69c6300'].lo, 0x228a4150000n);
  assert.equal(dump.values['69c6300'].hi, 0n);
  assert.equal(dump.values['761094'], null);
});

test('parseMemoryDump surfaces process/module errors instead of empty data', () => {
  assert.equal(parseMemoryDump('ERROR module-not-found').error, 'ERROR module-not-found');
  assert.equal(parseMemoryDump('ERROR open-process').error, 'ERROR open-process');
});

test('pickAccount only trusts a doubled, in-range uin', () => {
  assert.equal(pickAccount({ '69c92b8': { lo: 2790528295n, hi: 2790528295n } }, 0x69c92b8), '2790528295');
  assert.equal(pickAccount({ '69c92b8': { lo: 2790528295n, hi: 1n } }, 0x69c92b8), null);
  assert.equal(pickAccount({ '69c92b8': { lo: 0n, hi: 0n } }, 0x69c92b8), null);
  assert.equal(pickAccount({}, 0x69c92b8), null);
});

test('readIdentityHint refuses partial profiles', async () => {
  assert.equal(await readIdentityHint(1, [1, 2, 3]), null);
});

test('readIdentityHint reads the live QQ account when a supported build is running', async (t) => {
  const profile = QQ_BUILD_PROFILES[0];
  let pid = 0;
  try {
    const { discoverQQ } = await import('../native-core/discovery.mjs');
    const rows = await discoverQQ();
    const row = (rows || []).find((item) => item.pid && item.supported);
    pid = row?.pid || 0;
  } catch { pid = 0; }
  if (!pid) return t.skip('no running QQ');
  const hint = await readIdentityHint(pid, profile.rvas);
  assert.equal(hint.reason, null);
  assert.match(String(hint.account), /^\d{5,10}$/);
  assert.equal(hint.serviceBound, true);
});


test('identityDecision keeps a healthy host identity untouched', async () => {
  const { identityDecision } = await import('../native-core/controller.mjs');
  const id = { status: 0, flags: 15, account: '123456' };
  const decision = identityDecision(id, null);
  assert.equal(decision.source, 'host');
  assert.equal(decision.error, null);
  assert.equal(decision.identity, id);
});

test('identityDecision falls back to the memory uin when the host returns 6', async () => {
  const { identityDecision } = await import('../native-core/controller.mjs');
  const decision = identityDecision({ status: 6, flags: 0, account: '0' }, { account: '2790528295', serviceBound: false });
  assert.equal(decision.source, 'memory');
  assert.equal(decision.error, null);
  assert.equal(decision.identity.account, '2790528295');
  assert.equal(decision.identity.flags, 15);
  assert.equal(decision.identity.status, 0);
});

test('identityDecision reports IDENTITY_UNREADABLE when both paths fail', async () => {
  const { identityDecision } = await import('../native-core/controller.mjs');
  const decision = identityDecision({ status: 6, flags: 0, account: '0' }, { account: null, reason: 'IDENTITY_MEMORY_UNREADABLE' });
  assert.equal(decision.error, 'IDENTITY_UNREADABLE');
});

test('identityDecision keeps QQ_LOGIN_NOT_CONFIRMED for other host states', async () => {
  const { identityDecision } = await import('../native-core/controller.mjs');
  const decision = identityDecision({ status: 3, flags: 0, account: '0' }, null);
  assert.equal(decision.error, 'QQ_LOGIN_NOT_CONFIRMED');
});
