'use strict';
const INBOX_LABEL = { received: '已收到', not_allowed: '未加入白名单', blocked: '已屏蔽', paused: '已暂停', group_other_target: '指向其他群成员', new_friend_greeting: '已忽略新好友首条消息', private_quota: '已达私聊每日上限', no_model: '未配置模型', skipped: '未触发回复', waiting: '等待回复', queued: '排队中', running: '正在处理', replied: '已发送', error: '处理失败', aborted: '已中止', noreply: '本次未回复', interrupted: '处理已中断' };
function inboxBadge(item) {
  const tone = item.status === 'error' ? 'error' : item.status === 'replied' ? 'done' : ['waiting', 'queued', 'running', 'received'].includes(item.status) ? 'waiting' : 'noreply';
  return `<span class="status-badge status-${tone}">${esc(INBOX_LABEL[item.status] || '已收到')}</span>`;
}
function inboxTitle(item) {
  const id = item.chatKey.split(':')[1];
  return item.chatKey.startsWith('private:') && item.senderName && item.senderName !== id ? `${item.senderName} · ${id}` : formatChatTitle(item.chatKey, chatNameOf(item.chatKey));
}
function renderInboxRows() {
  const items = state.inbox || [];
  if (!items.length) return '';
  return `<div class="inbox-section-label">最近收件</div>${items.map(item => `<button type="button" class="inbox-item ${state.currentInboxKey === item.chatKey ? 'selected' : ''}" data-chat-key="${esc(item.chatKey)}">
    <span class="session-title"><span class="session-chat">${esc(inboxTitle(item))}</span><time class="session-time">${fmtTime(item.ts)}</time></span>
    <span class="session-trigger">${esc(item.text)}</span>
    <span class="session-meta">${inboxBadge(item)}<span class="muted">${item.count} 条收件</span></span>
  </button>`).join('')}`;
}
function bindInboxRows(box) {
  $$('.inbox-item', box).forEach(el => el.addEventListener('click', () => selectInbox(el.dataset.chatKey)));
}
function inboxAttachment(item, receiptId, index) {
  const image = item.kind === 'image';
  const label = image ? '图片' : '视频';
  const meta = [
    item.width && item.height ? `${item.width} × ${item.height}` : '',
    item.duration ? `${Math.round(item.duration * 10) / 10} 秒` : '',
    item.fileSize ? `${(item.fileSize / 1024).toFixed(1)} KB` : ''
  ].filter(Boolean).join(' · ');
  return `<figure class="inbox-attachment" data-inbox-attachment="${esc(`${receiptId}:${index}`)}">
    <figcaption><strong>${label}</strong>${item.name ? ` <span>${esc(item.name)}</span>` : ''}
    ${meta ? `<small>${esc(meta)}</small>` : ''}</figcaption>
    ${item.summary && item.summary !== item.name ? `<span class="muted">${esc(item.summary)}</span>` : ''}
    ${image ? `<div class="inbox-preview"><span class="muted" role="status">${item.preview ? '' : '图片资源不可用'}</span>
      ${item.preview ? `<button type="button" class="btn btn-small" data-inbox-preview="${index}" data-receipt-id="${esc(receiptId)}">加载图片</button>` : ''}</div>` : '<span class="inbox-video-note muted">视频已接收。启用视觉模型和抽帧插件后，可在处理时读取画面。</span>'}
  </figure>`;
}
async function loadInboxPreview(button) {
  const box = button.closest('.inbox-preview'), status = $('[role="status"]', box);
  button.disabled = true;
  status.textContent = '正在加载图片…';
  const fail = () => {
    status.textContent = '暂时无法加载图片';
    button.textContent = '重试';
    button.disabled = false;
  };
  try {
    const response = await api('/api/media-data', {
      method: 'POST',
      body: JSON.stringify({ items: [{ receiptId: button.dataset.receiptId, index: Number(button.dataset.inboxPreview) }] })
    });
    const dataUrl = response.results?.[0]?.dataUrl;
    if (!dataUrl) { fail(); return; }
    if (!box.isConnected) return;
    const image = new Image();
    image.alt = '收到的图片';
    image.src = dataUrl;
    await image.decode();
    if (box.isConnected) box.replaceChildren(image);
  } catch { fail(); }
}
let inboxDetailFingerprint = '';
async function selectInbox(chatKey) {
  state.currentInboxKey = chatKey; state.currentSessionId = null; state.sessionDetail = null;
  inboxDetailFingerprint = ''; renderSessionList();
  if (typeof setWorkspacePane === 'function') setWorkspacePane('detail');
  $('#session-detail').innerHTML = '<div class="empty-hint">加载收件…</div>';
  await loadInboxDetail(chatKey);
}
async function loadInboxDetail(chatKey, { quiet = false } = {}) {
  try {
    const data = await api(`/api/inbox/${encodeURIComponent(chatKey.replace(':', '_'))}`);
    if (state.currentInboxKey !== chatKey || state.tab !== 'sessions') return;
    const fingerprint = JSON.stringify(data);
    if (fingerprint === inboxDetailFingerprint) return;
    inboxDetailFingerprint = fingerprint;
    const messages = data.messages || [], last = messages.at(-1), detail = $('#session-detail');
    const scroll = detail.scrollTop, atBottom = detail.scrollHeight - detail.clientHeight - scroll < 60;
    const previous = new Map($$('[data-inbox-attachment]', detail).map(el => [el.dataset.inboxAttachment, el]));
    detail.innerHTML = `<div class="inbox-detail">
      <header class="inbox-detail-head"><div><h2>${esc(last ? inboxTitle(last) : formatChatTitle(chatKey))}</h2><p class="muted">收件与回复状态 · 仅保留最近 1000 条收件</p></div><button class="btn btn-small" id="inbox-allow-settings">聊天白名单</button></header>
      <div class="inbox-messages">${messages.map(m => {
        const media = m.media || [];
        const mediaText = media.map(item => item.kind === 'image' ? '[图片]' : '[视频]').join('');
        return `<article class="inbox-message">
        <div class="inbox-message-meta"><strong>${esc(m.senderName || m.senderId)}</strong><time>${fmtTime(m.ts)}</time>${inboxBadge(m)}</div>
        ${m.text !== mediaText ? `<p class="inbox-message-text">${esc(m.text)}</p>` : ''}
        ${media.length ? `<div class="inbox-attachments">${media.map((item, index) => inboxAttachment(item, m.id, index)).join('')}</div>` : ''}
        <div class="inbox-message-status"><span>${esc(m.reason)}</span>${m.sessionId ? `<button class="btn btn-small" data-receipt-session="${esc(m.sessionId)}">查看处理过程</button>` : ''}</div>
      </article>`;
      }).join('') || '<p class="empty-hint">尚无收件记录。</p>'}</div>
    </div>`;
    $('#inbox-allow-settings').addEventListener('click', () => { state.settingsSection = 'allow'; switchTab('settings'); renderSettings(); });
    $$('[data-receipt-session]', detail).forEach(el => el.addEventListener('click', () => selectSession(el.dataset.receiptSession)));
    $$('[data-inbox-attachment]', detail).forEach(el => {
      const existing = previous.get(el.dataset.inboxAttachment);
      if (existing) el.replaceWith(existing);
      else $('[data-inbox-preview]', el)?.addEventListener('click', event => loadInboxPreview(event.currentTarget));
    });
    detail.scrollTop = atBottom ? detail.scrollHeight : scroll;
  } catch (e) {
    if (!quiet && state.currentInboxKey === chatKey) $('#session-detail').innerHTML = `<div class="empty-hint">无法加载收件：${esc(e.message)}</div>`;
  }
}
