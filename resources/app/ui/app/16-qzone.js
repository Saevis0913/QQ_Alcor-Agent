'use strict';

function renderQzoneSettings() {
  return `<section id="qzone-settings" class="form-section">
    <h3>QQ 空间</h3>
    <p class="muted">连接机器人的 QQ 空间后，Alcor Agent 可按设定时间读取该账号发布的动态和可见好友动态。登录信息加密保存在本机，失效后需要重新连接。</p>
    <form id="qzone-form">
      <div class="form-group">${switchHtml('qzone-enabled', false, '允许定时和手动读取')}</div>
      <div class="form-group">
        <label for="qzone-scope">读取范围</label>
        <select id="qzone-scope"><option value="both">自己发布的动态与可见好友动态</option><option value="own">自己发布的动态</option><option value="friends">可见好友动态</option></select>
      </div>
      <div class="form-group"><label for="qzone-limit">每日最多读取的不同动态数（条）</label><input id="qzone-limit" type="number" min="1" max="100" step="1" value="20" required /></div>
      <div class="form-group"><label for="qzone-time">每日读取时间（北京时间）</label><input id="qzone-time" type="time" value="09:00" required /></div>
      <button class="btn btn-primary" type="submit">保存设置</button>
      <button class="btn" type="button" id="qzone-login">连接 QQ 空间</button>
      <button class="btn" type="button" id="qzone-read">立即读取</button>
    </form>
    <p id="qzone-status" role="status" aria-live="polite">正在读取 QQ 空间连接状态…</p>
    <p id="qzone-usage" class="muted"></p>
    <div id="qzone-posts"></div>
  </section>`;
}

function mountQzoneSettings() {
  const panel = document.querySelector('#qzone-settings');
  if (!panel || panel.dataset.mounted) return;
  panel.dataset.mounted = 'true';
  const form = panel.querySelector('#qzone-form');
  const enabled = panel.querySelector('#qzone-enabled');
  const scope = panel.querySelector('#qzone-scope');
  const limit = panel.querySelector('#qzone-limit');
  const time = panel.querySelector('#qzone-time');
  const login = panel.querySelector('#qzone-login');
  const read = panel.querySelector('#qzone-read');
  const status = panel.querySelector('#qzone-status');
  const usage = panel.querySelector('#qzone-usage');
  const posts = panel.querySelector('#qzone-posts');
  const labels = {
    connected: 'QQ 空间已连接', signing_in: '请在 QQ 空间窗口完成登录。', login_required: '请选择「连接 QQ 空间」并登录机器人的 QQ 账号。',
    wrong_account: 'QQ 空间登录了其他账号。请重新连接并登录机器人的 QQ 账号。', account_unavailable: '请先连接机器人的 QQ。',
    unavailable: '请在 Alcor Agent 桌面应用中连接 QQ 空间。', quota: '今天已读到设定上限，请明天再试。', disabled: '读取功能已关闭。',
    read_error: '读取失败，请稍后重试。', parse_error: '无法识别 QQ 空间返回的动态格式。',
    cancelled: '读取中止，请重试。'
  };
  const dateTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });
  let changed = false;
  let busy = false;
  let polling;
  let latest;

  for (const eventName of ['input', 'change']) {
    form.addEventListener(eventName, (event) => {
      changed = true;
      // The settings container autosaves its own fields via delegated events.
      // Qzone settings are saved together by this form's submit handler.
      event.stopPropagation();
    });
  }

  function show(result) {
    if (!panel.isConnected) return;
    latest = result;
    const config = result.config;
    if (!changed) {
      enabled.checked = config.enabled;
      scope.value = config.scope;
      limit.value = config.dailyLimit;
      time.value = config.readTime;
    }
    login.disabled = ['unavailable', 'account_unavailable', 'connected', 'signing_in'].includes(result.state);
    login.textContent = result.state === 'wrong_account' ? '重新连接 QQ 空间' : '连接 QQ 空间';
    read.disabled = !config.enabled || result.remaining === 0 || !['connected', 'parse_error', 'read_error'].includes(result.state);
    status.textContent = `${labels[result.state] || '无法检查连接。'}${result.state === 'connected' && !config.enabled ? ' · 读取未启用' : ''}`;
    if (result.state === 'connected' && Number.isInteger(result.added)) status.textContent = `已读取 ${result.added} 条新动态。`;
    usage.textContent = `今日读取 ${result.used} / ${config.dailyLimit} 条${result.lastReadAt ? ` · 上次读取 ${dateTime.format(new Date(result.lastReadAt))}` : ''}`;
    posts.replaceChildren(...result.items.map((item) => {
      const card = document.createElement('article');
      card.className = 'form-section';
      const meta = document.createElement('p');
      meta.className = 'muted';
      const group = item.scope === 'own' ? '本人发布' : '好友动态';
      meta.textContent = [group, item.author || item.authorId, item.createdAt ? dateTime.format(new Date(item.createdAt)) : ''].filter(Boolean).join(' · ');
      const text = document.createElement('p');
      text.style.whiteSpace = 'pre-wrap';
      text.textContent = [item.text, item.media ? '[含媒体]' : ''].filter(Boolean).join('\n');
      card.append(meta, text);
      return card;
    }));
  }

  const refresh = async () => show(await api('/api/qzone/snapshot'));
  async function perform(action) {
    if (busy) return;
    busy = true;
    const controls = Array.from(form.elements);
    controls.forEach((control) => { control.disabled = true; });
    let message;
    try { message = await action(); } catch (error) { message = error.message || '操作失败。'; }
    finally {
      busy = false;
      controls.forEach((control) => { control.disabled = false; });
      if (latest) show(latest);
      if (message) status.textContent = message;
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    void perform(async () => {
      const qzone = { enabled: enabled.checked, scope: scope.value, dailyLimit: Number(limit.value), readTime: time.value, timezone: 'Asia/Shanghai' };
      beginSettingsGuard();
      try {
        const saved = await api('/api/config', { method: 'POST', body: JSON.stringify({ qzone }) });
        if (saved.config) state.config = saved.config;
        changed = false;
        await refresh();
      } finally {
        endSettingsGuard();
      }
      return '空间设置已保存。';
    });
  });

  login.addEventListener('click', () => {
    void perform(async () => {
      const result = await api('/api/qzone/login', { method: 'POST' });
      await refresh();
      if (result.state === 'signing_in') {
        clearInterval(polling);
        const until = Date.now() + 120_000;
        polling = setInterval(() => {
          if (!panel.isConnected || Date.now() >= until || latest?.state !== 'signing_in') {
            clearInterval(polling);
            return;
          }
          if (!busy) void refresh().catch((error) => { status.textContent = error.message; });
        }, 1800);
      }
    });
  });

  read.addEventListener('click', () => { void perform(async () => show(await api('/api/qzone/read', { method: 'POST' }))); });
  void perform(refresh);
}
