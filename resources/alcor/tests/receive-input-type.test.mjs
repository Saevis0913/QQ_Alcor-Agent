import test from 'node:test';
import assert from 'node:assert/strict';
import {pushInputType} from '../src/native-backend.mjs';

const varint = n => { n = BigInt(n); const out = []; do { out.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n); return Buffer.from(out); };
const scalar = (n, v) => Buffer.concat([varint(n * 8), varint(v)]);
const bytes = (n, b) => Buffer.concat([varint(n * 8 + 2), varint(b.length), b]);

test('a self-echo push reports its element type instead of a bare skip', () => {
  const message = bytes(2, scalar(1, 528));
  const payload = bytes(1, message);
  assert.equal(pushInputType(new Uint8Array(payload)), 528);
});

test('an ordinary private text push reports its own type', () => {
  const message = bytes(2, scalar(1, 166));
  assert.equal(pushInputType(new Uint8Array(bytes(1, message))), 166);
});

test('unreadable bytes yield null rather than throwing', () => {
  assert.equal(pushInputType(new Uint8Array([0xff, 0xff, 0xff, 0xff])), null);
  assert.equal(pushInputType(new Uint8Array()), null);
});
