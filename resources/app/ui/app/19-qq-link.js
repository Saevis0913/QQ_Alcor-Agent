// QQ 接入诊断：把「连不上 QQ」拆成能对症的原因，并在同一个卡片里给出动作。
// 判定来自 /api/qq/diagnosis（服务端与随包排查程序共用同一份 src/qq-diagnosis.js）。
(() => {
  if (typeof document === 'undefined') return;
  const SHORT = {
    ALREADY_CONNECTED: '已连接',
    RECEIVE_NOT_READY: '通道未就绪',
    READY_TO_CONNECT: '可以连接',
    NO_QQ_RUNNING: 'QQ 没在运行',
    UNSUPPORTED_BUILD: 'QQ 版本未适配',
    HOST_PRESENT: '宿主残留',
    FOREIGN_MODULES: '其它框架残留',
    PROCESS_UNREADABLE: '读不到 QQ',
    CORE_OFFLINE: '核心没运行'
  };
  const shortOf = (code) => SHORT[code] || '未连接';
  let busy = false;

  function rowHtml(row) {
    const state = row.supported
      ? (row.verification === 'live' ? '<span class="qq-ok">受支持 · 已实网验证</span>' : '<span class="qq-warn">受支持 · 静态适配</span>')
      : '<span class="qq-bad">版本未适配</span>';
    const notes = [];
    if (row.foreignModules?.length) notes.push(`外来模块：${row.foreignModules.join('、')}`);
    if (row.alcorHostLoaded) notes.push('Alcor 宿主已驻留');
    return `<li><span class="qq-pid">${esc(String(row.pid))}</span>
      <span class="qq-ver">${esc(row.version || '未知版本')}</span>${state}
      ${notes.length ? `<em>${esc(notes.join(' · '))}</em>` : ''}</li>`;
  }

  function cardHtml(v) {
    const cls = v.code === 'ALREADY_CONNECTED' ? 'qq-good' : (v.code === 'READY_TO_CONNECT' ? 'qq-ready' : 'qq-bad');
    const canConnect = ['READY_TO_CONNECT', 'HOST_PRESENT', 'FOREIGN_MODULES'].includes(v.code);
    const dirs = (v.frameworkDirs || []).map((d) => `<li>硬盘上还有 ${esc(d.name)}：<code>${esc(d.path)}</code></li>`).join('');
    return `
      <div class="qq-head ${cls}">
        <strong>${esc(v.title || 'QQ 未连接')}</strong>
        <span class="qq-code">${esc(v.code || '')}</span>
      </div>
      ${v.detail ? `<p class="qq-detail">${esc(v.detail)}</p>` : ''}
      ${v.hint ? `<p class="qq-hint">${esc(v.hint)}</p>` : ''}
      <ul class="qq-procs">${(v.processes || []).map(rowHtml).join('') || '<li class="qq-empty">没有检测到运行中的 QQ</li>'}</ul>
      ${dirs ? `<ul class="qq-dirs">${dirs}</ul>` : ''}
      <div class="qq-acts">
        ${canConnect ? '<button class="btn btn-primary btn-small" data-qq="connect">连接 QQ</button>' : ''}
        <button class="btn btn-small" data-qq="restart">重启 QQ 后重试</button>
        <button class="btn btn-small" data-qq="rescan">重新扫描</button>
        <span class="qq-note">排查程序（安装目录）：「控制台无法连接，显示被占用点这个，对照最后一行判定码.cmd」</span>
      </div>
      <p class="qq-status" role="status"></p>`;
  }

  async function paint(box, { fresh = false } = {}) {
    box.innerHTML = '<p class="qq-detail">正在读取 QQ 进程…</p>';
    try {
      const result = await api('/api/qq/diagnosis');
      const v = result.data || {};
      box.innerHTML = cardHtml(v);
      bind(box, v);
    } catch (error) {
      box.innerHTML = `<p class="qq-hint">读取失败：${esc(String(error?.message || error))}</p>`;
    }
  }

  function setStatus(box, text) {
    const node = box.querySelector('.qq-status');
    if (node) node.textContent = text;
  }

  function bind(box, v) {
    box.querySelectorAll('[data-qq]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        const kind = button.dataset.qq;
        box.querySelectorAll('[data-qq]').forEach((b) => { b.disabled = true; });
        try {
          if (kind === 'connect') {
            setStatus(box, '正在连接 QQ…');
            const result = await api('/api/qq/connect', { method: 'POST', body: JSON.stringify({ pid: v.candidate?.pid }) });
            setStatus(box, result.status === 'ok' ? '已提交连接，正在确认账号…' : `连接失败：${result.error || result.wording || '未知原因'}`);
          } else if (kind === 'restart') {
            setStatus(box, '正在关闭 QQ 并重新启动，最多等 40 秒…');
            const result = await api('/api/qq/restart', { method: 'POST', body: '{}' });
            setStatus(box, result.status === 'ok' ? `QQ 已重启（${result.data?.processes ?? 0} 个进程）` : `重启失败：${result.error || result.wording || '未知原因'}`);
          } else {
            setStatus(box, '正在重新扫描…');
          }
          await paint(box, { fresh: true });
          if (typeof refreshStatus === 'function') refreshStatus();
        } catch (error) {
          setStatus(box, `操作失败：${String(error?.message || error)}`);
        } finally {
          busy = false;
          box.querySelectorAll('[data-qq]').forEach((b) => { b.disabled = false; });
        }
      });
    });
  }

  window.renderQqLinkCard = function renderQqLinkCard() {
    const box = document.getElementById('qq-link-card');
    if (!box) return;
    paint(box);
  };

  document.addEventListener('DOMContentLoaded', () => window.renderQqLinkCard());
  window.qqShortOf = shortOf;
})();
