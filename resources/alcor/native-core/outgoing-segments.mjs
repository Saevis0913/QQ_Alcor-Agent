import { bytes as b, join as j, scalar as s, uin } from './wire.mjs';

export const REPLY_SOURCE = Symbol('QQ reply source');

export function encodeTextElement(text) {
  if (typeof text !== 'string' || !text || !text.isWellFormed() || Buffer.byteLength(text) > 32768) {
    throw new Error('TEXT_CONTENT');
  }
  return b(1, b(1, text));
}

export function encodeMentionElement(member) {
  if (!/^u_[\w-]{4,80}$/.test(member?.uid || '')) throw new Error('MENTION_UID');
  const label = String(member.card || member.nickname || member.user_id).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 96).toWellFormed();
  return b(1, j(b(1, `@${label} `), b(12, j(s(3, 2), s(4, 0), s(5, 0), b(9, member.uid)))));
}

export function encodeReplyElement(event, source, isGroup) {
  [isGroup ? event.sequence : source.clientSequence, event.user_id, event.time].forEach(uin);
  return b(45, j(
    s(1, isGroup ? event.sequence : source.clientSequence), s(2, event.user_id), s(3, event.time),
    ...source.elements.map((element) => b(5, element)), b(9, source.body), s(10, 0)
  ));
}

export function encodePrivateElements({ recipientUin, elements, clientSequence, random, timestamp }) {
  [recipientUin, clientSequence, random, timestamp].forEach(uin);
  return j(
    b(1, b(1, s(1, recipientUin))), b(2, j(s(1, 1), s(3, 11))),
    b(3, b(1, j(...elements.map((element) => b(2, element))))),
    s(4, clientSequence), s(5, random), b(12, s(1, timestamp))
  );
}
