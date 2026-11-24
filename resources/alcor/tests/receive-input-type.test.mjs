import test from 'node:test';
import assert from 'node:assert/strict';
import {describePushInput} from '../src/native-backend.mjs';

const varint = n => { n = BigInt(n); const out = []; do { out.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n); return Buffer.from(out); };
const scalar = (n, v) => Buffer.concat([varint(n * 8), varint(v)]);
const bytes = (n, b) => Buffer.concat([varint(n * 8 + 2), varint(b.length), b]);
const push = (from, type) => new Uint8Array(bytes(1, Buffer.concat([bytes(1, scalar(1, from)), bytes(2, scalar(1, type))])));

test('a push we sent ourselves is reported as an echo, not as an unknown type', () => {
  assert.deepEqual(describePushInput(push(2790528295, 166), '2790528295'), { type: 166, selfEcho: true });
});

test('a push from another account carries its type and is not an echo', () => {
  assert.deepEqual(describePushInput(push(10001, 166), '2790528295'), { type: 166, selfEcho: false });
});

test('a self-echo marker type stays distinguishable', () => {
  assert.deepEqual(describePushInput(push(2790528295, 528), '2790528295'), { type: 528, selfEcho: true });
});

test('unreadable bytes yield nulls rather than throwing', () => {
  assert.deepEqual(describePushInput(new Uint8Array([0xff, 0xff, 0xff, 0xff]), '1'), { type: null, selfEcho: null });
  assert.deepEqual(describePushInput(new Uint8Array(), '1'), { type: null, selfEcho: null });
});
