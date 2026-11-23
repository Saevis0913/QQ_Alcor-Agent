const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const pages = {
  overview: ['总览', '查看 QQ 接入、OneBot 连接及核心服务状态。'],
  processes: ['QQ 接入', '扫描本机 QQ 进程并管理原生连接。'],
  nodes: ['OneBot 节点', '配置 OneBot 监听地址，查看当前运行的接入信息。'],
  logs: ['运行日志', '搜索核心日志、筛选级别或导出记录。'],
  settings: ['系统设置', '调整控制台显示方式，查看本机访问设置。'],
  debug: ['调试工具', '调用 OneBot 动作、查看事件摘要和接口目录。']
};
let token = '', epoch = 0, active = 'overview', timer, refreshTask, lastInfo;
let settings = { theme: 'system', accent: 'violet', oled: false, compact: false, ...ConsoleTheme.read() };
let logs = [], actions = [], eventSocket, eventRows = [], noticeTimer;
let transportDraft = { httpCallbacks: [], reverseWebSockets: [] };
const pending = new Set();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const errors = {
  UNAUTHORIZED: '令牌无效，请重新粘贴本地访问令牌。',
  UNSUPPORTED_QQ: '当前 QQ 版本不受支持，请查看进程信息。',
  QQ_LOGIN_NOT_CONFIRMED: '核心未确认当前 QQ 账号。请核对客户端登录状态，并在连接排查中查看同次尝试的身份结果和时间。',
  QQ_SESSION_CONFLICT: 'QQ 进程里仍驻留着其他框架注入的模块，原生接入读不到 QQ 的服务对象。请完全退出这些框架并重启 QQ 客户端，再回来连接。',
  HOST_ALREADY_PRESENT: '该进程已连接其他 Alcor 宿主，请先关闭对应的控制器。',
  NATIVE_RECEIVE_NOT_READY: '原生消息接收通道尚未就绪。',
  NATIVE_NOT_CONNECTED: '请先在 QQ 接入页连接进程。',
  NATIVE_ACTION_NOT_IMPLEMENTED: '此动作的原生实现尚未完成。',
  READ_ONLY_MODE: '当前为只读模式，仅允许查询。',
  SELECT_NATIVE_CONFIGURATION_FIRST: '当前使用 OneBot 兼容后端，请从原生版启动入口打开。',
  INVALID_MANAGEMENT_SETTINGS: '配置无效，请检查监听地址、端口或设置内容。',
  CONFIG_FILE_NOT_WRITABLE_IN_THIS_SESSION: '当前服务无法写入运行配置。',
  REQUEST_TIMEOUT: '请求超时，请检查 Alcor 核心状态后重试。'
};

function message(error) {
  return errors[error.message] ?? (error instanceof TypeError ? '无法访问本机服务或浏览器功能。' : error.message || '操作失败');
}
function notice(text, state = 'neutral') {
  const feedback = $('#feedback');
  feedback.dataset.state = state;
  feedback.textContent = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => feedback.textContent = '', 6500);
}
function run(fn, errorTarget) {
  return Promise.resolve().then(fn).catch(error => {
    if (error.name === 'AbortError') return;
    if (errorTarget) errorTarget.textContent = message(error);
    else notice(message(error), 'error');
  });
}
async function busy(button, fn) {
  if (button.disabled || button.matches(':disabled')) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try { await fn(); }
  finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}
async function api(route, body) {
  const generation = epoch, abort = new AbortController();
  pending.add(abort);
  const timeout = setTimeout(() => abort.abort(new Error('REQUEST_TIMEOUT')), 60000);
  try {
    const response = await fetch(route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: abort.signal,
      cache: 'no-store'
    });
    const result = await response.json();
    if (generation !== epoch) throw new DOMException('Session changed', 'AbortError');
    if (!response.ok) throw new Error(result.wording ?? result.error ?? (response.status === 401 ? 'UNAUTHORIZED' : 'HTTP_' + response.status));
    return result;
  } finally {
    clearTimeout(timeout);
    pending.delete(abort);
  }
}
const manage = (route, body) => api('/manage/' + route, body);

