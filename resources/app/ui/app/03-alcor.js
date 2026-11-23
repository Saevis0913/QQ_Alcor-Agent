// Alcor management and local console access.
'use strict';
let alcorReloadTimer = null;
let alcorAccessEpoch = 0;
function clearAlcorAccessToken() {
  alcorAccessEpoch++;
  const input = $('#alcor-access-token');
  if (input) { input.value = ''; input.type = 'password'; }
  const button = $('#alcor-token-show'); if (button) button.textContent = '显示令牌';
}
window.addEventListener('pagehide', clearAlcorAccessToken);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearAlcorAccessToken(); });

async function readAlcorAccess() {
  const result = await api('/api/alcor/connection');
  if (typeof result.token !== 'string' || !result.token) throw new Error('Alcor 访问令牌尚未配置。');
  return result;
}
async function copyAlcorToken(value) {
  try { await navigator.clipboard.writeText(value); return true; } catch { /* Older or restricted clipboard: use the local selection fallback. */ }
  const textarea = document.createElement('textarea');
  textarea.className = 'alcor-copy-target'; textarea.value = value; textarea.readOnly = true;
  document.body.append(textarea); textarea.select();
  try { return document.execCommand('copy') === true; } catch { return false; }
  finally { textarea.value = ''; textarea.remove(); }
}

