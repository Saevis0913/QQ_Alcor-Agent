// Original bounded decoder for the recovered private-receipt contract.
// This confirms a service acknowledgement, never recipient delivery/read status.
import { visitProtobufFields as fields } from './protobuf-fields.mjs';
const invalid = code => { throw new Error(code); };

function response(bytes) {
  const values = new Map(); let serverCode = 0n;
  fields(bytes, (number, wire, value) => {
    if ([1, 3, 6, 11, 14].includes(number)) {
      if (wire !== 0) invalid('PROTOBUF_WIRE');
      if ([3, 11, 14].includes(number) && value > 0xffffffffn) invalid('PROTOBUF_OVERFLOW');
      values.set(number, value);
    } else if (number === 7) {
      if (wire !== 2) invalid('PROTOBUF_WIRE');
      // Repeated singular messages merge their fields under protobuf semantics.
      fields(value, (field, type, code) => {
        if (field === 2) { if (type !== 0) invalid('PROTOBUF_WIRE'); serverCode = code; }
      });
    }
  });
  if ((values.get(1) ?? 0n) !== 0n || (values.get(6) ?? 0n) !== 0n || serverCode !== 0n) invalid('RECEIPT_REJECTED');
  const sequence = values.get(14), timestamp = values.get(3);
  if (!sequence || !timestamp || (values.get(11) ?? 0n) !== 0n) invalid('RECEIPT_CONFIRMATION');
  return { sequence: Number(sequence), timestamp: Number(timestamp) };
}

export function decodePrivateReceipt(packet, expectedAccount) {
  if (!/^[0-9]{5,10}$/.test(expectedAccount) || packet?.account !== expectedAccount) invalid('RECEIPT_ACCOUNT');
  if (packet.status !== 0) invalid('RECEIPT_STATUS');
  if (!(packet.payload instanceof Uint8Array)) invalid('RECEIPT_BYTES');
  const bytes = Buffer.from(packet.payload.buffer, packet.payload.byteOffset, packet.payload.byteLength);
  if (bytes.length < 12 || bytes.length > 65672) invalid('RECEIPT_LENGTH');
  const peerLength = bytes[1], boundary = 8 + peerLength;
  if (bytes[0] !== 1 || bytes.readUInt16LE(2) !== 0 || peerLength < 3 || peerLength > 128 ||
      boundary >= bytes.length || bytes.length - boundary > 65536) invalid('RECEIPT_ENVELOPE');
  const peerUid = bytes.toString('utf8', 8, boundary), clientSequence = bytes.readUInt32LE(4);
  if (!/^u_[A-Za-z0-9_-]+$/.test(peerUid) || clientSequence === 0) invalid('RECEIPT_IDENTITY');
  return { peerUid, clientSequence, ...response(bytes.subarray(boundary)), acceptedByService: true };
}