function showPage(name, focus = false) {
  active = Object.hasOwn(pages, name) ? name : 'overview';
  $$('.page').forEach(page => page.hidden = page.id !== 'page-' + active);
  $$('nav a').forEach(link => {
    if (link.dataset.page === active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  const title = $('#page-title');
  title.textContent = pages[active][0];
  $('#page-description').textContent = pages[active][1];
  if ($('#dashboard').hidden) return;
  clearTimeout(noticeTimer);
  $('#feedback').textContent = '';
  if (focus) { window.scrollTo(0, 0); title.focus({ preventScroll: true }); }
  run(loadPage);
}

const themeNames = { system: '自动', light: '日间', dark: '夜间' };
function theme(save = false) {
  if (save) ConsoleTheme.save(settings);
  else ConsoleTheme.apply(settings);
  const next = { system: 'light', light: 'dark', dark: 'system' }[settings.theme];
  const current = '主题 · ' + themeNames[settings.theme];
  $('#theme-toggle').textContent = current;
  $('#theme-toggle').setAttribute('aria-label', current + '，切换到' + themeNames[next]);
}
async function saveAppearance(next) {
  const { theme, accent, oled, compact, schedule } = next;
  const saved = token ? await manage('settings', { theme, accent, oled, compact }) : { theme, accent, oled, compact };
  settings = { ...saved, schedule, customizedAccent: next.customizedAccent, localTheme: !token };
  applyAppearanceForm();
}
function applyAppearanceForm() {
  $('#appearance-theme').value = settings.theme;
  $('#appearance-accent').value = settings.accent;
  $('#appearance-oled').checked = settings.oled;
  $('#appearance-compact').checked = settings.compact;
  const schedule = ConsoleTheme.normalizeSchedule(settings.schedule);
  $('#light-start').value = schedule.lightStart;
  $('#dark-start').value = schedule.darkStart;
  $('#theme-schedule').disabled = settings.theme !== 'system';
}

function connection(title, detail, label, state) {
  $('#state-title').textContent = title;
  $('#state-detail').textContent = detail;
  $('#status-banner').dataset.state = state;
  const badge = $('#connection-badge');
  badge.textContent = label;
  badge.dataset.state = state;
}

function lock(focus = false) {
  epoch++;
  token = '';
  clearInterval(timer);
  clearTimeout(noticeTimer);
  pending.forEach(request => request.abort());
  pending.clear();
  refreshTask = null;
  resetEvents();
  lastInfo = null;
  logs = [];
  actions = [];
  $('#action-name').value = 'get_status';
  $('#action-params').value = '{}';
  $('#action-options').textContent = '';
  $('#action-list').textContent = '';
  $('#action-result').textContent = '尚未执行动作';
  $('#action-error').textContent = '';
  $('#action-params').removeAttribute('aria-invalid');
  $('#log-rows').textContent = '';
  $('#log-count').textContent = '';
  $('#log-state').textContent = '等待读取';
  $('#log-state').dataset.state = 'neutral';
  $('#process-list').classList.add('empty');
  $('#process-list').textContent = '正在扫描 QQ 进程';
  $('#native-connection').textContent = '正在读取连接状态';
  $('#disconnect-native').disabled = true;
  $('#node-fields').disabled = true;
  $('#feedback').textContent = '';
  $('#dashboard').hidden = true;
  $('nav').hidden = true;
  $('#login').hidden = false;
  $('#logout').hidden = true;
  connection('正在检查连接', '读取核心服务和 QQ 后端状态。', '未解锁', 'neutral');
  $('#token').value = '';
  $('#token').removeAttribute('aria-invalid');
  $('#login-error').textContent = '';
  if (focus) { window.scrollTo(0, 0); $('#token').focus(); }
}
async function login(value) {
  epoch++;
  token = value.trim();
  $('#login-error').textContent = '';
  $('#token').removeAttribute('aria-invalid');
  try {
    await refresh();
    const saved = await manage('settings');
    settings = {
      ...settings, ...saved,
      theme: settings.localTheme ? settings.theme : saved.theme,
      accent: saved.accent === 'blue' && !settings.customizedAccent ? 'violet' : saved.accent
    };
    theme(true);
    clearTimeout(noticeTimer);
    $('#feedback').textContent = '';
    $('#login').hidden = true;
    $('#dashboard').hidden = false;
    $('nav').hidden = false;
    $('#logout').hidden = false;
    $('#token').value = '';
    clearInterval(timer);
    timer = setInterval(() => run(async () => {
      await refresh();
      if (active === 'logs') await loadLogs();
    }), 5000);
    showPage(location.hash.slice(1), true);
  } catch (error) {
    lock();
    if (error.message === 'UNAUTHORIZED') $('#token').setAttribute('aria-invalid', 'true');
    $('#token').focus();
    throw error;
  }
}

const size = n => n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : (n / 1048576).toFixed(1) + ' MB';
function duration(seconds) {
  if (seconds < 60) return seconds + ' 秒';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟';
  return Math.floor(seconds / 3600) + ' 小时 ' + Math.floor(seconds % 3600 / 60) + ' 分钟';
}
function renderOverview(overview, info) {
  // /get_bridge_info samples status after it queries the backend.
  const state = info.bridge ?? overview;
  const { backend, ready } = state;
  const native = backend.type === 'native';
  const hostConnected = native && backend.connected;
  const eventConnected = backend.ws === 'open';
  const httpReachable = backend.http === 'reachable';
  const backendConnected = hostConnected || (!native && (eventConnected || httpReachable));
  const accountOnline = backend.qqOnline === true;
  const account = info.accountLastFour ? '尾号 ' + info.accountLastFour : '尾号未知';
  const accountState = accountOnline ? '在线'
    : backend.qqOnline === false && !native ? '离线'
    : info.accountLastFour ? '已识别' : '未确认';
  if (ready) {
    connection('账号连接正常', 'QQ 在线，OneBot 事件通道已就绪。', '账号在线', 'good');
  } else if (hostConnected) {
    if (backend.serviceBound === false) {
      connection('QQ 消息收发待确认', '建立连接时未确认消息服务绑定。' +
        (backend.events === 0 ? '后端尚未记录入站事件。' : '请核对本次测试对应的事件和发送回执。'), '消息未就绪', 'warning');
    } else {
      connection('QQ 原生宿主已连接', backend.receiveReady
        ? '接收通道已启动，等待消息收发确认。'
        : '消息接收通道尚未就绪。', '消息未就绪', 'warning');
    }
  } else if (backendConnected && !eventConnected) {
    connection('OneBot 事件通道未连接', 'HTTP 接口可访问。请检查后端的 WebSocket 连接。', '事件未就绪', 'warning');
  } else if (eventConnected && backend.apiReady === false) {
    const hint = backend.apiTransport === 'websocket'
      ? '请检查后端的 WebSocket 地址是否同时提供 API 调用和事件推送。'
      : '请检查后端的 HTTP 地址和访问令牌。';
    connection('OneBot API 未就绪', hint, 'API 未就绪', 'warning');
  } else if (backendConnected) {
    connection('OneBot 后端已连接', accountState === '离线'
      ? 'QQ 账号离线，请检查后端的登录状态。'
      : '尚未确认 QQ 在线，请检查后端的登录状态。', '账号未就绪', 'warning');
  } else if (native) {
    connection('等待连接 QQ', '在官方 QQ 客户端登录后，从“QQ 接入”选择对应进程。', 'QQ 未接入', 'neutral');
  } else {
    connection('OneBot 后端未连接', '核心已启动。请检查 OneBot 后端和事件连接地址。', '后端未连接', 'warning');
  }

  $('#core-state').textContent = state.listening ? '运行中' : '未监听';
  $('#bridge-version').textContent = 'Alcor ' + state.version;
  $('#account').textContent = info.accountLastFour || accountOnline ? account : '未确认';
  $('#account-state').textContent = accountState;
  $('#backend-name').textContent = native ? 'QQ 原生' : info.backendVersion?.name || 'OneBot 兼容后端';
  $('#backend-version').textContent = native ? '官方 QQ 客户端' : info.backendVersion?.version || '版本未知';
  $('#clients').textContent = state.clients;
  $('#uptime').textContent = duration(state.uptimeSeconds);
  $('#mode').textContent = state.readOnly ? '只读模式' : '允许发送与修改';
  $('#reconnects').textContent = backend.reconnects ?? 0;
  $('#requests').textContent = state.activeRequests;
  $('#event-count').textContent = backend.events ?? '未知';
  $('#updated').textContent = '更新于 ' + new Date().toLocaleTimeString();
  $('#http-url').value = info.connection.httpUrl;
  $('#ws-url').value = info.connection.wsUrl;
  $('#connection-path').innerHTML = [
    ['QQ 账号', accountState],
    [native ? '原生宿主' : 'OneBot 后端', backendConnected
      ? native || eventConnected ? '已连接' : '仅 HTTP 可用'
      : '未连接'],
    ['Alcor 核心', state.listening ? '运行中' : '未监听'],
    ['下游应用', state.clients + ' 个连接']
  ].map(([name, value]) => '<li class="connection-node"><span>' + name + '</span><strong>' + value + '</strong></li>').join('');

  const resources = overview.resources;
  const { cpu, memory, process } = resources;
  $('#host-name').textContent = resources.hostname + ' · ' + resources.platform;
  $('#cpu-name').textContent = cpu.name + ' · ' + cpu.cores + ' 核';
  $('#cpu-value').textContent = cpu.usage.length ? Math.round(cpu.usage.reduce((a, b) => a + b, 0) / cpu.usage.length) + '%' : '—';
  $('#cpu-cores').innerHTML = cpu.usage.map((usage, index) => '<span class="core" title="核心 ' + (index + 1) + '：' + usage + '%"></span>').join('');
  $$('#cpu-cores .core').forEach((element, index) => element.style.opacity = .12 + .88 * cpu.usage[index] / 100);
  const percent = Math.round((1 - memory.free / memory.total) * 100);
  $('#memory-value').textContent = percent + '%';
  $('#memory-bar').value = percent;
  $('#memory-detail').textContent = '已用 ' + size(memory.total - memory.free) + ' / ' + size(memory.total);
  $('#process-pid').textContent = 'PID ' + process.pid;
  $('#process-memory').textContent = '常驻内存 ' + size(memory.rss);
  $('#node-version').textContent = 'Node.js ' + process.node;

  const warnings = $('#warnings');
  warnings.classList.toggle('empty', overview.recentWarnings.length === 0);
  warnings.innerHTML = overview.recentWarnings.length
    ? overview.recentWarnings.map(w => '<div class="warning-row">' + esc(w.message) + '<small>' + esc(new Date(w.time).toLocaleString()) + ' · ' + esc(w.module) + '</small></div>').join('')
    : '暂无告警记录';
  const sessions = $('#sessions');
  const hasSession = accountOnline || hostConnected || Boolean(info.accountLastFour);
  sessions.classList.toggle('empty', !hasSession);
  sessions.innerHTML = hasSession
    ? '<div class="session-row"><strong>QQ ' + esc(account) + '</strong><div class="muted">' + (ready ? '消息通道已就绪' : '消息通道未就绪') + '</div></div>'
    : '尚未确认 QQ 账号会话';
}
function refresh() {
  if (refreshTask) return refreshTask;
  const generation = epoch;
  refreshTask = Promise.all([manage('overview'), api('/get_bridge_info')]).then(([overview, result]) => {
    if (generation !== epoch) return;
    lastInfo = result.data;
    renderOverview(overview, lastInfo);
  }).catch(error => {
    if (generation === epoch) connection('状态更新失败', '页面数据可能已过时。请检查核心服务后刷新。', '无法确认状态', 'error');
    throw error;
  }).finally(() => { if (generation === epoch) refreshTask = null; });
  return refreshTask;
}

async function loadProcesses() {
  const result = await manage('processes');
  const native = result.backendType === 'native';
  const list = $('#process-list');
  list.classList.toggle('empty', !result.processes.length);
  list.innerHTML = result.processes.length ? result.processes.map(process => {
    const version = process.version ? ' · QQ ' + esc(process.version) : '';
    const injection = process.alcorHostLoaded
      ? '<p class="muted">该进程已驻留 Alcor 原生宿主；重连前请先断开，仍失败则完全退出 QQ 后重试。</p>'
      : process.foreignModules?.length
        ? '<p class="muted">检测到其他框架的注入模块：' + esc(process.foreignModules.join('、')) + '。它们会驻留到 QQ 重启，可能让原生接入读不到服务对象。</p>'
        : '';
    return '<div class="process-row"><div><strong>PID ' + esc(process.pid) + version + '</strong><p class="muted">' +
      esc(process.path ?? '无法读取进程路径') + '</p><p class="muted">' +
      (process.supported ? (process.verification === 'static' ? '此构建已完成静态适配，真实收发待验收；连接后确认账号' : '此构建已通过收发验证；连接后确认账号') : '此 QQ 构建尚未适配，或无法读取进程') +
      '</p>' + injection + '</div><button data-connect="' + esc(process.pid) + '" ' + (!process.supported || !native ? 'disabled' : '') + '>连接 QQ</button></div>';
  }).join('') : '未找到已加载账号模块的 QQ。请在官方 QQ 中正常登录后重新扫描。';
  const connection = result.connection;
  $('#native-connection').textContent = connection?.connected
    ? '已连接 PID ' + connection.pid + (connection.accountLastFour ? ' · QQ 尾号 ' + connection.accountLastFour : '') +
      (connection.receiveReady ? ' · 消息接收通道已启动' : ' · 消息接收通道未就绪')
    : native ? '尚未连接 QQ 原生宿主。' : '当前使用 OneBot 兼容后端。请从原生版启动入口打开以使用此功能。';
  $('#disconnect-native').disabled = !connection?.connected;
  $$('[data-connect]').forEach(button => button.onclick = () => run(() => busy(button, async () => {
    await manage('native/connect', { pid: Number(button.dataset.connect) });
    await loadProcesses();
    await refresh();
    notice('QQ 原生宿主已连接');
  })));
}

async function loadNodes() {
  const result = await manage('nodes');
  const config = result.pending ?? result.active;
  $('#node-host').value = config.host;
  $('#node-port').value = config.port || location.port;
  $('#node-readonly').checked = config.readOnly;
  $('#node-fields').disabled = !result.editable;
  $('#node-save-note').textContent = result.pending ? '存在待应用配置，重启 Alcor 核心后生效。'
    : result.editable ? '保存的配置在重启 Alcor 核心后生效。' : '当前服务无法写入配置文件。';
  $('#transport-list').innerHTML = result.transports.map(transport => '<span>' +
    esc(transport.type === 'WebSocket' ? '正向 WebSocket' : transport.type) + ' · ' +
    (transport.implemented === false ? '待实现' : transport.enabled ? '已启用' : '未启用') + '</span>').join('');
  const outbound = await manage('transports');
  transportDraft = { httpCallbacks: outbound.httpCallbacks, reverseWebSockets: outbound.reverseWebSockets };
  $('#transport-fields').disabled = !outbound.editable;
  $('#transport-note').textContent = outbound.restartRequired ? '配置已保存，等待重启核心。' : '未添加目标时，不向外推送事件。';
  renderTransportEditors();
}

function captureTransportEditors() {
  for (const key of ['httpCallbacks', 'reverseWebSockets']) {
    const http = key === 'httpCallbacks', credential = http ? 'secret' : 'token';
    transportDraft[key] = $$('[data-transport="' + key + '"]').map((node, index) => {
      const previous = transportDraft[key][index];
      const row = { ...previous, url: node.querySelector('[data-field="url"]').value.trim() };
      const value = node.querySelector('[data-field="credential"]').value;
      row.credentialCleared = node.querySelector('[data-field="clear"]').checked;
      if (value || row.credentialCleared) row[credential] = row.credentialCleared ? '' : value;
      else delete row[credential];
      if (http) row.quickReply = node.querySelector('[data-field="quick"]').checked;
      return row;
    });
  }
}
function renderTransportEditors() {
  for (const key of ['httpCallbacks', 'reverseWebSockets']) {
    const http = key === 'httpCallbacks';
    const target = $(http ? '#callback-editors' : '#reverse-editors');
    target.innerHTML = transportDraft[key].length ? transportDraft[key].map((row, index) => {
      const configured = row[http ? 'secretConfigured' : 'tokenConfigured'];
      return '<div class="transport-editor" data-transport="' + key + '"><label>服务地址 ' + (index + 1) +
        '<input data-field="url" type="url" required value="' + esc(row.url) + '" placeholder="' + (http ? 'http' : 'ws') + '://127.0.0.1:8080/events"></label>' +
        '<label>' + (http ? '签名密钥（选填）' : '访问令牌（选填）') + '<input data-field="credential" type="password" autocomplete="new-password" value="' + esc(row[http ? 'secret' : 'token'] || '') + '" placeholder="' + (configured ? '已保存，留空保留' : '未配置') + '"></label>' +
        '<label class="check"><input data-field="clear" type="checkbox"' + (row.credentialCleared ? ' checked' : '') + '>清除已保存的凭据</label>' +
        (http ? '<label class="check"><input data-field="quick" type="checkbox"' + (row.quickReply ? ' checked' : '') + '>允许服务通过回调响应快速回复消息</label>' : '') +
        '<button class="secondary" data-remove-transport="' + key + '" data-index="' + index + '" type="button">移除此目标</button></div>';
    }).join('') : '<p class="muted">未添加目标</p>';
    $(http ? '#add-callback' : '#add-reverse').disabled = transportDraft[key].length >= 8;
  }
  $$('[data-remove-transport]').forEach(button => button.onclick = () => {
    captureTransportEditors(); transportDraft[button.dataset.removeTransport].splice(Number(button.dataset.index), 1); renderTransportEditors();
  });
}

function renderLogs() {
  const search = $('#log-search').value.toLowerCase(), level = $('#log-level').value;
  const rows = logs.filter(log => (level === 'all' || log.level === level) && [log.module, log.message].join(' ').toLowerCase().includes(search));
  $('#log-count').textContent = rows.length + ' / ' + logs.length + ' 条';
  $('#log-rows').innerHTML = rows.length ? rows.slice().reverse().map(log => '<tr><td>' +
    esc(new Date(log.time).toLocaleTimeString('zh-CN', { hour12: false })) + '</td><td class="level-' + esc(log.level) + '">' +
    esc(log.level.toUpperCase()) + '</td><td>' + esc(log.module) + '</td><td>' +
    esc(log.message) + '</td></tr>').join('') : '<tr><td colspan="4">暂无匹配日志</td></tr>';
}
async function loadLogs() {
  const badge = $('#log-state');
  try {
    logs = (await manage('logs')).entries;
    renderLogs();
    badge.textContent = '自动刷新';
    badge.dataset.state = 'neutral';
  } catch (error) {
    if (error.name !== 'AbortError') {
      badge.textContent = '刷新失败';
      badge.dataset.state = 'error';
    }
    throw error;
  }
}
function renderActions() {
  const search = $('#api-search').value.trim().toLowerCase(), scope = $('#api-scope').value;
  const rows = actions.filter(action => action.action.toLowerCase().includes(search) && (scope === 'all' || action.native === scope));
  $('#action-count').textContent = rows.length + ' / ' + actions.length;
  $('#action-list').innerHTML = rows.length ? rows.map(action =>
    '<div class="api-row"><code>' + esc(action.action) + '</code><small>' +
    (action.native === 'implemented' ? '原生已实现' : '原生待实现') +
    '</small><button class="secondary" data-action="' + esc(action.action) + '" aria-label="在测试台使用 ' +
    esc(action.action) + '">试用</button></div>').join('') : '<p class="empty">暂无匹配的 OneBot 动作</p>';
  $$('[data-action]').forEach(button => button.onclick = () => {
    $('#action-name').value = button.dataset.action;
    debugPage('tester');
    $('#action-name').focus();
  });
}
async function loadActions() {
  if (!actions.length) {
    actions = (await manage('actions')).actions;
    $('#action-options').innerHTML = actions.map(action => '<option value="' + esc(action.action) + '"></option>').join('');
  }
  renderActions();
}
function debugPage(page) {
  $$('.debug-panel').forEach(element => element.hidden = element.id !== 'debug-' + page);
  $$('[data-debug]').forEach(element => element.setAttribute('aria-pressed', String(element.dataset.debug === page)));
}
async function loadPage() {
  if (active === 'processes') await loadProcesses();
  if (active === 'nodes') await loadNodes();
  if (active === 'logs') await loadLogs();
  if (active === 'settings') applyAppearanceForm();
  if (active === 'debug') await loadActions();
}

function resetEvents() {
  const socket = eventSocket;
  eventSocket = null;
  socket?.close();
  eventRows = [];
  $('#event-state').textContent = '尚未开始监听';
  $('#event-output').textContent = '暂无事件';
  $('#toggle-events').textContent = '开始监听';
}
function toggleEvents() {
  const button = $('#toggle-events'), state = $('#event-state');
  if (eventSocket) {
    const socket = eventSocket;
    eventSocket = null;
    socket.close();
    button.textContent = '开始监听';
    state.textContent = '已停止监听';
    return;
  }
  if (!token || !lastInfo) return;
  const url = new URL(lastInfo.connection.wsUrl);
  url.searchParams.set('access_token', token);
  const socket = new WebSocket(url);
  eventSocket = socket;
  button.textContent = '停止监听';
  state.textContent = '正在连接 OneBot 事件接口…';
  socket.onopen = () => { if (eventSocket === socket) state.textContent = '正在监听 OneBot 事件'; };
  socket.onmessage = event => {
    if (eventSocket !== socket) return;
    try {
      const data = JSON.parse(event.data);
      eventRows.push({
        time: new Date().toLocaleTimeString(),
        type: data.post_type,
        kind: data.message_type ?? data.notice_type ?? data.meta_event_type
      });
      if (eventRows.length > 100) eventRows.shift();
      $('#event-output').textContent = eventRows.map(row => JSON.stringify(row)).join('\n');
    } catch {}
  };
  socket.onerror = () => { if (eventSocket === socket) state.textContent = '无法连接 OneBot 事件接口，请重试。'; };
  socket.onclose = () => {
    if (eventSocket !== socket) return;
    eventSocket = null;
    button.textContent = '开始监听';
    if (!state.textContent.startsWith('无法')) state.textContent = '事件连接已关闭';
  };
}

const clickBusy = (selector, task) => {
  const button = $(selector);
  button.onclick = () => run(() => busy(button, task));
};
const submit = (selector, task, errorTarget) => {
  const form = $(selector), button = form.querySelector('button[type="submit"]');
  form.onsubmit = event => {
    event.preventDefault();
    run(() => busy(button, task), errorTarget);
  };
};
submit('#login-form', () => login($('#token').value), $('#login-error'));
$('#token').oninput = () => {
  $('#token').removeAttribute('aria-invalid');
  $('#login-error').textContent = '';
};
$('#logout').onclick = $('#settings-lock').onclick = () => lock(true);
clickBusy('#refresh', async () => {
  await refresh();
  // Explicit refresh reloads live data only, preserving unsaved form fields.
  if (active !== 'settings' && active !== 'nodes') await loadPage();
});
clickBusy('#scan-processes', loadProcesses);
$('#disconnect-native').onclick = () => run(async () => {
  const button = $('#disconnect-native');
  await busy(button, async () => {
    await manage('native/disconnect', {});
    notice('已断开 QQ 原生连接');
  });
  button.disabled = true;
  await loadProcesses();
  await refresh();
});
submit('#node-form', async () => {
  await manage('nodes', { host: $('#node-host').value, port: Number($('#node-port').value), readOnly: $('#node-readonly').checked });
  await loadNodes();
  notice('节点配置已保存，重启 Alcor 核心后生效');
});
for (const [selector, key] of [['#add-callback', 'httpCallbacks'], ['#add-reverse', 'reverseWebSockets']]) {
  $(selector).onclick = () => { captureTransportEditors(); transportDraft[key].push({ url: '' }); renderTransportEditors(); };
}
submit('#transport-form', async () => {
  captureTransportEditors();
  const data = Object.fromEntries(Object.entries(transportDraft).map(([key, rows]) => [key, rows.map(row => {
    const { secretConfigured, tokenConfigured, credentialCleared, ...value } = row; return value;
  })]));
  await manage('transports', data); await loadNodes(); notice('回调与反向连接已保存，重启 Alcor 核心后生效');
});
$('#appearance-theme').onchange = () => $('#theme-schedule').disabled = $('#appearance-theme').value !== 'system';
for (const selector of ['#light-start', '#dark-start']) {
  $(selector).oninput = () => $('#dark-start').setCustomValidity('');
}
submit('#settings-form', async () => {
  const mode = $('#appearance-theme').value;
  const schedule = mode === 'system'
    ? { lightStart: $('#light-start').value, darkStart: $('#dark-start').value } : settings.schedule;
  if (mode === 'system' && !AlcorTheme.validSchedule(schedule)) {
    const input = $('#dark-start');
    input.setCustomValidity('日间和夜间开始时间需要不同。');
    input.reportValidity();
    return;
  }
  await saveAppearance({
    theme: mode, accent: $('#appearance-accent').value, oled: $('#appearance-oled').checked,
    compact: $('#appearance-compact').checked, schedule, customizedAccent: true
  });
  theme(true);
  notice('外观设置已保存');
});
clickBusy('#theme-toggle', async () => {
  const next = { system: 'light', light: 'dark', dark: 'system' }[settings.theme];
  await saveAppearance({ ...settings, theme: next });
  theme(true);
});
$$('.copy').forEach(button => button.onclick = () => run(async () => {
  await navigator.clipboard.writeText($('#' + button.dataset.copy).value);
  notice('地址已复制');
}));
$('#copy-token').onclick = () => run(async () => {
  await navigator.clipboard.writeText(token);
  notice('令牌已复制');
});
$('#log-search').oninput = renderLogs;
$('#log-level').onchange = renderLogs;
clickBusy('#clear-logs', async () => {
  await manage('logs/clear', {});
  await loadLogs();
  notice('运行日志已清空');
});
$('#export-logs').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'Alcor-logs.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('#api-search').oninput = renderActions;
$('#api-scope').onchange = renderActions;
$$('[data-debug]').forEach(button => button.onclick = () => debugPage(button.dataset.debug));
$('#action-params').oninput = () => {
  $('#action-params').removeAttribute('aria-invalid');
  $('#action-error').textContent = '';
};
submit('#action-form', async () => {
  const input = $('#action-params'), result = $('#action-result');
  let params;
  try { params = JSON.parse(input.value); }
  catch { params = null; }
  if (!params || Array.isArray(params) || typeof params !== 'object') {
    input.setAttribute('aria-invalid', 'true');
    $('#action-error').textContent = '请输入有效的 JSON 对象。无参数时使用 {}。';
    input.focus();
    return;
  }
  result.textContent = '正在执行…';
  try {
    const response = await api('/', { action: $('#action-name').value.trim(), params });
    result.textContent = JSON.stringify(response, null, 2);
  } catch (error) {
    if (error.name !== 'AbortError') result.textContent = message(error);
  }
});
$('#toggle-events').onclick = () => run(toggleEvents);
window.addEventListener('hashchange', () => {
  if (location.hash !== '#main') showPage(location.hash.slice(1), true);
});
window.addEventListener('focus', () => theme());
document.addEventListener('visibilitychange', () => { if (!document.hidden) theme(); });
setInterval(() => theme(), 15000);
theme();
showPage(location.hash.slice(1));
const fragment = new URLSearchParams(location.hash.slice(1));
const initial = fragment.get('token') ?? fragment.get('access_token');
if (initial) {
  history.replaceState(null, '', location.pathname + location.search);
  const button = $('#login-form button[type="submit"]');
  run(() => busy(button, () => login(initial)), $('#login-error'));
}
