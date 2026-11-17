import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { chatAllowed } from './inbound-policy.js';
import { isGloballyBlocked } from './community.js';
import { sanitizeUserText } from './util.js';

const QQ_ID = /^[1-9]\d{0,9}$/;
const MESSAGE_ID = /^-?[1-9]\d{0,18}$/;
const FILE_LIMIT = 10 * 1024 * 1024;
const HISTORY_LIMIT = 50;
const ADMIN_ROLES = new Set(['owner', 'admin']);
const ROLE_NAMES = new Set([...ADMIN_ROLES, 'member']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const mediaLabels = new Map([
  ['image', '[图片]'], ['face', '[表情]'], ['mface', '[表情]'], ['record', '[语音]'],
  ['video', '[视频]'], ['forward', '[合并转发]'], ['file', '[文件]'], ['json', '[卡片消息]']
]);

function reject(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}

function chatScope(onebot, store, kind, target, expectedSelfId) {
  const selfId = String(expectedSelfId ?? '');
  const socket = onebot.socket;
  const httpUrl = onebot.httpUrl;
  const chatKey = `${kind}:${target}`;
  const targetField = kind === 'group' ? 'group_id' : 'user_id';
  const params = { [targetField]: Number(target), expected_self_id: Number(selfId) };
  const check = () => {
    if (!onebot.connected || !QQ_ID.test(selfId) || onebot.selfId !== selfId || store.activeAccount !== selfId ||
        onebot.socket !== socket || onebot.httpUrl !== httpUrl) {
      reject(409, 'CHAT_ACTION_ACCOUNT_CHANGED', '当前账号或连接已变化，请重新打开会话操作。');
    }
    if (!chatAllowed(kind, target, getConfig())) reject(403, 'CHAT_ACTION_NOT_ALLOWED', '该会话不在聊天允许范围内。');
  };
  check();
  return { kind, target, selfId, chatKey, httpUrl, params, check };
}

async function confirmAccount(onebot, scope) {
  scope.check();
  const login = await onebot.call('get_login_info', {}, 5000);
  scope.check();
  if (String(login?.user_id ?? '') !== scope.selfId) {
    reject(409, 'CHAT_ACTION_ACCOUNT_CHANGED', '聊天后端的账号已变化，请重新打开会话操作。');
  }
}

async function writeAction(onebot, scope, action, params, beforeDispatch) {
  await confirmAccount(onebot, scope);
  if (beforeDispatch?.() === false) return;
  const data = await onebot.call(action, { ...scope.params, ...params });
  try { await confirmAccount(onebot, scope); }
  catch {
    reject(502, 'DELIVERY_UNKNOWN', '请求已提交但会话连接已变化，请到聊天客户端核对结果。');
  }
  return data;
}

function historyText(message) {
  if (typeof message === 'string') return message.slice(0, 20000);
  if (!Array.isArray(message)) return '';
  return message.slice(0, 120).map(segment => {
    if (segment?.type === 'text') return String(segment.data?.text ?? '').slice(0, 2000);
    if (segment?.type === 'at') {
      const id = String(segment.data?.qq ?? '');
      return id === 'all' || QQ_ID.test(id) ? `@${id} ` : '[提及]';
    }
    return mediaLabels.get(segment?.type) || '[消息段]';
  }).join('').slice(0, 20000);
}

function messageIdentity(raw, { kind, target, selfId }) {
  if (!raw || raw.message_type !== kind || (raw.self_id != null && String(raw.self_id) !== selfId)) return null;
  const mid = String(raw.message_id ?? '');
  const senderId = String(raw.sender?.user_id ?? raw.user_id ?? '');
  const ts = Number(raw.time) * 1000;
  if (!MESSAGE_ID.test(mid) || !QQ_ID.test(senderId) || !Number.isSafeInteger(ts) || ts <= 0 || ts > Date.now() + 300000) return null;
  const self = senderId === selfId;
  if (kind === 'group') {
    if (String(raw.group_id) !== target) return null;
  } else if (self) {
    if (String(raw.target_id ?? raw.user_id) !== target) return null;
  } else if (senderId !== target || (raw.target_id != null && String(raw.target_id) !== selfId)) return null;
  return { mid, ts, self, senderId };
}

function backendMessageId(mid) {
  const number = Number(mid);
  return Number.isSafeInteger(number) ? number : String(mid);
}

async function matchesArchivedMessage(onebot, scope, row) {
  const mid = String(row.mid);
  const response = await onebot.call('get_msg', { ...scope.params, message_id: backendMessageId(mid) },
    5000, { maxResponseBytes: 512 * 1024 });
  const source = messageIdentity(response, scope);
  const sender = row.self ? scope.selfId : row.senderId;
  // Outgoing entries may use the local acknowledgement time.
  const tolerance = row.self ? 30000 : 0;
  return source?.mid === mid && source.senderId === sender && Number.isFinite(row.ts) && Math.abs(source.ts - row.ts) <= tolerance;
}

function historyRow(raw, scope, config) {
  const identity = messageIdentity(raw, scope);
  if (!identity) return null;
  const { self, senderId } = identity;
  if (!self && (isGloballyBlocked(senderId) ||
      (scope.kind === 'group' && (config.blocklist?.[scope.target] || []).map(String).includes(senderId)))) return null;
  const text = sanitizeUserText(historyText(raw.message ?? raw.raw_message)).trim();
  if (!text) return null;
  const senderName = self ? '我' : String(raw.sender?.card || raw.sender?.nickname || senderId).slice(0, 120);
  return { ...identity, senderName, text, media: [], reply: null };
}

async function recoverHistory(onebot, store, inbox, scope, body) {
  const count = body.count ?? HISTORY_LIMIT;
  if (!Number.isInteger(count) || count < 1 || count > HISTORY_LIMIT) {
    reject(400, 'INVALID_HISTORY_COUNT', '每次可补收 1 到 50 条消息。');
  }
  await confirmAccount(onebot, scope);
  const action = scope.kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
  const result = await onebot.call(action, { ...scope.params, count }, 15000, { maxResponseBytes: 4 * 1024 * 1024 });
  await confirmAccount(onebot, scope);
  if (!Array.isArray(result?.messages) || result.messages.length > 200) {
    reject(502, 'INVALID_HISTORY_RESPONSE', '历史接口返回了无效的消息列表。');
  }
  const cfg = getConfig();
  const receiptKey = ({ mid, ts, senderId }) => JSON.stringify([String(mid), ts, senderId]);
  const receiving = new Set(inbox.forChat(scope.chatKey)
    .filter(receipt => receipt.selfId === scope.selfId && receipt.status === 'received')
    .map(receiptKey));
  const rows = result.messages.map(row => historyRow(row, scope, cfg))
    .filter(row => row && !receiving.has(receiptKey(row)) && !inbox.hasRecall(scope.chatKey, row.mid, scope.selfId))
    .sort((a, b) => a.ts - b.ts).slice(-count);
  return { added: store.recoverHistory(scope.chatKey, rows, scope.selfId), checked: rows.length };
}

async function forwardHistory(onebot, store, scope, body) {
  const ids = Array.isArray(body.messageIds) ? body.messageIds.map(String) : [];
  if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length || !ids.every(id => MESSAGE_ID.test(id))) {
    reject(400, 'INVALID_FORWARD_MESSAGES', '请选择 1 到 20 条不同的消息。');
  }
  const rows = ids.map(id => store.findByMid(scope.chatKey, id));
  if (rows.some(row => !row || row.recalled || row.selfId !== scope.selfId)) {
    reject(404, 'FORWARD_SOURCE_MISSING', '有消息不在当前账号的会话存档里，或已经撤回。');
  }
  await confirmAccount(onebot, scope);
  const verified = await Promise.all(rows.map(row => matchesArchivedMessage(onebot, scope, row)));
  if (!verified.every(Boolean) || rows.some(row => row.recalled)) {
    reject(409, 'FORWARD_SOURCE_UNVERIFIED', '后端返回的原消息无法与当前会话存档核对，已取消转发。');
  }
  const action = scope.kind === 'group' ? 'send_group_forward_msg' : 'send_private_forward_msg';
  const forwarded = await writeAction(onebot, scope, action, { messages: ids.map(id => ({ type: 'node', data: { id } })) });
  const id = String(forwarded?.message_id ?? '');
  if (!MESSAGE_ID.test(id)) reject(502, 'DELIVERY_UNKNOWN', '后端没有返回消息编号，请到聊天客户端核对是否已发送。');
  try { store.recoverHistory(scope.chatKey, [{ mid: id, ts: Date.now(), self: true, senderId: scope.selfId,
    senderName: '我', text: '[合并转发]', media: [], reply: null }], scope.selfId); }
  catch { return { messageId: id, archiveWarning: '转发已确认，存档没有保存成功。' }; }
  return { messageId: id };
}

