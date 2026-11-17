import fs from 'node:fs/promises';
import path from 'node:path';

export const QZONE_DEFAULTS = Object.freeze({ enabled: false, scope: 'both', dailyLimit: 20, readTime: '09:00', timezone: 'Asia/Shanghai' });
export const QZONE_ACCOUNT = /^[1-9]\d{4,11}$/;
const ID = /^[\w.-]{1,150}$/;
const SCOPES = { both: ['own', 'friends'], own: ['own'], friends: ['friends'] };
const CATCH_UP_MINUTES = 120;
const clock = new Intl.DateTimeFormat('sv-SE', { timeZone: QZONE_DEFAULTS.timezone, dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' });
let activeSnapshot;

export function readLocalQzoneSnapshot() {
  return activeSnapshot?.() ?? { state: 'unavailable', items: [] };
}

export function normalizeQzoneConfig(config = {}) {
  const limit = Number(config?.dailyLimit);
  return {
    enabled: config?.enabled === true,
    scope: Object.hasOwn(SCOPES, config?.scope) ? config.scope : QZONE_DEFAULTS.scope,
    dailyLimit: Number.isInteger(limit) && limit >= 1 ? Math.min(100, limit) : QZONE_DEFAULTS.dailyLimit,
    readTime: /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config?.readTime) ? config.readTime : QZONE_DEFAULTS.readTime,
    timezone: QZONE_DEFAULTS.timezone
  };
}

function calendar(date) {
  const [day, time] = clock.format(date).split(' ');
  const [hour, minute] = time.split(':').map(Number);
  return { day, minutes: hour * 60 + minute };
}

function publicItem(item, scope, account) {
  const authorId = String(item?.authorId || '');
  const id = String(item?.id || '');
  if (!QZONE_ACCOUNT.test(authorId) || !ID.test(id) || (authorId === account) !== (scope === 'own')) return null;
  return {
    id, authorId, scope,
    ...(scope === 'friends' ? { verifiedFriend: true } : {}),
    author: String(item.author || '').slice(0, 120),
    text: String(item.text || '').slice(0, 4000),
    media: item.media === true,
    createdAt: Number.isFinite(item.createdAt) && item.createdAt >= 0 && item.createdAt < 8.64e15 ? item.createdAt : null
  };
}

export const qzoneItemKey = ({ authorId, id }) => `${authorId}:${id}`;

export function createQzoneService({ dataDir, getConfig, getAccount, getFriendIds, provider, now = () => new Date() }) {
  const file = path.join(dataDir, 'qzone', 'daily.json');
  let data;
  let opening;
  let pending;
  let reconnecting;
  let timer;
  let stopped = false;
  let lastState;

  async function getData(day) {
    if (!data) {
      opening ??= fs.readFile(file, 'utf8').then((raw) => { data = JSON.parse(raw); }, (error) => {
        if (error.code !== 'ENOENT') throw error;
        data = {};
      }).finally(() => { opening = undefined; });
      await opening;
    }
    return data.day === day ? data : { day, accounts: {} };
  }

  async function save(previous, account, row) {
    const next = { day: previous.day, accounts: { ...previous.accounts, [account]: row } };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify(next));
    await fs.rename(`${file}.tmp`, file);
    data = next;
    return next;
  }

  async function getSession(account) {
    return provider && QZONE_ACCOUNT.test(account) && String(getAccount() || '') === account ? provider.status(account) : null;
  }

  function connectionState(account, session) {
    if (String(getAccount() || '') !== account) return 'wrong_account';
    if (!provider) return 'unavailable';
    if (!QZONE_ACCOUNT.test(account)) return 'account_unavailable';
    if (session?.state !== 'signed_in') return session?.state === 'signing_in' ? 'signing_in' : 'login_required';
    if (session.account !== account) return 'wrong_account';
    if (lastState?.account === account && lastState.revision === session.revision) return lastState.state;
    return 'connected';
  }

  function sessionChanged(account, before, after) {
    if (String(getAccount() || '') !== account || after?.account && after.account !== account) return 'wrong_account';
    if (before?.state === 'signed_in' && (after?.state !== 'signed_in' || after.revision !== before.revision)) return 'login_required';
    return null;
  }

  function view(data, account, config, state, added) {
    if (state === 'wrong_account' || state === 'login_required') account = '';
    const row = data.accounts?.[account];
    const items = row?.items || [];
    const visible = SCOPES[config.scope];
    return {
      state, config, day: data.day, used: items.length, remaining: Math.max(0, config.dailyLimit - items.length),
      lastReadAt: row?.lastReadAt || null, scheduledAttempted: !!row?.scheduled,
      items: config.enabled && ['connected', 'read_error', 'parse_error', 'quota', 'cancelled'].includes(state)
        ? items.filter((item) => visible.includes(item.scope) && (item.scope !== 'friends' || item.verifiedFriend === true))
          .map(({ verifiedFriend, ...item }) => item) : [],
      ...(added == null ? {} : { added })
    };
  }

  async function snapshot() {
    const account = String(getAccount() || '');
    const before = await getSession(account);
    const daily = await getData(calendar(now()).day);
    const after = await getSession(account);
    const changed = sessionChanged(account, before, after);
    return view(daily, account, normalizeQzoneConfig(getConfig()), changed || connectionState(account, after));
  }

  async function status() {
    const { items, ...status } = await snapshot();
    return provider?.diagnostics ? { ...status, connection: await provider.diagnostics() } : status;
  }

  async function read(scheduled) {
    const start = now();
    const { day, minutes } = calendar(start);
    const config = normalizeQzoneConfig(getConfig());
    const account = String(getAccount() || '');
    let daily = await getData(day);
    let row = daily.accounts?.[account] || { items: [] };
    const [hours, mins] = config.readTime.split(':').map(Number);
    const delay = minutes - hours * 60 - mins;
    if (scheduled && (!config.enabled || row.scheduled || delay < 0 || delay >= CATCH_UP_MINUTES)) return;
    if (!config.enabled || stopped) return view(daily, account, config, 'disabled', 0);
    const session = await getSession(account);
    const state = connectionState(account, session);
    if (!['connected', 'read_error', 'parse_error'].includes(state)) {
      return scheduled ? undefined : view(daily, account, config, state, 0);
    }
    const remaining = config.dailyLimit - row.items.length;
    if (remaining <= 0) return scheduled ? undefined : view(daily, account, config, 'quota', 0);
    if (scheduled) {
      row = { ...row, scheduled: true };
      daily = await save(daily, account, row);
    }
    const beforeRead = sessionChanged(account, session, await getSession(account));
    if (beforeRead) return view(daily, account, config, beforeRead, 0);
    const queues = [];
    let itemsBeforeRead = row.items;
    try {
      let friendIds;
      if (SCOPES[config.scope].includes('friends')) {
        const ids = await getFriendIds(account);
        if (String(getAccount() || '') !== account) return view(daily, '', config, 'wrong_account', 0);
        if (!Array.isArray(ids) || ids.some((id) => !QZONE_ACCOUNT.test(String(id ?? '')))) throw new Error('Invalid friend directory');
        friendIds = new Set(ids.map(String));
        itemsBeforeRead = row.items.map((item) => item.scope === 'friends'
          ? { ...item, verifiedFriend: friendIds.has(item.authorId) } : item);
      }
      const seen = new Set(itemsBeforeRead.map(qzoneItemKey));
      for (const scope of SCOPES[config.scope]) {
        if (String(getAccount() || '') !== account) return view(daily, '', config, 'wrong_account', 0);
        const items = await provider.read({ account, scope, limit: remaining, seen, friendIds });
        const unique = new Map();
        for (const raw of items) {
          if (scope === 'friends' && !friendIds.has(String(raw?.authorId ?? ''))) continue;
          const item = publicItem(raw, scope, account);
          if (!item) continue;
          const key = qzoneItemKey(item);
          if (!seen.has(key) && !unique.has(key)) unique.set(key, item);
        }
        queues.push([...unique.values()]);
      }
    } catch (error) {
      const changed = sessionChanged(account, session, await getSession(account));
      if (changed) return view(daily, account, config, changed, 0);
      const failure = ['login_required', 'wrong_account', 'parse_error'].includes(error?.code) ? error.code : 'read_error';
      lastState = { account, revision: session.revision, state: failure };
      return view(daily, account, config, failure, 0);
    }
    const end = await getSession(account);
    const latest = normalizeQzoneConfig(getConfig());
    const changed = sessionChanged(account, session, end);
    if (changed) return view(daily, account, latest, changed, 0);
    if (stopped || !latest.enabled || latest.scope !== config.scope || calendar(now()).day !== day) {
      return view(daily, account, latest, 'cancelled', 0);
    }
    const items = [...itemsBeforeRead];
    const seen = new Set(items.map(qzoneItemKey));
    // Alternate scopes so a busy feed cannot take the entire day's budget.
    for (let index = 0; index < Math.max(...queues.map((queue) => queue.length)); index++) {
      for (const queue of queues) {
        const item = queue[index];
        if (!item || items.length >= latest.dailyLimit || seen.has(qzoneItemKey(item))) continue;
        items.push(item);
        seen.add(qzoneItemKey(item));
      }
    }
    daily = await save(daily, account, { ...row, items, lastReadAt: now().toISOString() });
    const afterSave = sessionChanged(account, session, await getSession(account));
    const finalConfig = normalizeQzoneConfig(getConfig());
    if (afterSave) return view(daily, account, finalConfig, afterSave, 0);
    if (stopped || calendar(now()).day !== day) return view(daily, '', finalConfig, 'cancelled', 0);
    lastState = undefined;
    return view(daily, account, finalConfig, 'connected', items.length - itemsBeforeRead.length);
  }

  function run(scheduled) {
    if (pending) return scheduled ? Promise.resolve() : pending.then((result) => result ?? run(false));
    if (reconnecting) return scheduled ? Promise.resolve() : reconnecting.then(() => run(false));
    pending = read(scheduled).finally(() => { pending = undefined; });
    return pending;
  }

  async function openLogin() {
    if (stopped) return { state: 'unavailable' };
    if (!provider) return { state: 'unavailable' };
    if (!QZONE_ACCOUNT.test(String(getAccount() || ''))) return { state: 'account_unavailable' };
    if (pending) await pending;
    if (stopped) return { state: 'unavailable' };
    const account = String(getAccount() || '');
    const state = connectionState(account, await getSession(account));
    if (state === 'connected' || state === 'signing_in') return { state };
    await provider.login({ account, reset: ['login_required', 'wrong_account'].includes(state) });
    return { state: 'signing_in' };
  }

  function login() {
    reconnecting ??= openLogin().finally(() => { reconnecting = undefined; });
    return reconnecting;
  }

  return {
    status, login, snapshot, readNow: () => run(false), tick: () => run(true),
    start() {
      if (timer || !provider) return;
      stopped = false;
      activeSnapshot = snapshot;
      const tick = () => { void run(true).catch(() => {}); };
      timer = setInterval(tick, 30_000);
      timer.unref?.();
      tick();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      stopped = true;
      if (activeSnapshot === snapshot) activeSnapshot = undefined;
      await provider?.stop?.();
      await pending?.catch(() => {});
      if (reconnecting) {
        await reconnecting.catch(() => {});
        await provider?.stop?.();
      }
    }
  };
}
