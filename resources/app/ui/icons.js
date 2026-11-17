// Shared, authored interface glyphs. Product logos remain their original assets.
(function () {
  const paths = {
    settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
    key: '<circle cx="8" cy="8" r="4"/><path d="m11 11 9 9m-5-5 3-3m0 6 3-3"/>',
    rotate: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
    memory: '<path d="M5 4h10l4 4v12H5zM14 4v5h5M8 13h8m-8 4h6"/>',
    persona: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    chat: '<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4V6a2 2 0 0 1 2-2Z"/><path d="M8 9h9m-9 4h6"/>',
    display: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v5m-5 0h10"/>',
    plug: '<path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0zm6 9v4"/>',
    tools: '<path d="m14 4 3 3-3 3m-4 4-3-3 3-3M8 18l-4 3-1-1 3-4m11-3 4 4a2 2 0 0 1-3 3l-4-4"/>',
    money: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 9h1m10 6h1"/>',
    warning: '<path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3v.2"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    send: '<path d="m3 3 18 9-18 9 4-9Zm4 9h14"/>',
    bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7Z"/>',
    volume: '<path d="m11 4-6 5H2v6h3l6 5Zm5 5 6 6m0-6-6 6"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14a4 4 0 0 0 8 0M8 9v.2m8-.2v.2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    moon: '<path d="M20 14A8.5 8.5 0 0 1 10 4a8.5 8.5 0 1 0 10 10Z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    archive: '<rect x="4" y="7" width="16" height="14" rx="2"/><path d="M3 3h18v4H3zm6 8h6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
    book: '<path d="M12 5v16M3 4h5a4 4 0 0 1 4 2 4 4 0 0 1 4-2h5v15h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z"/>',
    media: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 8 6 4-6 4Z"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
    hand: '<path d="M8 12V5a2 2 0 0 1 4 0v6-3a2 2 0 0 1 4 0v4-1a2 2 0 0 1 4 0v4c0 4-2 6-6 6h-1c-3 0-5-2-6-4l-4-5a2 2 0 0 1 3-2l2 2Z"/>'
  };
  const legacy = { '⚙':'settings', '🔑':'key', '🔄':'rotate', '🔍':'search', '🧠':'memory', '🎭':'persona', '✅':'check', '💬':'chat', '🖥':'display', '🔌':'plug', '🧰':'tools', '🛠':'tools', '💰':'money', '⚠':'warning', '⋯':'more', '📨':'send', '⚡':'bolt', '🔇':'volume', '😄':'smile' };
  function draw(name) { return `<svg class="alcor-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.settings}</svg>`; }
  Object.assign(legacy, {'😀':'smile', '👋':'hand', '👉':'hand', '🌐':'globe', '📚':'book', '🎞':'media', '🖼':'image', '🌅':'sun'});
  globalThis.AlcorIcons = Object.freeze({ draw, fromLegacy: (icon, fallback = 'tools') => { const key = String(icon || '').replace(/\uFE0F/g, ''); return draw(legacy[key] || (paths[key] ? key : fallback)); } });
})();