async function recallOwnMessage(onebot, store, scope, body, onRecall) {
  const mid = String(body.messageId ?? '');
  if (!MESSAGE_ID.test(mid)) reject(400, 'INVALID_RECALL_MESSAGE', '请选择一条已发送消息。');
  const row = store.findByMid(scope.chatKey, mid);
  if (!row?.self || row.selfId !== scope.selfId || row.delivery === 'unknown') {
    reject(403, 'RECALL_SOURCE_NOT_OWNED', '只能撤回当前账号在此会话中已确认发送的消息。');
  }
  if (row.recalled) return { messageId: mid, alreadyRecalled: true };
  if (row.recallUnconfirmed) {
    reject(409, 'RECALL_ALREADY_SUBMITTED', '上一笔撤回的结果仍未确认，请到聊天客户端核对。');
  }

  await confirmAccount(onebot, scope);
  if (!await matchesArchivedMessage(onebot, scope, row)) {
    reject(409, 'RECALL_SOURCE_UNVERIFIED', '后端返回的原消息无法与当前会话存档核对，已取消撤回。');
  }
  let submitted = false;
  try {
    await writeAction(onebot, scope, 'delete_msg', { message_id: backendMessageId(mid) }, () => {
      if (store.findByMid(scope.chatKey, mid) !== row) {
        reject(409, 'RECALL_SOURCE_UNVERIFIED', '会话存档已变化，请重新选择消息。');
      }
      if (row.recalled) return false;
      if (!store.setRecallUnconfirmed(scope.chatKey, mid, true, scope.selfId)) {
        reject(409, 'RECALL_SOURCE_UNVERIFIED', '会话存档已变化，请重新选择消息。');
      }
      submitted = true;
    });
  } catch (error) {
    if (submitted && error.delivery !== 'unknown' && error.code !== 'DELIVERY_UNKNOWN') {
      try {
        scope.check();
        store.setRecallUnconfirmed(scope.chatKey, mid, false, scope.selfId);
      } catch { /* Keep the persisted marker if the active archive changed. */ }
    }
    throw error;
  }
  if (!submitted) return { messageId: mid, alreadyRecalled: true };
  try {
    scope.check();
    if (row.recalled || store.markRecalled(scope.chatKey, mid)) {
      onRecall(store.findByMid(scope.chatKey, mid));
      return { messageId: mid };
    }
  } catch { /* The backend confirmed even if the local archive could not be updated. */ }
  return { messageId: mid, archiveWarning: '后端已确认撤回，存档未能更新。' };
}

