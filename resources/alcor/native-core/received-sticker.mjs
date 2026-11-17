import { bytes as b, child, fields, join as j, number as n, one, scalar as s, string } from './wire.mjs';

export function encodeReceivedSticker(row, { file, account, isGroup, recipient }) {
  const descriptor = row?.descriptor;
  if (!/^alcor-media-[a-f0-9]{64}$/.test(file) || !account || row?.account !== String(account) ||
      descriptor?.kind !== 'image' || descriptor.data?.file !== file || descriptor.data.sub_type !== 1) {
    throw new Error('NATIVE_STICKER_NOT_IN_CACHE');
  }
  if (isGroup ? descriptor.groupId !== recipient : descriptor.groupId || descriptor.peerId !== recipient) {
    throw new Error('NATIVE_STICKER_WRONG_CONVERSATION');
  }
  if (descriptor.marketFace?.length) {
    const face = fields(descriptor.marketFace);
    if (!string(face, 1, 256) || one(face, 4, 2)?.length !== 16 || !n(face, 5) || !string(face, 7, 512)) {
      throw new Error('NATIVE_STICKER_SOURCE_INVALID');
    }
    return b(6, descriptor.marketFace);
  }
  const { index } = descriptor;
  if (!isGroup || !index?.length || index.length > 2048) throw new Error('NATIVE_STICKER_SOURCE_UNAVAILABLE');
  const node = fields(index);
  if (n(node, 6) !== 0 || !string(node, 2, 512) || n(child(child(node, 1), 5), 1) !== 1) {
    throw new Error('NATIVE_STICKER_SOURCE_INVALID');
  }
  const pic = j(s(1, 1), b(2, String(descriptor.data.summary || '[动画表情]').slice(0, 160)));
  const msgInfo = j(b(1, b(1, index)), b(2, b(1, pic)));
  return b(53, j(s(1, 48), b(2, msgInfo), s(3, 10)));
}