async function showAlcorAccessGuide() {
  const config = await api('/api/config');
  if (config.ui?.alcorAccessGuideSeen === true || $('#alcor-access-guide')) return;
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.id = 'alcor-access-guide'; dialog.className = 'alcor-access-guide';
  dialog.setAttribute('aria-labelledby', 'alcor-guide-title');
  dialog.innerHTML = `
    <h2 id="alcor-guide-title">控制台访问，不用再找令牌</h2>
    <p>在 <strong>Alcor 框架</strong> 页点击“打开控制台（免输令牌）”，即可直接进入。</p>
    <p>需要手动登录时，同一页也能显示或复制访问令牌。令牌属于当前 Alcor 配置，并不绑定机器；复制配置时，令牌也会一起复制。</p>
    <div class="alcor-actions"><button class="btn btn-primary" id="alcor-guide-go">前往 Alcor 框架</button><button class="btn" id="alcor-guide-dismiss">知道了</button></div>
    <p class="hint">关闭后不再自动显示，入口会一直保留在框架页。</p>`;
  document.body.append(dialog);
  let closing = false;
  const dismiss = async (go) => {
    if (closing) return; closing = true;
    try { await api('/api/alcor/access-guide/dismiss', { method: 'POST', body: '{}' }); }
    catch { /* Keep the app usable if persistence fails; the guide can reappear next launch. */ }
    dialog.close(); dialog.remove();
    if (go) { switchTab('alcor'); document.querySelector('[data-tab="alcor"]')?.focus(); }
    else if (previousFocus?.isConnected) previousFocus.focus();
  };
  dialog.querySelector('#alcor-guide-go').onclick = () => dismiss(true);
  dialog.querySelector('#alcor-guide-dismiss').onclick = () => dismiss(false);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(false); });
  dialog.showModal();
}
function scheduleAlcorReload() {
  if (alcorReloadTimer) return;
  alcorReloadTimer = setTimeout(() => { alcorReloadTimer = null; loadAlcorPage({ quiet: true }); }, 400);
}
async function refreshAlcorLogs() {
  const pre = $('#alcor-logs-view'); if (!pre) return;
  try {
    const result = await api('/api/alcor/logs');
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
    pre.textContent = (result.logs || []).map(line => `[${new Date(line.at).toLocaleTimeString('zh-CN', { hour12: false })}] ${line.text}`).join('\n') || '暂无核心运行日志';
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  } catch { /* Status refresh reports connection failures. */ }
}
async function loadAlcorPage({ quiet = false } = {}) {
  const box = $('#alcor-page'); if (!box) return;
  clearAlcorAccessToken();
  try {
    const status = await api('/api/status');
    if (status.onebotEdition) {
      renderOneBotEdition(box, status, quiet);
      return;
    }
    const core = status.alcor || {};
    const connected = status.onebot?.connected === true;
    box.innerHTML = `
      <div class="alcor-page-card">
        <h2>Alcor 框架</h2>
        <p class="hint">Alcor Agent 启动时自动连接所配置的 Alcor 核心。下方分别显示核心、QQ 后端和 Agent 事件连接的状态。</p>
        <div class="alcor-state-row"><span class="dot ${core.running ? 'dot-on' : 'dot-off'}"></span><span>Alcor 核心：<strong>${core.running ? '运行中' : '未连接'}</strong></span><span class="muted">${core.embedded ? '由本 Agent 启动，退出时一并关闭' : core.running ? '复用外部实例，退出时保留' : ''}</span></div>
        <div class="alcor-state-row"><span class="dot ${core.backendReady ? 'dot-on' : 'dot-off'}"></span><span>QQ 后端：<strong>${core.backendReady ? '账号在线' : '尚未就绪'}</strong></span></div>
        <div class="alcor-state-row"><span class="dot ${connected ? 'dot-on' : 'dot-off'}"></span><span>Agent 事件连接：<strong>${connected ? '已连接' : '未连接'}</strong></span></div>
        <p class="hint">${esc(status.onebot?.diagnosis || core.error || '核心与账号状态已更新。')}</p>
        <div class="alcor-actions">
          <button class="btn btn-primary" id="quick-start-btn" ${core.running ? 'disabled' : ''}>${core.running ? 'Alcor 已启动' : '启动 Alcor'}</button>
          <button class="btn btn-danger" id="alcor-stop-btn" ${core.embedded ? '' : 'disabled'}>停止本 Agent 的核心</button>
          <button class="btn btn-small" id="alcor-refresh-btn">刷新状态</button>
          <button class="btn btn-small" id="alcor-panel-btn" ${core.running ? '' : 'disabled'}>打开控制台（免输令牌）</button>
          <button class="btn btn-small" id="alcor-folder-btn">打开核心文件夹</button><button class="btn btn-small" id="alcor-environment-btn">安装导航与环境检测</button>
        </div>
        <p id="alcor-action-hint" class="hint" role="status"></p>
        <section class="alcor-access-card" aria-labelledby="alcor-access-title">
          <h3 id="alcor-access-title">控制台访问</h3>
          <p class="hint">平时点击上方“打开控制台（免输令牌）”即可。手动打开登录页时，可在这里复制令牌。</p>
          <label for="alcor-access-token">Alcor 访问令牌</label>
          <div class="alcor-access-field"><input id="alcor-access-token" type="password" readonly autocomplete="off" spellcheck="false" placeholder="点击显示或复制，无需打开配置文件"><button class="btn" id="alcor-token-show">显示令牌</button><button class="btn btn-primary" id="alcor-token-copy">复制令牌</button></div>
          <p id="alcor-access-hint" class="hint" role="status">令牌属于当前 Alcor 配置，不绑定电脑；复制配置会沿用同一令牌。</p>
        </section>
        <hr class="sl-sep">
        <h3>QQ 后端登录</h3>
        <p class="hint">在 Alcor 控制台的“QQ 接入”中可查看当前会话的连接状态与诊断结果。</p>
        <p class="hint">首次打开此副本会暂停自动回复。确认旧 Agent 已暂停或退出后，点击顶部“恢复”；模型、人格、会话及插件设置仍在原来的页签。</p>
        <hr class="sl-sep">
        <div class="alcor-state-row muted">核心目录：${esc(core.dir || '')}</div>
        <div class="alcor-state-row muted">控制台：${esc(core.webuiUrl || '')}</div>
        <p class="hint">连接信息自动读取当前选择的 Alcor 配置。访问令牌在上方按需显示或复制。</p>
        <div class="sl-log-block"><div class="hint sl-log-head">Alcor 核心日志</div><pre class="alcor-logs-view" id="alcor-logs-view">正在读取…</pre></div>
      </div>`;
    const action = (id, route) => {
      const button = $('#' + id); if (!button) return;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const result = await api(route, { method: 'POST', body: '{}' });
          if (result.ok === false) throw new Error(result.error || '操作未完成');
          if (route.endsWith('/launch') || route.endsWith('/stop')) { await refreshStatus(); await loadAlcorPage({ quiet: true }); }
          else $('#alcor-action-hint').textContent = '已打开。';
        } catch (error) { const hint = $('#alcor-action-hint'); if (hint) hint.textContent = String(error.message || error); }
        finally { if (button.isConnected) button.disabled = false; }
      });
    };
    action('quick-start-btn', '/api/alcor/launch'); action('alcor-stop-btn', '/api/alcor/stop');
    action('alcor-panel-btn', '/api/alcor/open-webui'); action('alcor-folder-btn', '/api/alcor/open-folder');
    const input = $('#alcor-access-token'), show = $('#alcor-token-show'), copy = $('#alcor-token-copy'), hint = $('#alcor-access-hint');
    show.addEventListener('click', async () => {
      if (input.type === 'text') { clearAlcorAccessToken(); hint.textContent = '令牌已隐藏。'; return; }
      const epoch = alcorAccessEpoch; show.disabled = true;
      try {
        const access = await readAlcorAccess();
        if (epoch !== alcorAccessEpoch || !input.isConnected || state.tab !== 'alcor') return;
        input.value = access.token; input.type = 'text'; show.textContent = '隐藏令牌'; hint.textContent = '可直接复制此令牌到 Alcor 控制台。';
      } catch (error) { if (hint.isConnected) hint.textContent = String(error.message || error); }
      finally { show.disabled = false; }
    });
    copy.addEventListener('click', async () => {
      const epoch = alcorAccessEpoch; copy.disabled = true;
      try {
        const access = await readAlcorAccess();
        if (epoch !== alcorAccessEpoch || !input.isConnected || state.tab !== 'alcor') return;
        const copied = await copyAlcorToken(access.token);
        if (epoch !== alcorAccessEpoch || !input.isConnected || state.tab !== 'alcor') return;
        if (copied) hint.textContent = '令牌已复制，可直接粘贴到 Alcor 控制台。';
        else { input.value = access.token; input.type = 'text'; show.textContent = '隐藏令牌'; input.focus(); input.select(); hint.textContent = '浏览器未允许自动复制，请手动复制已选中的令牌（Ctrl+C）。'; }
      } catch (error) { if (hint.isConnected) hint.textContent = String(error.message || error); }
      finally { copy.disabled = false; }
    });
    $('#alcor-environment-btn').addEventListener('click', () => showInstallationGuide());
    $('#alcor-refresh-btn').addEventListener('click', () => loadAlcorPage());
    await refreshAlcorLogs();
    if (typeof enhanceConcept2UI === 'function') enhanceConcept2UI(box);
  } catch (error) { if (!quiet) box.textContent = `无法读取 Alcor 状态：${String(error.message || error)}`; }
}