async function sendFile(onebot, scope, body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const content = body.content;
  if (!name || name.length > 180 || /[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(name) || /^[. ]+$/.test(name)) {
    reject(400, 'INVALID_UPLOAD_NAME', '文件名无效。');
  }
  if (typeof content !== 'string' || !content.length || content.length % 4 ||
      content.length > Math.ceil(FILE_LIMIT / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
    reject(400, 'INVALID_UPLOAD_CONTENT', '请选择不超过 10 MiB 的文件。');
  }
  const bytes = Buffer.from(content, 'base64');
  if (!bytes.length || bytes.length > FILE_LIMIT || bytes.toString('base64') !== content) {
    reject(400, 'INVALID_UPLOAD_CONTENT', '文件内容无效或超过 10 MiB。');
  }
  if (!LOOPBACK.has(new URL(scope.httpUrl).hostname)) {
    reject(403, 'UPLOAD_NEEDS_SHARED_HOST', '发送文件需要同一电脑上的聊天后端。');
  }
  const tempRoot = path.join(DATA_DIR, 'temp');
  await fs.mkdir(tempRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(tempRoot, 'chat-upload-'));
  const file = path.join(directory, 'payload');
  try {
    await fs.writeFile(file, bytes, { flag: 'wx' });
    const action = scope.kind === 'group' ? 'upload_group_file' : 'upload_private_file';
    await writeAction(onebot, scope, action, { file, name });
    return { name };
  } finally {
    await fs.unlink(file).catch(() => {});
    await fs.rmdir(directory).catch(() => {});
  }
}

async function members(onebot, scope) {
  await confirmAccount(onebot, scope);
  const roster = await onebot.call('get_group_member_list', scope.params, 10000, { maxResponseBytes: 4 * 1024 * 1024 });
  await confirmAccount(onebot, scope);
  if (!Array.isArray(roster) || roster.length > 4000) reject(502, 'GROUP_ROSTER_UNAVAILABLE', '群成员列表格式异常。');
  const rows = roster.filter(row => QQ_ID.test(String(row?.user_id ?? '')) && ROLE_NAMES.has(row.role) &&
    (row.group_id == null || String(row.group_id) === scope.target));
  return { role: rows.find(row => String(row.user_id) === scope.selfId)?.role ?? null,
    members: rows.map(row => ({ id: String(row.user_id), role: row.role, name: String(row.card || row.nickname || '').slice(0, 120) })) };
}

async function manageMember(onebot, scope, body) {
  const userId = String(body.userId ?? '');
  if (!QQ_ID.test(userId) || userId === scope.selfId) reject(400, 'INVALID_GROUP_MEMBER', '请选择另一位群成员。');
  let action, params;
  switch (body.action) {
    case 'mute': {
      const duration = body.duration;
      if (!Number.isSafeInteger(duration) || duration < 0 || duration > 30 * 86400) {
        reject(400, 'INVALID_MUTE_DURATION', '禁言时长需为 0 到 2592000 秒。0 表示解除禁言。');
      }
      action = 'set_group_ban'; params = { duration }; break;
    }
    case 'card':
      if (typeof body.card !== 'string' || body.card.length > 60 || /[\u0000-\u001f\u007f]/u.test(body.card)) {
        reject(400, 'INVALID_GROUP_CARD', '群名片最多 60 个字符。');
      }
      action = 'set_group_card'; params = { card: body.card }; break;
    case 'kick': action = 'set_group_kick'; params = { reject_add_request: false }; break;
    default: reject(400, 'INVALID_GROUP_ACTION', '未知的群成员操作。');
  }
  await confirmAccount(onebot, scope);
  const lookup = id => onebot.call('get_group_member_info', { ...scope.params, user_id: Number(id), no_cache: true }, 8000);
  const [actor, target] = await Promise.all([lookup(scope.selfId), lookup(userId)]);
  scope.check();
  const inGroup = (row, id) => String(row?.group_id) === scope.target && String(row?.user_id) === id;
  if (!inGroup(actor, scope.selfId) || !ADMIN_ROLES.has(actor.role)) {
    reject(403, 'GROUP_ADMIN_REQUIRED', '当前账号需为该群的群主或管理员。');
  }
  if (!inGroup(target, userId) || !ROLE_NAMES.has(target.role) || target.role === 'owner' ||
      (actor.role === 'admin' && target.role === 'admin')) {
    reject(403, 'GROUP_MEMBER_ROLE_PROTECTED', '当前账号无法管理这位群成员。');
  }
  await writeAction(onebot, scope, action, { ...params, user_id: Number(userId) });
  return {};
}

export function createChatActionRoutes({ onebot, store, inbox, readBody, emit, standard, onRecall }) {
  const active = new Set();
  return [{
    method: 'POST', pattern: /^\/api\/chats\/(group|private)_([1-9]\d{0,9})\/actions\/(history|forward|file|members|member|recall)$/,
    async handler({ req, res, json, match: [, kind, target, operation] }) {
      if (req.headers['x-alcor-local-action'] !== 'chat-operation') {
        return json(res, 403, { error: '此操作只能由本机管理端发起。' });
      }
      if (operation === 'recall' && !standard) return json(res, 404, { error: '请在标准接口版使用此操作。' });
      if (kind !== 'group' && /^member/.test(operation)) return json(res, 400, { error: '该操作仅用于群聊。' });
      let busyKey;
      try {
        const body = await readBody(req, operation === 'file' ? { maxBytes: Math.ceil(FILE_LIMIT / 3) * 4 + 4096 } : undefined);
        if (!body || typeof body !== 'object' || Array.isArray(body)) reject(400, 'INVALID_CHAT_ACTION', '操作参数无效。');
        const scope = chatScope(onebot, store, kind, target, body.expectedSelfId);
        const key = `${scope.selfId}:${scope.chatKey}`;
        if (active.has(key)) reject(409, 'CHAT_ACTION_BUSY', '该会话已有操作在进行。');
        active.add(key);
        busyKey = key;
        let result;
        switch (operation) {
          case 'history': result = await recoverHistory(onebot, store, inbox, scope, body); break;
          case 'forward': result = await forwardHistory(onebot, store, scope, body); break;
          case 'recall': result = await recallOwnMessage(onebot, store, scope, body, onRecall); break;
          case 'file': result = await sendFile(onebot, scope, body); break;
          case 'members': result = await members(onebot, scope); break;
          case 'member': result = await manageMember(onebot, scope, body); break;
        }
        if (operation === 'history' || operation === 'forward' || operation === 'recall') emit('chat-update', scope.chatKey);
        return json(res, 200, { ok: true, ...result });
      } catch (error) {
        if (error.expose) throw error;
        if (error.delivery === 'unknown' || error.code === 'DELIVERY_UNKNOWN') {
          const message = operation === 'recall' ? '撤回结果未确认，请到聊天客户端核对。' : '操作结果未确认，请到聊天客户端核对后再试。';
          return json(res, 502, { error: message, code: 'DELIVERY_UNKNOWN' });
        }
        if ([404, 405, 501].includes(error.httpStatus) || /NOT_IMPLEMENTED|UNKNOWN_ACTION/i.test(error.code ?? '')) {
          return json(res, 501, { error: '当前聊天后端不提供此接口。', code: 'CHAT_ACTION_UNSUPPORTED' });
        }
        return json(res, error.status || 502, { error: error.status ? error.message : '聊天后端拒绝操作或暂时不可用。',
          code: error.status ? error.code : 'CHAT_ACTION_BACKEND_ERROR' });
      } finally { if (busyKey) active.delete(busyKey); }
    }
  }];
}
