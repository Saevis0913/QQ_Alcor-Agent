// Shared by first paint and the running interface; uses local device time.
(function (root) {
  'use strict';
  const defaults = Object.freeze({ lightStart: '07:00', darkStart: '19:00' });
  const time = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  const validSchedule = value => Boolean(value && time(value.lightStart) && time(value.darkStart) && value.lightStart !== value.darkStart);
  const normalizeSchedule = value => validSchedule(value) ? { lightStart: value.lightStart, darkStart: value.darkStart } : { ...defaults };
  const normalizePreference = value => ['light', 'dark', 'auto'].includes(value) ? value : 'auto';
  const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  function resolve(preference, schedule, date = new Date()) {
    const pref = normalizePreference(preference);
    if (pref !== 'auto') return pref;
    const s = normalizeSchedule(schedule), start = minutes(s.lightStart), end = minutes(s.darkStart);
    const now = date.getHours() * 60 + date.getMinutes();
    return (start < end ? now >= start && now < end : now >= start || now < end) ? 'light' : 'dark';
  }
  root.AlcorTheme = Object.freeze({ defaults, validSchedule, normalizeSchedule, normalizePreference, resolve });
})(globalThis);