function renderOneBotEdition(box, status, quiet) {
  const { httpUrl, wsUrl, hasToken, hasHttpToken } = status.onebotEdition;
  const account = status.onebot?.self?.userId;
  const connected = status.onebot?.connected === true;
  const connectionState = account && connected ? `已连接账号 ${account}`
    : status.onebot?.diagnosis || (connected ? '正在确认账号' : '尚未连接');
  if (quiet && box.querySelector('#onebot-connection-form')) {
    box.querySelector('#onebot-edition-state').textContent = connectionState;
    return;
  }
  box.innerHTML = `<section class="alcor-page-card">
    <h2>OneBot 连接</h2>
    <p class="hint">填写你有权使用的本机 OneBot v11 服务地址。</p>
    <p id="onebot-edition-state" role="status">${esc(connectionState)}</p>
    <form id="onebot-connection-form">
      <div class="field"><label for="onebot-http">HTTP API 地址</label>
        <input id="onebot-http" type="url" value="${esc(httpUrl)}" placeholder="http://127.0.0.1:3000" required></div>
      <div class="field"><label for="onebot-ws">WebSocket 事件地址</label>
        <input id="onebot-ws" type="url" value="${esc(wsUrl)}" placeholder="ws://127.0.0.1:3001" required></div>
      <div class="field"><label for="onebot-token">通用访问令牌</label>
        <input id="onebot-token" type="password" autocomplete="off" placeholder="${hasToken ? '留空沿用已保存的令牌' : '后端未要求时可留空'}"></div>
      <div class="field"><label for="onebot-http-token">HTTP 专用令牌（可选）</label>
        <input id="onebot-http-token" type="password" autocomplete="off" placeholder="${hasHttpToken ? '留空保留已保存的 HTTP 令牌' : '默认使用通用令牌'}"></div>
      <label class="checkbox-row"><input id="onebot-clear-token" type="checkbox">清除两个已保存的令牌</label>
      <div class="alcor-actions">
        <button class="btn btn-primary" type="submit">保存并连接</button>
        <button class="btn" type="button" id="onebot-environment">安装导航与环境检测</button>
      </div>
      <p class="hint" id="onebot-edition-result" role="status"></p>
    </form>
  </section>`;
  const form = box.querySelector('#onebot-connection-form');
  form.querySelector('#onebot-environment').addEventListener('click', () => showInstallationGuide());
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const hint = form.querySelector('#onebot-edition-result');
    const token = form.querySelector('#onebot-token');
    const httpToken = form.querySelector('#onebot-http-token');
    const clear = form.querySelector('#onebot-clear-token');
    const input = { httpUrl: form.querySelector('#onebot-http').value.trim(), wsUrl: form.querySelector('#onebot-ws').value.trim() };
    if (clear.checked || token.value) input.accessToken = clear.checked ? '' : token.value;
    if (clear.checked || httpToken.value) input.httpAccessToken = clear.checked ? '' : httpToken.value;
    button.disabled = true;
    hint.textContent = '正在保存…';
    try {
      await api('/api/onebot/connection', { method: 'POST', headers: { 'content-type': 'application/json',
        'x-console-token': CONSOLE_MARKER, 'x-alcor-local-action': 'configure-onebot' }, body: JSON.stringify(input) });
      token.value = '';
      httpToken.value = '';
      clear.checked = false;
      hint.textContent = '已保存。连接进度见上方账号状态。';
      await refreshStatus();
      await loadAlcorPage();
    } catch (error) { hint.textContent = String(error.message || error); }
    finally { button.disabled = false; }
  });
  if (typeof enhanceConcept2UI === 'function') enhanceConcept2UI(box);
}
