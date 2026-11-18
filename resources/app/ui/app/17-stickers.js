'use strict';
/*
 * 表情库页面（对话与记忆 → 04 表情）。
 *
 * 只做三件事：分页浏览、按标签/名称检索、增删改。
 * 数据全在服务端 SQLite 里，这里不缓存整库 —— 翻多少页都只留最近 600 个格子，
 * 再多就停止追加并提示缩小筛选范围，内存不随收藏量增长。
 */

const STICKER_PAGE_LIMIT = 60;
const STICKER_MAX_TILES = 600;

const stickerState = {
  items: [],
  next: null,
  sort: 'created',
  q: '',
  tag: '',
  stats: null,
  loading: false,
  done: false,
  selected: null
};

function stickerRoot() {
  return $('#sticker-page');
}

function formatBytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function formatDay(value) {
  const stamp = Date.parse(String(value || ''));
  if (!Number.isFinite(stamp)) return '—';
  const date = new Date(stamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function stickerTile(row) {
  const tags = (row.tags || []).slice(0, 3).map((tag) => `<span class="stk-tag">${esc(tag)}</span>`).join('');
  const title = row.desc || row.localNote || '未命名表情';
  return `<button type="button" class="stk-tile${row.lost ? ' is-lost' : ''}" data-stk-id="${esc(row.id)}" title="${esc(title)}">
    <span class="stk-shot"><img loading="lazy" decoding="async" src="/api/stickers/raw/${encodeURIComponent(row.id)}" alt="" /></span>
    <span class="stk-meta"><span class="stk-name">${esc(title)}</span>
      <span class="stk-sub">${formatBytes(row.bytes)} · ${formatDay(row.createdAt)}</span>
      <span class="stk-tags">${tags || '<span class="stk-tag empty">未打标签</span>'}</span>
    </span>
  </button>`;
}

function stickerStatsLine(stats) {
  if (!stats) return '';
  const cap = stats.maxEntries > 0 ? ` / 上限 ${stats.maxEntries}` : ' / 不限制';
  const ratio = stats.maxEntries > 0 ? Math.min(1, stats.count / stats.maxEntries) : 0;
  return `<div class="stk-stats" data-full="${ratio >= 1 ? '1' : '0'}">
    <span class="stk-stat"><b>${stats.count}</b> 条${cap}</span>
    <span class="stk-stat">原图 <b>${formatBytes(stats.bytes)}</b></span>
    <span class="stk-stat">内存窗口 <b>${stats.window}</b>/${stats.windowLimit}</span>
    ${ratio >= 1 ? '<span class="stk-warn">已达上限，机器人暂停自动收藏，手动添加仍可用</span>' : ''}
  </div>`;
}

function renderStickerPage() {
  const root = stickerRoot();
  if (!root) return;
  const tiles = stickerState.items.map(stickerTile).join('');
  root.innerHTML = `
  <div class="stk-head">
    <div class="stk-toolbar">
      <input id="stk-search" class="stk-input" type="search" placeholder="搜名称、标签、id" value="${esc(stickerState.q)}" />
      <input id="stk-tag" class="stk-input stk-input-tag" type="text" placeholder="按标签筛选" value="${esc(stickerState.tag)}" />
      <label class="stk-sort"><span>排序</span>
        <select id="stk-sort">
          <option value="created"${stickerState.sort === 'created' ? ' selected' : ''}>按日期</option>
          <option value="name"${stickerState.sort === 'name' ? ' selected' : ''}>按名称</option>
          <option value="size"${stickerState.sort === 'size' ? ' selected' : ''}>按大小</option>
          <option value="used"${stickerState.sort === 'used' ? ' selected' : ''}>按最近使用</option>
        </select>
      </label>
      <button type="button" class="btn btn-primary btn-small" id="stk-upload">＋ 添加表情</button>
      <button type="button" class="btn btn-small" id="stk-prune" title="清掉没有条目引用的原图">清理无引用原图</button>
      <input id="stk-file" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" hidden />
    </div>
    ${stickerStatsLine(stickerState.stats)}
    <p class="stk-hint" id="stk-hint">收藏表情、插件自动收藏与手动添加都在这里；删除会同时清掉没有其他条目引用的原图。</p>
  </div>
  <div class="stk-grid" id="stk-grid">${tiles || `<p class="stk-empty">${stickerState.loading ? '正在读取…' : '还没有收藏的表情。可以让机器人收藏，或点「添加表情」。'}</p>`}</div>
  <div class="stk-more" id="stk-more">${stickerState.next ? '<button type="button" class="btn btn-small" id="stk-more-btn">加载更多</button>' : (stickerState.items.length ? '<span class="stk-end">已经到底了</span>' : '')}</div>
  <aside class="stk-drawer" id="stk-drawer" hidden></aside>`;
  bindStickerEvents();
  paintStickerDrawer();
}

function bindStickerEvents() {
  const root = stickerRoot();
  if (!root) return;
  $('#stk-sort')?.addEventListener('change', (event) => {
    stickerState.sort = event.target.value;
    loadStickerPage({ reset: true });
  });
  let timer = 0;
  const queue = () => {
    clearTimeout(timer);
    timer = setTimeout(() => loadStickerPage({ reset: true }), 320);
  };
  $('#stk-search')?.addEventListener('input', (event) => { stickerState.q = event.target.value.trim(); queue(); });
  $('#stk-tag')?.addEventListener('input', (event) => { stickerState.tag = event.target.value.trim(); queue(); });
  $('#stk-more-btn')?.addEventListener('click', () => loadStickerPage());
  $('#stk-upload')?.addEventListener('click', () => $('#stk-file')?.click());
  $('#stk-file')?.addEventListener('change', (event) => uploadStickerFile(event.target.files?.[0]));
  $('#stk-prune')?.addEventListener('click', pruneStickers);
  $('#stk-grid')?.addEventListener('click', (event) => {
    const tile = event.target.closest('[data-stk-id]');
    if (!tile) return;
    stickerState.selected = stickerState.items.find((row) => row.id === tile.dataset.stkId) || null;
    paintStickerDrawer();
  });
  $('#stk-drawer')?.addEventListener('click', async (event) => {
    const target = event.target;
    if (target.closest('[data-stk-close]')) { stickerState.selected = null; paintStickerDrawer(); return; }
    if (target.closest('#stk-save')) await saveStickerTags();
    if (target.closest('#stk-delete')) await deleteSticker();
  });
}

function paintStickerDrawer() {
  const drawer = $('#stk-drawer');
  if (!drawer) return;
  const row = stickerState.selected;
  if (!row) { drawer.hidden = true; drawer.innerHTML = ''; return; }
  drawer.hidden = false;
  drawer.innerHTML = `
    <div class="stk-drawer-head"><span>表情详情</span><button type="button" class="stk-x" data-stk-close aria-label="关闭">×</button></div>
    <div class="stk-drawer-body">
      <div class="stk-preview"><img src="/api/stickers/raw/${encodeURIComponent(row.id)}" alt="" /></div>
      <div class="field"><label>名称</label><input id="stk-desc" type="text" maxlength="60" value="${esc(row.desc || '')}" placeholder="给这张表情起个名字" /></div>
      <div class="field"><label>标签</label><input id="stk-tags" type="text" maxlength="120" value="${esc((row.tags || []).join('，'))}" placeholder="用逗号分隔，例如：开心，猫" /></div>
      <div class="field"><label>备注</label><textarea id="stk-note" rows="2" maxlength="160" placeholder="什么时候用">${esc(row.localNote || '')}</textarea></div>
      <dl class="stk-facts">
        <div><dt>大小</dt><dd>${formatBytes(row.bytes)}</dd></div>
        <div><dt>收藏于</dt><dd>${formatDay(row.createdAt)}</dd></div>
        <div><dt>用过</dt><dd>${row.useCount || 0} 次</dd></div>
        <div><dt>来源</dt><dd>${row.source === 'qq' ? 'QQ 收藏' : '本地'}</dd></div>
      </dl>
      <div class="stk-drawer-actions">
        <button type="button" class="btn btn-primary btn-small" id="stk-save">保存标签</button>
        <button type="button" class="btn btn-danger btn-small" id="stk-delete">删除表情</button>
      </div>
      <p class="hint" id="stk-drawer-hint">标签会直接进提示词，机器人按标签挑表情，不逐张看图。</p>
    </div>`;
}

async function loadStickerPage({ reset = false } = {}) {
  if (stickerState.loading) return;
  const root = stickerRoot();
  if (!root) return;
  const first = reset || !stickerState.items.length;
  if (reset) {
    stickerState.items = [];
    stickerState.next = null;
    stickerState.done = false;
  }
  stickerState.loading = true;
  if (first && !stickerState.items.length) renderStickerPage();
  try {
    const params = new URLSearchParams({ sort: stickerState.sort, limit: String(STICKER_PAGE_LIMIT) });
    if (stickerState.q) params.set('q', stickerState.q);
    if (stickerState.tag) params.set('tag', stickerState.tag);
    if (stickerState.next) params.set('offset', String(stickerState.next.offset));
    const result = await api(`/api/stickers/list?${params}`);
    const data = result.data || {};
    stickerState.stats = data.stats || stickerState.stats;
    stickerState.next = data.next || null;
    const incoming = data.items || [];
    const room = Math.max(0, STICKER_MAX_TILES - stickerState.items.length);
    stickerState.items = stickerState.items.concat(incoming.slice(0, room));
    if (incoming.length > room) {
      stickerState.next = null;
      stickerState.done = true;
    }
    renderStickerPage();
  } catch (error) {
    stickerState.loading = false;
    root.innerHTML = `<p class="stk-empty">读取失败：${esc(error.message || error)}</p>`;
    return;
  }
  stickerState.loading = false;
}

async function saveStickerTags() {
  const row = stickerState.selected;
  if (!row) return;
  const tags = String($('#stk-tags')?.value || '').split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean);
  try {
    await api('/api/stickers/tags', {
      method: 'POST',
      body: JSON.stringify({ id: row.id, desc: $('#stk-desc')?.value || '', tags, localNote: $('#stk-note')?.value || '' })
    });
    row.desc = $('#stk-desc')?.value || '';
    row.tags = tags;
    row.localNote = $('#stk-note')?.value || '';
    const hint = $('#stk-drawer-hint');
    if (hint) hint.textContent = '已保存。';
    loadStickerPage({ reset: true });
  } catch (error) {
    const hint = $('#stk-drawer-hint');
    if (hint) hint.textContent = `保存失败：${error.message || error}`;
  }
}

async function deleteSticker() {
  const row = stickerState.selected;
  if (!row) return;
  try {
    await api('/api/stickers/delete', { method: 'POST', body: JSON.stringify({ id: row.id }) });
    stickerState.selected = null;
    stickerState.next = null;
    loadStickerPage({ reset: true });
  } catch (error) {
    const hint = $('#stk-drawer-hint');
    if (hint) hint.textContent = `删除失败：${error.message || error}`;
  }
}

function uploadStickerFile(file) {
  if (!file) return;
  if (file.size > 6 * 1024 * 1024) {
    const hint = $('#stk-hint');
    if (hint) hint.textContent = '图片太大（上限 6 MB）。';
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await api('/api/stickers/upload', {
        method: 'POST',
        body: JSON.stringify({ dataUrl: String(reader.result || ''), desc: file.name.replace(/\.[^.]+$/, '').slice(0, 60) })
      });
      loadStickerPage({ reset: true });
    } catch (error) {
      const hint = $('#stk-hint');
      if (hint) hint.textContent = `添加失败：${error.message || error}`;
    }
  };
  reader.readAsDataURL(file);
}

async function pruneStickers() {
  try {
    const result = await api('/api/stickers/prune', { method: 'POST', body: JSON.stringify({ keepDays: 7 }) });
    const hint = $('#stk-hint');
    if (hint) hint.textContent = `已清理 ${result.data?.removed ?? 0} 个没有条目引用的原图。`;
    loadStickerPage({ reset: true });
  } catch (error) {
    const hint = $('#stk-hint');
    if (hint) hint.textContent = `清理失败：${error.message || error}`;
  }
}

// 首屏如果直接落在表情页（刷新后保持页签），也要能加载。
if (typeof state !== 'undefined' && state.tab === 'stickers' && typeof api === 'function') {
  loadStickerPage({ reset: true });
}
