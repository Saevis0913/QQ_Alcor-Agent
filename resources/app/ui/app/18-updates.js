// 自动更新：发现新版本时在顶栏下方横幅提示，一键下载（带进度）→ 校验 → 重启安装。
// 只读 /api/update-status 轮询，不主动联网；检查由后端启动时静默完成。
(() => {
  if (typeof document === 'undefined') return;
  const POLL_MS = 60_000;
  const FAST_MS = 900;
  let banner = null;
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
    UPDATE_RELEASE_PENDING: '更新源正在发布中，请稍后再试'
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

  function paint() {
    const el = ensureBanner();
    if (!status || !status.hasUpdate) { hide(); return; }
    const phase = status.phase || 'idle';
    const latest = status.latest ? `v${status.latest}` : '新版本';
    const current = status.current ? `当前 v${status.current}` : '';
    let detail = '';
    let action = '';
    if (phase === 'downloading') {
      detail = `正在下载安装包… ${pct(status.progress)}`;
      action = '<button class="btn btn-small" id="update-action" disabled>下载中</button>';
    } else if (phase === 'ready') {
      detail = `安装包已校验${status.readyBytes ? `（${fmtBytes(status.readyBytes)}）` : ''}，重启后自动安装`;
      action = '<button class="btn btn-primary btn-small" id="update-action">立即重启并安装</button>';
    } else if (phase === 'installing') {
      detail = '正在退出并交给安装程序，稍后会自动打开新版本';
      action = '<button class="btn btn-small" id="update-action" disabled>安装中</button>';
    } else if (phase === 'error') {
      detail = `更新失败：${codeText(status.error)}`;
      action = '<button class="btn btn-small" id="update-action">重试下载</button>';
    } else {
      detail = status.notes ? String(status.notes).split('\n')[0].slice(0, 80) : '可以一键下载并自动升级，数据与设置都会保留';
      action = '<button class="btn btn-primary btn-small" id="update-action">下载并更新</button>';
    }
    el.hidden = false;
    el.innerHTML = `
      <span class="ub-dot" aria-hidden="true"></span>
      <span class="ub-text"><b>发现新版本 ${latest}</b><span class="ub-sub">${escapeHtml(current)}${current ? ' · ' : ''}${escapeHtml(detail)}</span></span>
      <span class="ub-actions">
        ${status.projectUrl ? `<a class="btn btn-small" href="${escapeAttr(status.projectUrl + '/releases')}" target="_blank" rel="noreferrer">更新说明</a>` : ''}
        ${action}
        <button class="btn btn-small btn-line" id="update-later">稍后</button>
      </span>`;
    el.querySelector('#update-action')?.addEventListener('click', act);
    el.querySelector('#update-later')?.addEventListener('click', () => {
      hide();
      setTimeout(poll, 30 * 60_000);
    });
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
    } catch (error) {
      status = { ...(status || {}), phase: 'error', error: String(error?.message || error) };
      paint();
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
    const delay = status && (status.phase === 'downloading' || status.phase === 'installing') ? FAST_MS : POLL_MS;
    timer = setTimeout(poll, delay);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function escapeAttr(value) { return escapeHtml(value); }

  document.addEventListener('DOMContentLoaded', () => setTimeout(poll, 1200), { once: true });
  if (document.readyState !== 'loading') setTimeout(poll, 1200);
})();
