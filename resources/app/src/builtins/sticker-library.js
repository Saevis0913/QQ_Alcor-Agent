import { STICKER_BATCH_LIMIT } from './sticker-model.js';

const OPAQUE_STICKER = /^alcor-media-[a-f0-9]{64}$/;
const MAX_CHATS = 16;

export function queueIncomingStickers({ runtime, collect, enabled, delayMs = 4500, onError = () => {} }) {
  const pending = new Map();
  let timer;
  let active;
  let stopped = false;
  let blocked = false;

  function schedule() {
    if (stopped || timer || active || !pending.size) return;
    timer = setTimeout(async () => {
      timer = undefined;
      const [chatKey, batch] = pending.entries().next().value;
      pending.delete(chatKey);
      if (blocked || !enabled() || !runtime.isCurrent(batch.account)) return schedule();
      const controller = new AbortController();
      active = { account: batch.account, controller };
      const signal = controller.signal;
      try {
        await collect({ account: batch.account, chatKey, messageIds: [...batch.mids], signal });
      } catch (error) {
        if (!signal.aborted && enabled() && runtime.isCurrent(batch.account)) onError(error);
      } finally {
        active = null;
        schedule();
      }
    }, delayMs);
  }

  function cancel() {
    clearTimeout(timer);
    timer = undefined;
    pending.clear();
    active?.controller.abort();
  }

  const unsubscribeIncoming = runtime.subscribe('incoming', ({ selfId, chatKey, entry }) => {
    const account = String(selfId ?? '');
    if (stopped || blocked || !enabled() || !runtime.isCurrent(account) || !/^[1-9]\d{0,9}$/.test(account) ||
        !/^(group|private):[1-9]\d{0,9}$/.test(chatKey) || entry?.self || !/^-?[1-9]\d*$/.test(String(entry?.mid ?? '')) ||
        !entry.media?.some((item) => item.kind === 'image' && item.sticker && OPAQUE_STICKER.test(item.file))) return;
    const found = pending.get(chatKey);
    if (!found && pending.size >= MAX_CHATS) return;
    if (!found || found.account !== account) pending.set(chatKey, { account, mids: new Set() });
    const { mids } = pending.get(chatKey);
    if (mids.size < STICKER_BATCH_LIMIT) mids.add(entry.mid);
    schedule();
  });
  const unsubscribeStatus = runtime.subscribe('status', (status) => {
    const account = String(status?.selfId ?? runtime.account());
    blocked = status?.paused === true || status?.connected === false;
    if (blocked || !enabled() ||
        (active && active.account !== account) || [...pending.values()].some((batch) => batch.account !== account)) cancel();
  });
  return () => {
    stopped = true;
    cancel();
    unsubscribeIncoming();
    unsubscribeStatus();
  };
}
