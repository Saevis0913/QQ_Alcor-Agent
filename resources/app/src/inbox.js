// 收件状态只供本地 UI 使用，与提供给模型的 ChatStore 分开。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const ACTIVE = new Set(['received', 'waiting', 'queued', 'running']);

function recallKey(chatKey, mid, selfId) {
  return mid == null || !chatKey || !selfId ? null : JSON.stringify([String(selfId), chatKey, String(mid)]);
}

function receiptMedia(items) {
  return items.filter(m => m.kind === 'image' || m.kind === 'video').slice(0, 12).map(m => {
    const { kind, file, url, name, summary, width, height, duration, fileSize } = m;
    const item = { kind };
    const displayText = value => value?.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 160);
    const title = displayText(name), caption = displayText(summary);
    if (title) item.name = title;
    if (caption) item.summary = caption;
    for (const [key, value] of Object.entries({ width, height, duration, fileSize })) {
      if (Number.isFinite(value) && value > 0) item[key] = value;
    }
    if (kind === 'image') {
      if (file && file.length <= 512 && !/^[a-z][\w+.-]*:\/\//i.test(file)) item.file = file;
      const address = url || file;
      if (!item.file && address?.length <= 2048 && /^https?:\/\//i.test(address)) item.url = address;
    }
    return item;
  });
}

export class InboxStore {
  #recalls = new Set();

  constructor({ file = path.join(DATA_DIR, 'inbox.json'), limit = 1000, onChange = () => {} } = {}) {
    this.file = file; this.limit = Math.max(1, limit); this.onChange = onChange; this.messages = [];
    try {
      const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.messages = previous.messages.slice(-this.limit);
      if (Array.isArray(previous.recalls)) {
        this.#recalls = new Set(previous.recalls.slice(-this.limit));
      }
    } catch { /* 首次运行 */ }
    // 上次的定时器或模型调用已经不存在，不能显示永久“运行中”。
    let changed = false;
    for (const m of this.messages) if (ACTIVE.has(m.status)) {
      m.status = 'interrupted'; m.reason = '上次处理随程序退出结束，请发送新消息查看当前状态。'; changed = true;
    }
    if (changed) this.save();
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, messages: this.messages, recalls: [...this.#recalls] }));
    fs.renameSync(tmp, this.file);
  }
  receive({ chatKey, mid, ts, senderId, senderName, senderRole = null, text, media = [], selfId = '', sequence = null }) {
    const duplicate = this.messages.find(m => {
      if (m.chatKey !== chatKey || m.senderId !== String(senderId) || (m.selfId && selfId && m.selfId !== selfId)) return false;
      if (sequence && m.sequence) return m.sequence === sequence && m.ts === ts;
      return mid != null && String(m.mid) === String(mid);
    });
    if (duplicate) return { receipt: duplicate, duplicate: true };
    const receipt = { id: crypto.randomUUID(), chatKey, mid: mid ?? null, ts: Number(ts) || Date.now(), receivedAt: Date.now(), senderId: String(senderId || ''), senderName: String(senderName || senderId || ''), text: String(text || '[消息]').slice(0, 20000), status: 'received', reason: '已收到，正在检查回复条件。', sessionId: null };
    if (selfId) receipt.selfId = selfId;
    if (sequence) receipt.sequence = sequence;
    if (senderRole) receipt.senderRole = senderRole;
    const attachments = receiptMedia(media);
    if (attachments.length) receipt.media = attachments;
    this.messages.push(receipt); this.messages = this.messages.slice(-this.limit);
    this.save(); this.onChange(chatKey);
    return { receipt, duplicate: false };
  }
  update(id, patch) {
    const m = this.messages.find(x => x.id === id); if (!m) return false;
    if (!Object.entries(patch).some(([k,v]) => m[k] !== v)) return false;
    Object.assign(m, patch); this.save(); this.onChange(m.chatKey); return true;
  }
  hasRecall(chatKey, mid, selfId) {
    const key = recallKey(chatKey, mid, selfId);
    return Boolean(key && (this.#recalls.has(key) || this.messages.some(m =>
      m.recalled && recallKey(m.chatKey, m.mid, m.selfId) === key)));
  }
  markRecalled(chatKey, mid, selfId) {
    const key = recallKey(chatKey, mid, selfId);
    if (!key) return false;
    const fresh = !this.#recalls.has(key);
    if (fresh) {
      this.#recalls.add(key);
      if (this.#recalls.size > this.limit) this.#recalls.delete(this.#recalls.values().next().value);
    }
    const receipt = this.messages.findLast(m => m.chatKey === chatKey && m.selfId === String(selfId) && m.mid != null && String(m.mid) === String(mid));
    if (receipt && !receipt.recalled) {
      const cancelled = ACTIVE.has(receipt.status) && receipt.status !== 'running';
      return this.update(receipt.id, { recalled: true, ...(cancelled && { status: 'skipped', reason: '消息已撤回。' }) });
    }
    if (fresh) this.save();
    return fresh;
  }
  syncSession(session, fallback = {}) {
    const id = session?.id || fallback.sessionId; if (!id) return;
    const receiptIds = new Set((Array.isArray(session?.trigger) ? session.trigger : []).map(m => m.receiptId).filter(Boolean));
    const status = session?.status || fallback.status;
    const mapped = { waiting: 'waiting', running: 'running', done: 'replied', error: 'error', noreply: 'noreply', aborted: 'aborted', discarded: 'skipped' }[status];
    if (!mapped) return;
    const reason = String(session?.error || fallback.error || ({ waiting: '等待合并连续消息后回复。', running: '正在调用模型或执行工具。', done: '发送接口已确认，请以 QQ 收件端为准。', error: '处理失败，请查看处理过程。', noreply: '本次处理没有发出回复。', aborted: '本次处理已中止。', discarded: '消息未触发当前回复规则。' })[status]).slice(0, 1200);
    const changed = new Set();
    for (const m of this.messages) if (receiptIds.has(m.id) || m.sessionId === id) {
      if (m.recalled && m.status === 'skipped') continue;
      if (m.status === mapped && m.reason === reason && m.sessionId === id) continue;
      Object.assign(m, { status: mapped, reason, sessionId: id }); changed.add(m.chatKey);
    }
    if (changed.size) { this.save(); for (const key of changed) this.onChange(key); }
  }
  listChats() {
    const chats = new Map();
    for (const m of this.messages) {
      const prev = chats.get(m.chatKey);
      const { media, ...summary } = m;
      chats.set(m.chatKey, { ...summary, text: m.text.slice(0, 160), count: (prev?.count || 0) + 1 });
    }
    return [...chats.values()].sort((a,b) => b.receivedAt - a.receivedAt);
  }
  forChat(chatKey) { return this.messages.filter(m => m.chatKey === chatKey); }
  mediaAt(receiptId, index) { return this.messages.find(m => m.id === receiptId)?.media?.[index]; }
}

export function incomingPreview(event) {
  if (!Array.isArray(event.message)) return String(event.raw_message ?? event.message ?? '').trim() || '[消息]';
  return event.message.filter(s => typeof s?.type === 'string').map(s => s.type === 'text' ? String(s.data?.text ?? '') : s.type === 'at' ? `@${s.data?.qq || ''}` : `[${({ image: '图片', file: '文件', record: '语音', video: '视频', reply: '引用', face: '表情' })[s.type] || s.type}]`).join('') || '[消息]';
}
