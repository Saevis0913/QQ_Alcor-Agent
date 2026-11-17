// Independently authored byte codec for the recovered v1 local-frame contract.
// It imports no third-party runtime and does not open a pipe, socket or process.
const HEADER_BYTES = 40;
const MAGIC = 0x31504851;
const ceiling = Object.freeze({ commandBytes: 4096, detailBytes: 65536, payloadBytes: 16 * 1024 * 1024 });
function limits(input = {}) {
  const result = {};
  for (const key of Object.keys(ceiling)) {
    const value = input[key] === undefined ? ceiling[key] : input[key];
    if (!Number.isInteger(value) || value < 0 || value > ceiling[key]) throw new RangeError('INVALID_LIMIT');
    result[key] = value;
  }
  return result;
}
function checkSizes(sizes, maximum) {
  if (sizes[0] > maximum.commandBytes || sizes[1] > maximum.detailBytes || sizes[2] > maximum.payloadBytes) throw new RangeError('FRAME_LENGTH');
}
function int(value, min, max, fallback = 0) {
  if (value === undefined) value = fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError('INVALID_INTEGER');
  return value;
}
function bytes(value) {
  if (!(value instanceof Uint8Array)) throw new TypeError('BYTE_ARRAY_REQUIRED');
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
export function encodeNativeFrame(frame, customLimits) {
  const maximum = limits(customLimits);
  const command = frame.command === undefined ? '' : frame.command;
  const detail = frame.detail === undefined ? '' : frame.detail;
  if (typeof command !== 'string' || typeof detail !== 'string') throw new TypeError('TEXT_REQUIRED');
  const payload = bytes(frame.payload === undefined ? Buffer.alloc(0) : frame.payload);
  const lengths = [Buffer.byteLength(command), Buffer.byteLength(detail), payload.length];
  checkSizes(lengths, maximum);
  const scalar = frame.scalar === undefined ? 0n : frame.scalar;
  if (typeof scalar !== 'bigint' || scalar < 0n || scalar > 0xffffffffffffffffn) throw new RangeError('INVALID_UINT64');
  const out = Buffer.alloc(HEADER_BYTES + lengths.reduce((sum, n) => sum + n, 0));
  out.writeUInt32LE(MAGIC, 0); out.writeUInt16LE(1, 4);
  out.writeUInt16LE(int(frame.operation, 0, 65535), 6);
  out.writeUInt32LE(int(frame.correlationId, 0, 0xffffffff), 8);
  out.writeInt32LE(int(frame.status, -0x80000000, 0x7fffffff), 12);
  out.writeUInt32LE(int(frame.flags, 0, 0xffffffff), 16);
  lengths.forEach((n, i) => out.writeUInt32LE(n, 20 + 4 * i)); out.writeBigUInt64LE(scalar, 32);
  out.write(command, HEADER_BYTES, lengths[0], 'utf8');
  out.write(detail, HEADER_BYTES + lengths[0], lengths[1], 'utf8');
  payload.copy(out, HEADER_BYTES + lengths[0] + lengths[1]);
  return out;
}

export function createNativeFrameDecoder({ onFrame, limits: customLimits } = {}) {
  if (typeof onFrame !== 'function') throw new TypeError('CALLBACK_REQUIRED');
  const maximum = limits(customLimits), header = Buffer.alloc(HEADER_BYTES);
  let headerUsed = 0, body = null, bodyUsed = 0, sizes = null, busy = false, closed = false;
  const clear = () => { headerUsed = 0; body = null; bodyUsed = 0; sizes = null; };
  return {
    get pendingBytes() { return headerUsed + bodyUsed; },
    push(input) {
      if (busy) throw new Error('REENTRANT_DECODER');
      if (closed) throw new Error('DECODER_CLOSED');
      busy = true;
      try {
        const chunk = bytes(input); let at = 0;
        while (at < chunk.length) {
          if (headerUsed < HEADER_BYTES) {
            const n = Math.min(HEADER_BYTES - headerUsed, chunk.length - at);
            chunk.copy(header, headerUsed, at, at + n); at += n; headerUsed += n;
            if (headerUsed < HEADER_BYTES) break;
            if (header.readUInt32LE(0) !== MAGIC || header.readUInt16LE(4) !== 1) throw new Error('FRAME_HEADER');
            sizes = [header.readUInt32LE(20), header.readUInt32LE(24), header.readUInt32LE(28)];
            checkSizes(sizes, maximum);
            body = Buffer.alloc(sizes.reduce((sum, n) => sum + n, 0));
          }
          const n = Math.min(body.length - bodyUsed, chunk.length - at);
          chunk.copy(body, bodyUsed, at, at + n); at += n; bodyUsed += n;
          if (bodyUsed < body.length) break;
          const boundary = sizes[0] + sizes[1];
          const decoded = {
            operation: header.readUInt16LE(6), correlationId: header.readUInt32LE(8), status: header.readInt32LE(12),
            flags: header.readUInt32LE(16), scalar: header.readBigUInt64LE(32),
            command: body.toString('utf8', 0, sizes[0]), detail: body.toString('utf8', sizes[0], boundary),
            payload: Buffer.from(body.subarray(boundary))
          };
          clear(); onFrame(decoded);
        }
      } catch (error) { clear(); closed = true; throw error; }
      finally { busy = false; }
    },
    finish() {
      if (busy) throw new Error('REENTRANT_DECODER');
      if (closed) throw new Error('DECODER_CLOSED');
      closed = true;
      const partial = headerUsed !== 0; clear();
      if (partial) throw new Error('TRUNCATED_FRAME');
    }
  };
}
