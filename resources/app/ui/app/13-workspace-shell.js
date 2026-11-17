'use strict';
const workspaceSections = {
  sessions: ['会话', '查看收件、回复状态与运行记录'], chats: ['存档', '浏览聊天记录与附件'],
  memory: ['记忆', '查看与编辑会话记忆'], usage: ['用量', '查看模型用量、联网工具调用与估算费用'],
  skills: ['技能', '管理技能与可用工具'], plugins: ['插件', '管理事件处理与扩展功能'],
  alcor: ['Alcor', '管理 QQ 连接与原生核心'], settings: ['设置', '配置模型、QQ 回复方式与应用偏好']
};
const mobileNavigation = matchMedia('(max-width: 760px)');
function setNavigationOpen(open, restoreFocus = false) {
  const active = mobileNavigation.matches && open;
  document.body.classList.toggle('navigation-open', active);
  $('#nav-toggle').setAttribute('aria-expanded', String(active));
  $('#nav-scrim').hidden = !active;
  $('#app-sidebar').inert = mobileNavigation.matches && !active;
  if (active) $('#tabs .tab.active')?.focus();
  else if (restoreFocus && mobileNavigation.matches) $('#nav-toggle').focus();
}
function setWorkspacePane(value) {
  $('#layout').dataset.mobilePane = value;
  $('#pane-toggle').textContent = value === 'list' ? '查看详情' : '返回列表';
}
function updateWorkspaceNav(name) {
  const entry = workspaceSections[name] || workspaceSections.sessions;
  $('#workspace-title').textContent = entry[0]; $('#workspace-description').textContent = entry[1];
  $$('#tabs .tab').forEach(el => { if (el.dataset.tab === name) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  $('#layout').dataset.hasPanes = String(['sessions', 'chats', 'memory'].includes(name));
  const wasOpen = document.body.classList.contains('navigation-open');
  setWorkspacePane('list'); setNavigationOpen(false);
  if (mobileNavigation.matches && wasOpen) { $('#workspace-title').tabIndex = -1; $('#workspace-title').focus(); }
}
$('#nav-toggle').addEventListener('click', () => setNavigationOpen(!document.body.classList.contains('navigation-open')));
$('#nav-scrim').addEventListener('click', () => setNavigationOpen(false, true));
mobileNavigation.addEventListener('change', () => setNavigationOpen(false));
document.addEventListener('keydown', event => {
  if (!mobileNavigation.matches || !document.body.classList.contains('navigation-open')) return;
  if (event.key === 'Escape') { event.preventDefault(); setNavigationOpen(false, true); }
  if (event.key === 'Tab') {
    const controls = [...$('#app-sidebar').querySelectorAll('button:not([disabled]), a[href]')].filter(el => el.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
$('#pane-toggle').addEventListener('click', () => setWorkspacePane($('#layout').dataset.mobilePane === 'list' ? 'detail' : 'list'));
document.addEventListener('click', event => {
  if (event.target.closest('[data-open-section]')) switchTab(event.target.closest('[data-open-section]').dataset.openSection);
  if (event.target.closest('.list-pane .session-item, .list-pane .chat-item') && !event.target.closest('button,input')) setWorkspacePane('detail');
});
$('#appearance-settings-btn').addEventListener('click', async () => {
  state.settingsSection = 'desktop'; await switchTab('settings');
  const picker = $('#theme-picker'); setCardExpanded(picker?.closest('.setcard'), true);
  picker?.scrollIntoView({ block: 'center' });
});
$$('.workspace-empty .empty-orbit').forEach(el => {
  const view = el.closest('.view')?.id;
  el.innerHTML = AlcorIcons.draw(view === 'view-memory' ? 'memory' : view === 'view-chats' ? 'archive' : 'chat');
});
updateWorkspaceNav(state.tab || 'sessions');
