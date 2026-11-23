// 更新提示：默认不自动下载/安装（配置 update.mode = "notify"）。
// 启动时后端静默检查，发现新版本 → 顶部横幅 + 一次弹窗（版本号、当前版本、更新概括、立即更新 / 暂不更新）。
// 点「暂不更新」或关闭弹窗 = 本次启动不再提示（POST /api/update-dismiss），重启后同一版本会再提示。
// 只有用户点「立即更新」才下载 → 校验 → 拉起安装器；update.mode = "auto" 才会回到自动安装。
(() => {
  if (typeof document === 'undefined') return;
  const POLL_MS = 20_000;
  const FAST_MS = 900;
  const SNOOZE_MS = 30 * 60_000;
  let banner = null;
  let modal = null;
  let promptedFor = '';
  let status = null;
  let timer = null;
  let busy = false;

  const CODE_TEXT = {
    UPDATE_DOWNLOAD_FAILED: '下载中断，请检查网络后重试',
    UPDATE_DOWNLOAD_TIMEOUT: '下载超时，请重试',
    UPDATE_TOO_LARGE: '安装包超过大小上限，已停止',
    UPDATE_HASH_MISMATCH: '安装包校验失败，已丢弃',
    UPDATE_HASH_UNAVAILABLE: '这个版本没有附带校验文件，已停止',
    UPDATE_HOST_NOT_ALLOWED: '更新地址不在允许范围，已停止',
    UPDATE_PAYLOAD_MISSING: '安装包不在本地，请重新下载',
    UPDATE_NOTHING_TO_DOWNLOAD: '当前没有可下载的新版本',
    UPDATE_MANIFEST_INVALID: '更新信息格式无效',
    UPDATE_RELEASE_PENDING: '更新源正在发布中，请稍后再试',
    UPDATE_ALL_SOURCES_FAILED: '所有更新源都连不上，稍后会自动重试（也可以让 AI 换源）',
    UPDATE_SOURCE_NOT_CONFIGURED: '还没配置更新源',
    UPDATE_AI_NO_PLAN: 'AI 没能给出可用的下载地址',
    UPDATE_REPAIR_UNAVAILABLE: '当前没有可修复的更新任务',
    UPDATE_REPAIR_FAILED: 'AI 换源后仍然没能装好'
  };
  const codeText = (code) => CODE_TEXT[code] || code || '未知原因';

  const pct = (value) => `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`;
  const fmtBytes = (bytes) => {
    const n = Number(bytes) || 0;
    if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${n} B`;
  };

  function ensureBanner() {
    if (banner) return banner;
    banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.className = 'update-banner';
    banner.hidden = true;
    const main = document.querySelector('main') || document.body;
    const topbar = document.getElementById('topbar');
    if (topbar && topbar.parentNode) topbar.parentNode.insertBefore(banner, topbar.nextSibling);
    else main.prepend(banner);
    return banner;
  }

  function hide() {
    if (banner) banner.hidden = true;
  }

  function summaryLines() {
    if (Array.isArray(status?.summary) && status.summary.length) return status.summary;
    return String(status?.notes || '').split('\n').map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('|'))
      .map((line) => line.replace(/^[-*+]\s+/, ''))
      .slice(0, 4);
  }

  function closeModal() {
    if (!modal) return;
    const el = modal;
    modal = null;
    el.classList.add('closing');
    setTimeout(() => el.remove(), 220);
  }

  function openModal() {
    if (modal || !status) return;
    const latest = status.latest ? `v${status.latest}` : '新版本';
    const current = status.current ? `当前 v${status.current}${status.core ? ` / 核心 ${status.core}` : ''}` : '';
    const published = status.publishedAt ? `发布于 ${String(status.publishedAt).replace('T', ' ').slice(0, 16)}` : '';
    const lines = summaryLines();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="update-modal-title" style="width:min(560px,92vw)">
        <div class="modal-head">
          <h3 id="update-modal-title">发现新版本 ${escapeHtml(latest)}</h3>
          <button class="modal-close" id="update-modal-close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="modal-body">
          <p class="hint">${escapeHtml([current, published].filter(Boolean).join(' · '))}</p>
          <div class="hint" style="font-weight:600">这个版本改了什么</div>
          ${lines.length ? `<ul class="update-summary">${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : '<p class="hint">更新说明还没取到，可以在「设置 → 更新与 GitHub」里点「检查更新」查看。</p>'}
          <p class="hint">点「立即更新」后才会下载安装包（约 300 MB），下载完自动校验 SHA-256 并安装；安装会重启应用，聊天记录与设置都保留。</p>
        </div>
        <div class="modal-foot">
          <button class="btn" id="update-modal-later" type="button">暂不更新</button>
          <button class="btn btn-primary" id="update-modal-now" type="button">立即更新</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    modal = overlay;
    overlay.querySelector('#update-modal-close')?.addEventListener('click', () => dismiss('close'));
    overlay.querySelector('#update-modal-later')?.addEventListener('click', () => dismiss('later'));
    overlay.querySelector('#update-modal-now')?.addEventListener('click', () => { closeModal(); act(); });
    overlay.addEventListener('click', (event) => { if (event.target === overlay) dismiss('backdrop'); });
    overlay.addEventListener('keydown', (event) => { if (event.key === 'Escape') dismiss('escape'); });
    overlay.querySelector('#update-modal-now')?.focus();
  }

  async function dismiss() {
    closeModal();
    hide();
    if (status) {
      promptedFor = String(status.latest || '');
      status = { ...status, prompt: false };
    }
    await api('/api/update-dismiss', { method: 'POST', body: '{}' }).catch(() => {});
    clearTimeout(timer);
    timer = setTimeout(poll, SNOOZE_MS);
  }

  function paint() {
    const el = ensureBanner();
    if (!status || !status.hasUpdate) { hide(); closeModal(); return; }
    const phase = status.phase || 'idle';
    if (phase === 'idle' && status.prompt === false) { hide(); closeModal(); return; }
    const latest = status.latest ? `v${status.latest}` : '新版本';
    const current = status.current ? `当前 v${status.current}${status.core ? ` / 核心 ${status.core}` : ''}` : '';
    let detail = '';
    let action = '';
    if (phase === 'downloading') {
      detail = `正在下载安装包… ${pct(status.progress)}`;
      action = '<button class="btn btn-small" id="update-action" disabled>下载中</button>';
    } else if (phase === 'ready') {
      detail = `安装包已校验${status.readyBytes ? `（${fmtBytes(status.readyBytes)}）` : ''}，重启后安装`;
      action = '<button class="btn btn-primary btn-small" id="update-action">立即重启并安装</button>';
    } else if (phase === 'installing') {
      detail = '正在退出并交给安装程序，稍后会自动打开新版本';
      action = '<button class="btn btn-small" id="update-action" disabled>安装中</button>';
    } else if (phase === 'error') {
      detail = status.repair === 'asking-ai'
        ? '下载失败，正在让 AI 寻找可用下载源…'
        : `更新失败：${codeText(status.error)}（可以让 AI 换一条下载源）`;
      action = '<button class="btn btn-primary btn-small" id="update-action">重试 / 让 AI 修复</button>';
    } else {
      const line = summaryLines()[0] || '';
      detail = line ? line.slice(0, 80) : '点「立即更新」才会下载安装，不点就保持当前版本';
      action = '<button class="btn btn-primary btn-small" id="update-action">立即更新</button>';
    }
    el.hidden = false;
    el.innerHTML = `
      <span class="ub-dot" aria-hidden="true"></span>
      <span class="ub-text"><b>发现新版本 ${latest}</b><span class="ub-sub">${escapeHtml(current)}${current ? ' · ' : ''}${escapeHtml(detail)}</span></span>
      <span class="ub-actions">
        ${status.projectUrl ? `<a class="btn btn-small" href="${escapeAttr(status.projectUrl + '/releases')}" target="_blank" rel="noreferrer">更新说明</a>` : ''}
        ${action}
        <button class="btn btn-small btn-line" id="update-later">暂不更新</button>
      </span>`;
    el.querySelector('#update-action')?.addEventListener('click', act);
    el.querySelector('#update-later')?.addEventListener('click', () => dismiss('later'));
  }

  async function act() {
    if (busy || !status) return;
    busy = true;
    try {
      if (status.phase === 'ready') {
        await api('/api/update-install', { method: 'POST', body: '{}' }).catch(() => {});
        status = { ...status, phase: 'installing' };
        paint();
        return;
      }
      status = { ...status, phase: 'downloading', progress: 0 };
      paint();
      const job = api('/api/update-download', { method: 'POST', body: '{}' });
      const tick = setInterval(async () => {
        const next = await api('/api/update-status').catch(() => null);
        if (next) { status = next; paint(); }
      }, FAST_MS);
      try {
        await job;
      } finally {
        clearInterval(tick);
      }
      status = await api('/api/update-status').catch(() => status);
      paint();
      // 用户是点了「立即更新」才走到这里的：下载校验完直接装，不再让他点第二次。
      if (status?.phase === 'ready') {
        status = { ...status, phase: 'installing' };
        paint();
        await api('/api/update-install', { method: 'POST', body: '{}' }).catch(() => {});
        return;
      }
    } catch (error) {
      status = { ...(status || {}), phase: 'error', error: String(error?.message || error) };
      paint();
      // 常规下载失败后立刻让已配置的模型给一条备用直链，用户不需要再点一次。
      try {
        status = { ...status, repair: 'asking-ai' };
        paint();
        await api('/api/update-repair', { method: 'POST', body: '{}' });
        status = await api('/api/update-status').catch(() => status);
        paint();
      } catch (repairError) {
        status = { ...status, repair: 'failed', error: String(repairError?.message || status.error || '') };
        paint();
      }
    } finally {
      busy = false;
    }
  }

  async function poll() {
    clearTimeout(timer);
    try {
      const next = await api('/api/update-status');
      if (next) { status = next; paint(); }
    } catch { /* 后端未就绪：下轮再试 */ }
    const phase = status?.phase || 'idle';
    if (status?.hasUpdate && phase === 'idle' && status.prompt !== false && promptedFor !== String(status.latest || '')) {
      promptedFor = String(status.latest || '');
      openModal();
    }
    const delay = phase === 'downloading' || phase === 'installing' ? FAST_MS : POLL_MS;
    timer = setTimeout(poll, delay);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function escapeAttr(value) { return escapeHtml(value); }

  document.addEventListener('DOMContentLoaded', () => setTimeout(poll, 1200), { once: true });
  if (document.readyState !== 'loading') setTimeout(poll, 1200);
})();
