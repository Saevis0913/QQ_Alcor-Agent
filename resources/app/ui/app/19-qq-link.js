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
    QQ_BUILD_UNLISTED: 'QQ 未登记可试',
    HOST_PRESENT: '宿主残留',
    FOREIGN_MODULES: '其它框架残留',
    PROCESS_UNREADABLE: '读不到 QQ',
    CORE_OFFLINE: '核心没运行',
    ELEVATION_MISMATCH: '权限不一致',
    SESSION_MISMATCH: '会话不一致',
    ARCH_MISMATCH: 'QQ 非 64 位',
    HOST_RUNTIME_BROKEN: '注入组件缺失',
    INJECTION_BLOCKED: '注入被拦'
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
      ${compatHtml(v)}
      ${dirs ? `<ul class="qq-dirs">${dirs}</ul>` : ''}
      <div class="qq-acts">
        <button class="btn btn-primary btn-small" data-qq="auto">一键检测并连接</button>
        ${canConnect ? '<button class="btn btn-small" data-qq="connect">只连接这一个</button>' : ''}
        <button class="btn btn-small" data-qq="restart">重启 QQ 后重试</button>
        <button class="btn btn-small" data-qq="rescan">重新扫描</button>
        <span class="qq-note">排查程序（安装目录）：「控制台无法连接，显示被占用点这个，对照最后一行判定码.cmd」</span>
      </div>
      <p class="qq-status" role="status"></p>`;
  }

  // 环境事实：版本与外来框架之外，真正让注入失败的东西（权限/会话/安全策略/注入器）。
  function compatHtml(v) {
    const c = v.compat;
    if (!c) return '';
    const bits = [];
    if (c.os?.version) bits.push(`系统 ${esc(c.os.version)}${c.os.arch ? ' · ' + esc(c.os.arch) : ''}`);
    if (c.self) bits.push(`Alcor 会话 ${esc(String(c.self.sessionId))} · ${c.self.elevated ? '管理员' : '普通权限'}`);
    if (c.qq?.length) bits.push(c.qq.map((q) => `QQ ${esc(String(q.pid))} · ${esc(q.arch || '未知架构')}${q.store ? ' · 商店版' : ''}`).join('；'));
    const loader = c.loader || {};
    bits.push(loader.ran ? '注入器可运行' : `注入器不可用（${esc(loader.reason || '未知')}）`);
    bits.push(c.hostDll?.ok ? '宿主 DLL 正常' : '宿主 DLL 缺失');
    const sec = c.security || {};
    if (sec.hvci === 1) bits.push('内存完整性已开启');
    if (sec.smartAppControl === 1 || sec.smartAppControl === 2) bits.push('智能应用控制已开启');
    if (sec.defender?.realtime === false) bits.push('Defender 实时保护关闭');
    const warn = (v.warnings || []).filter(Boolean);
    return `<p class="qq-compat">${bits.join(' · ')}</p>${warn.length ? `<p class="qq-warnline">注意：${esc(warn.join('、'))}</p>` : ''}`;
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
    if (!node) return;
    node.textContent = text;
    node.style.whiteSpace = 'pre-wrap';
  }

  function bind(box, v) {
    box.querySelectorAll('[data-qq]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        const kind = button.dataset.qq;
        box.querySelectorAll('[data-qq]').forEach((b) => { b.disabled = true; });
        try {
          if (kind === 'auto' || kind === 'force') {
            setStatus(box, kind === 'force' ? '正在按兼容模式尝试注入（QQ 可能会重启）…' : '正在按顺序检查并连接，最长约一分钟…');
            const body = kind === 'force' ? JSON.stringify({ allowUnverified: true }) : '{}';
            const result = await api('/api/qq/autoconnect', { method: 'POST', body });
            const data = result.data || {};
            const lines = (data.steps || []).map((step) => (step.status === 'error' ? '✗ ' : step.status === 'manual' ? '! ' : step.status === 'retry' ? '↻ ' : '· ') + step.text);
            const tail = data.code === 'ALREADY_CONNECTED' ? '已连接，完成。' : data.code === 'CONNECTED' ? '注入成功，正在确认账号…' : data.code === 'WAITING_LOGIN' ? 'QQ 已打开，登录后在下面点「重新扫描」。' : '结果：' + (data.code || '未知');
            setStatus(box, [...lines, tail].join('\n'));
            await paint(box, { fresh: true });
            const fresh = { ...v };
            if (data.needConsent) {
              const acts = box.querySelector('.qq-acts');
              if (acts && !acts.querySelector('[data-qq="force"]')) {
                const btn = document.createElement('button');
                btn.className = 'btn btn-primary btn-small';
                btn.dataset.qq = 'force';
                btn.textContent = '仍然尝试注入';
                acts.prepend(btn);
              }
            }
            if (data.canRelaunchAdmin) {
              const acts = box.querySelector('.qq-acts');
              if (acts && !acts.querySelector('[data-qq="admin"]')) {
                const btn = document.createElement('button');
                btn.className = 'btn btn-small';
                btn.dataset.qq = 'admin';
                btn.textContent = '以管理员重启';
                acts.prepend(btn);
              }
            }
            bind(box, fresh);
            if (typeof refreshStatus === 'function') refreshStatus();
            return;
          }
          if (kind === 'admin') {
            setStatus(box, '正在以管理员身份重启…');
            const result = await api('/api/app/relaunch-admin', { method: 'POST', body: '{}' });
            setStatus(box, result.status === 'ok' ? '已请求提权启动，稍等新窗口出现后再点「重新扫描」。' : '提权失败：' + (result.error || result.wording || '未知原因'));
            return;
          }
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
