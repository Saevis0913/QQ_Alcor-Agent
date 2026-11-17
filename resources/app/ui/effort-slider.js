// 思考强度滑杆：几何菱形把手 + 六挡刻度。
// 只负责交互与外观同步；真正的读取/保存仍走 #sc-thinking-effort 与既有的防抖自动保存。
(function () {
  'use strict';
  const STOPS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const LABELS = ['轻度', '中', '高', '极高', 'max', 'Ultra'];
  const LAST = STOPS.length - 1;

  const rootOf = (el) => el && el.closest ? el.closest('[data-effort-root]') : null;
  const parts = (root) => ({
    slider: root.querySelector('[data-effort-slider]'),
    knob: root.querySelector('[data-effort-knob]'),
    fill: root.querySelector('.effort-fill'),
    ticks: [...root.querySelectorAll('[data-tick]')],
    labels: [...root.querySelectorAll('.effort-labels span')],
    read: root.querySelector('[data-effort-read]'),
    input: root.querySelector('[data-effort-value]'),
    modes: [...root.querySelectorAll('[data-effort-mode]')]
  });

  function modeOf(value) {
    if (value === 'off') return 'off';
    if (value === '') return 'auto';
    return 'on';
  }

  function indexOf(value) {
    const i = STOPS.indexOf(value);
    return i >= 0 ? i : 2;
  }

  function readText(value) {
    if (value === 'off') return '关闭';
    if (value === '') return '服务默认';
    if (value === 'on-noeffort') return '服务默认强度';
    return LABELS[indexOf(value)] || '中';
  }

  function paint(root) {
    const p = parts(root);
    const value = p.input ? p.input.value : '';
    const mode = modeOf(value);
    const index = indexOf(value);
    const pct = (index / LAST) * 100;
    root.dataset.value = value;
    root.classList.toggle('is-off', mode === 'off');
    root.classList.toggle('is-auto', mode === 'auto');
    root.classList.toggle('is-on', mode === 'on');
    if (p.fill) p.fill.style.width = pct + '%';
    if (p.knob) p.knob.style.left = `calc(7px + (100% - 14px) * ${index / LAST})`;
    p.ticks.forEach((tick, i) => {
      tick.classList.toggle('current', i === index && mode !== 'off');
      tick.classList.toggle('done', i < index && mode !== 'off');
    });
    p.labels.forEach((el, i) => el.classList.toggle('on', i === index && mode !== 'off'));
    p.modes.forEach((btn) => btn.classList.toggle('on', btn.dataset.effortMode === mode));
    if (p.read) p.read.textContent = readText(value);
    if (p.slider) {
      p.slider.setAttribute('aria-valuenow', String(index));
      p.slider.setAttribute('aria-valuetext', LABELS[index]);
      p.slider.setAttribute('aria-disabled', mode === 'on' ? 'false' : 'true');
    }
  }

  function commit(root, value, { silent = false } = {}) {
    const p = parts(root);
    if (!p.input) return;
    if (p.input.value === value) { paint(root); return; }
    p.input.value = value;
    paint(root);
    if (!silent) p.input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function indexFromPointer(slider, clientX) {
    const box = slider.getBoundingClientRect();
    const left = box.left + 7;
    const span = Math.max(1, box.width - 14);
    const ratio = Math.min(1, Math.max(0, (clientX - left) / span));
    return Math.round(ratio * LAST);
  }

  function setIndex(root, index, opts) {
    const clamped = Math.min(LAST, Math.max(0, index));
    commit(root, STOPS[clamped], opts);
  }

  document.addEventListener('click', (event) => {
    const modeBtn = event.target.closest('[data-effort-mode]');
    if (modeBtn) {
      const root = rootOf(modeBtn);
      if (!root) return;
      const mode = modeBtn.dataset.effortMode;
      const p = parts(root);
      const current = p.input ? p.input.value : '';
      if (mode === 'off') commit(root, 'off');
      else if (mode === 'auto') commit(root, '');
      else if (mode === 'on') {
        const keep = STOPS.includes(current) ? current : STOPS[indexOf(current)];
        commit(root, keep);
      }
      return;
    }

    const tick = event.target.closest('[data-tick]');
    if (tick) {
      const root = rootOf(tick);
      if (!root) return;
      setIndex(root, Number(tick.dataset.tick));
      return;
    }

    const slider = event.target.closest('[data-effort-slider]');
    if (slider && !slider.dataset.dragging) {
      const root = rootOf(slider);
      if (!root) return;
      setIndex(root, indexFromPointer(slider, event.clientX));
    }
  });

  document.addEventListener('pointerdown', (event) => {
    const slider = event.target.closest('[data-effort-slider]');
    if (!slider || event.button !== 0) return;
    const root = rootOf(slider);
    if (!root) return;
    slider.dataset.dragging = '1';
    slider.setPointerCapture?.(event.pointerId);
    setIndex(root, indexFromPointer(slider, event.clientX), { silent: true });

    const move = (e) => setIndex(root, indexFromPointer(slider, e.clientX), { silent: true });
    const up = (e) => {
      slider.removeEventListener('pointermove', move);
      slider.removeEventListener('pointerup', up);
      slider.removeEventListener('pointercancel', up);
      delete slider.dataset.dragging;
      setIndex(root, indexFromPointer(slider, e.clientX));
    };
    slider.addEventListener('pointermove', move);
    slider.addEventListener('pointerup', up);
    slider.addEventListener('pointercancel', up);
  });

  document.addEventListener('keydown', (event) => {
    const slider = event.target.closest?.('[data-effort-slider]');
    if (!slider) return;
    const root = rootOf(slider);
    if (!root) return;
    const p = parts(root);
    const current = indexOf(p.input ? p.input.value : '');
    let next = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = current + 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = current - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = LAST;
    else if (/^[1-6]$/.test(event.key)) next = Number(event.key) - 1;
    if (next === null) return;
    event.preventDefault();
    setIndex(root, next);
  });

  // 设置页重渲染后无需手动初始化：模板里已带好初始状态；这里只补一次 paint，
  // 以覆盖"保存失败回滚成旧值"之类由其它代码改动隐藏域的场景。
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        const root = node.matches?.('[data-effort-root]') ? node : node.querySelector?.('[data-effort-root]');
        if (root) paint(root);
      }
    }
  });
  try {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch { /* 观察失败不影响手动交互 */ }

  globalThis.AlcorEffortSlider = Object.freeze({ STOPS, LABELS, paint });
})();
