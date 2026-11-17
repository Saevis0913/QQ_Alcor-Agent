import fs from 'node:fs';
import path from 'node:path';

const qqId = value => /^\d+$/.test(String(value ?? '')) && Number(value) > 0 ? String(value) : '';
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });

export function chatAllowed(kind, id, config) {
  const target = String(id);
  const deny = config.deny?.[kind] ?? config.deny?.[`${kind}s`] ?? [];
  if (deny.map(String).includes(target)) return false;
  const allow = config.allow?.[kind] ?? config.allow?.[`${kind}s`] ?? [];
  return allow.length ? allow.map(String).includes(target) : config.allowAllWhenEmpty === true;
}

export async function groupAddress(event, selfId, resolveSender = async () => '') {
  const self = qqId(selfId);
  const segments = Array.isArray(event.message) ? event.message : [];
  const targets = segments.filter(s => s?.type === 'at' && s.data?.qq !== 'all');
  if (self && targets.some(s => s.data?.unresolved !== true && qqId(s.data?.qq) === self)) {
    return { allow: true, atBot: true, atMe: true };
  }
  if (targets.length) return { allow: false, atBot: false, atMe: false };
  let atMe = false;
  for (const segment of segments) {
    if (segment?.type !== 'reply') continue;
    const { sender_id, id } = segment.data || {};
    const target = qqId(sender_id) || (id != null && id !== '' ? qqId(await resolveSender(id)) : '');
    if (!self || target !== self) return { allow: false, atBot: false, atMe: false };
    atMe = true;
  }
  return { allow: true, atBot: false, atMe };
}

export const DEFAULT_PRIVATE_POLICY = Object.freeze({
  enabled: true,
  // 2026-11-17：默认不限量（0 = 不限）。私聊的目标是"发来一条就互动一条"，
  // 上限只作为用户主动收紧时的可用选项保留；显式填数字仍然按旧逻辑拦截。
  dailyLimit: 0,
  skipNewFriendGreeting: true,
  limitNotice: '今天的私聊消息已达上限，请明天再发。',
  adminQQs: [],
  specialFriendQQs: []
});

export function normalizePrivatePolicy(settings = {}) {
  const value = { ...DEFAULT_PRIVATE_POLICY, ...settings };
  for (const field of ['enabled', 'skipNewFriendGreeting']) {
    if (typeof value[field] !== 'boolean') throw new Error('私聊规则开关必须是布尔值。');
  }
  if (!Number.isSafeInteger(value.dailyLimit) || value.dailyLimit < 0) throw new Error('私聊每日上限必须是大于或等于 0 的整数。');
  if (typeof value.limitNotice !== 'string' || !value.limitNotice.trim() || value.limitNotice.length > 200) {
    throw new Error('私聊限额提醒需填写 1–200 个字符。');
  }
  value.limitNotice = value.limitNotice.trim();
  for (const field of ['adminQQs', 'specialFriendQQs']) {
    if (!Array.isArray(value[field]) || value[field].some(id => !qqId(id))) throw new Error('免限额名单必须使用 QQ 号码。');
    value[field] = [...new Set(value[field].map(String))];
  }
  return value;
}

export class PrivateMessagePolicy {
  constructor(file) {
    this.file = file;
    this.accounts = {};
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state.version !== 1 || !state.accounts || typeof state.accounts !== 'object') throw new Error('私聊规则状态格式不正确。');
      this.accounts = state.accounts;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  #account(selfId) {
    return this.accounts[selfId] ??= { friends: null, peers: {} };
  }

  #peer(account, id) {
    return account.peers[id] ??= { pendingGreeting: false, lastFriendAdd: null, days: {} };
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, accounts: this.accounts }));
    fs.renameSync(tmp, this.file);
  }

  updateFriends(selfId, friends) {
    if (!qqId(selfId) || !Array.isArray(friends) || friends.some(friend => !qqId(friend?.user_id))) return false;
    const account = this.#account(selfId);
    const previous = new Set(account.friends || []);
    const ids = [...new Set(friends.map(friend => qqId(friend.user_id)))].sort();
    if (account.friends && account.friends.length === ids.length && ids.every(id => previous.has(id))) return true;
    if (account.friends) {
      for (const id of ids) {
        if (!previous.has(id)) this.#peer(account, id).pendingGreeting = true;
      }
      const current = new Set(ids);
      for (const id of previous) if (!current.has(id) && account.peers[id]) account.peers[id].pendingGreeting = false;
    }
    account.friends = ids;
    this.#save();
    return true;
  }

  knowsFriend(selfId, id) {
    const account = this.accounts[selfId];
    const peer = account?.peers[id];
    return Boolean(account?.friends?.includes(id) || (account?.friends == null && peer?.lastFriendAdd != null));
  }

  friendAdded(selfId, id, at = Date.now()) {
    if (!qqId(selfId) || !qqId(id)) return;
    const account = this.#account(selfId);
    const peer = this.#peer(account, id);
    if (peer.lastFriendAdd != null && (at <= peer.lastFriendAdd || account.friends?.includes(id))) return;
    if (account.friends && !account.friends.includes(id)) account.friends.push(String(id));
    peer.lastFriendAdd = at;
    peer.pendingGreeting = true;
    this.#save();
  }

  friendRemoved(selfId, id) {
    if (!qqId(selfId) || !qqId(id)) return;
    const account = this.accounts[selfId];
    if (!account?.friends?.includes(id) && !account?.peers[id]?.pendingGreeting) return;
    if (account.friends) account.friends = account.friends.filter(friend => friend !== id);
    if (account.peers[id]) account.peers[id].pendingGreeting = false;
    this.#save();
  }

  receive({ selfId, peer: id, mid, sequence, now = Date.now(), sentAt = null, settings }) {
    if (!qqId(selfId) || !qqId(id)) return { status: 'allow' };
    const config = normalizePrivatePolicy(settings);
    const peer = this.#peer(this.#account(selfId), id);
    const day = dayFormat.format(now);
    // Keep a week of push identities to cover reconnect and midnight replays.
    const oldest = dayFormat.format(now - 7 * 86_400_000);
    const key = sequence != null && /^\d+$/.test(String(sequence)) && Number(sequence) > 0
      ? `seq:${sequence}:${sentAt || ''}`
      : mid != null ? `${mid}:${sentAt || ''}` : null;
    if (key && Object.values(peer.days).some(record => Object.hasOwn(record.seen, key))) return { status: 'duplicate' };
    for (const prior of Object.keys(peer.days)) if (prior < oldest) delete peer.days[prior];
    const record = peer.days[day] ??= { count: 0, seen: {}, notice: false };
    if (key) record.seen[key] = true;
    record.count++;
    const greeting = peer.pendingGreeting && (sentAt == null || peer.lastFriendAdd == null || sentAt >= peer.lastFriendAdd);
    if (greeting) peer.pendingGreeting = false;
    this.#save();
    const exempt = config.adminQQs.includes(id) || config.specialFriendQQs.includes(id);
    let status = 'allow';
    if (config.enabled && greeting && config.skipNewFriendGreeting) status = 'new_friend_greeting';
    else if (config.enabled && !exempt && config.dailyLimit > 0 && record.count > config.dailyLimit) status = 'private_quota';
    return { status, count: record.count };
  }

  reserveNotice(selfId, id, now = Date.now(), receivedAt = now) {
    const day = dayFormat.format(now);
    if (day !== dayFormat.format(receivedAt)) return false;
    const record = this.accounts[selfId]?.peers[id]?.days[day];
    if (!record || record.notice) return false;
    record.notice = true;
    this.#save();
    return true;
  }
}
