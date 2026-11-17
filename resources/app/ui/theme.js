// Resolve before first paint, using the same policy as the running interface.
(function () {
  let preference = 'auto', schedule;
  try {
    preference = AlcorTheme.normalizePreference(localStorage.getItem('qqa-theme'));
    schedule = JSON.parse(localStorage.getItem('alcor-theme-schedule') || 'null');
  } catch { /* Storage is optional; local-time defaults still work. */ }
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = AlcorTheme.resolve(preference, schedule);
})();
