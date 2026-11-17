// Load before the stylesheet so an existing night preference is applied at first paint.
(function () {
  const { defaults, normalizeSchedule, resolve } = AlcorTheme;
  const key = 'alcor-console-appearance';
  function read() {
    try { return JSON.parse(localStorage.getItem(key)) || {}; }
    catch { return {}; }
  }
  function apply(appearance = read()) {
    const root = document.documentElement;
    root.dataset.theme = resolve(appearance.theme === 'system' ? 'auto' : appearance.theme, appearance.schedule);
    root.dataset.accent = appearance.accent || 'violet';
    root.classList.toggle('oled', appearance.oled === true);
    root.classList.toggle('compact', appearance.compact === true);
  }
  function save(appearance) {
    apply(appearance);
    try { localStorage.setItem(key, JSON.stringify(appearance)); } catch {}
  }
  globalThis.ConsoleTheme = { read, apply, save, normalizeSchedule, defaults };
  apply();
})();
