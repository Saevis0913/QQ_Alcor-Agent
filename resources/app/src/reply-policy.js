export const REPLY_MODES = Object.freeze(['off', 'mentions', 'probability', 'all']);

export function normalizeReplyPolicy(value) {
  if (!value || !REPLY_MODES.includes(value.mode)) throw new Error('REPLY_MODE_INVALID');
  const p = value.probability;
  if (value.mode === 'probability' && (p === '' || p == null || !Number.isFinite(Number(p)) || Number(p) < 0.1 || Number(p) > 99.9)) {
    throw new Error('REPLY_PROBABILITY_INVALID: 概率必须为 0.1–99.9');
  }
  return { mode: value.mode, probability: Math.round(Math.min(99.9, Math.max(0.1, Number(p) || 10)) * 10) / 10 };
}

export function policyForStore(store, at = new Date()) {
  if (!store?.replyPolicy) return null;
  const schedule = store.peakSchedule;
  if (schedule?.enabled) {
    const minutes = s => /^\d{2}:\d{2}$/.test(s || '') ? Number(s.slice(0,2))*60+Number(s.slice(3)) : -1;
    const start = minutes(schedule.peak?.start), end = minutes(schedule.peak?.end), now = at.getHours()*60+at.getMinutes();
    const inPeak = start >= 0 && end >= 0 && start !== end && (start < end ? now >= start && now < end : now >= start || now < end);
    return normalizeReplyPolicy((inPeak ? schedule.peak : schedule.valley)?.replyPolicy || store.replyPolicy);
  }
  return normalizeReplyPolicy(store.replyPolicy);
}
