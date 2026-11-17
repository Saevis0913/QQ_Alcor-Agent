import { createHash } from 'node:crypto';
export const IMAGE_SLICE_BYTES = 1024 * 1024;
const rotate = (value, bits) => (value << bits) | (value >>> (32 - bits));

// Slice transfer needs the unpadded cumulative SHA-1 state at each full slice,
// in little-endian word order. Only the final entry is the usual complete digest.
export function imageSliceStates(data) {
  const state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const words = new Uint32Array(80), states = [];
  const lastBoundary = (Math.ceil(data.length / IMAGE_SLICE_BYTES) - 1) * IMAGE_SLICE_BYTES;
  for (let offset = 0; offset < lastBoundary; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = data.readUInt32BE(offset + i * 4);
    for (let i = 16; i < 80; i++) words[i] = rotate(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1);
    let [a, b, c, d, e] = state;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const next = (rotate(a, 5) + f + e + k + words[i]) >>> 0;
      e = d; d = c; c = rotate(b, 30); b = a; a = next;
    }
    state[0] += a; state[1] += b; state[2] += c; state[3] += d; state[4] += e;
    if ((offset + 64) % IMAGE_SLICE_BYTES === 0) {
      const digest = Buffer.alloc(20);
      state.forEach((word, i) => digest.writeUInt32LE(word, i * 4)); states.push(digest);
    }
  }
  states.push(createHash('sha1').update(data).digest());
  return states;
}
