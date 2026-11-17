import { createHmac } from 'node:crypto';
import WebSocket from '../vendor/ws/wrapper.mjs';
import { withinJsonDepth } from './json.mjs';

const failure = code => ({ status: 'failed', retcode: 1400, data: null, wording: code });
const validId = value => /^[1-9]\d{0,9}$/.test(String(value)) && Number(value) <= 0xffffffff;
const errorCode = error => /^[A-Z][A-Z0-9_]{1,90}$/.test(error?.code || '') ? error.code : 'CALLBACK_UNREACHABLE';

// Each destination has a bounded queue. Ambiguous POSTs and WS actions are never replayed.
export function createOutboundTransports(config, { getAccount, execute, log = () => {} }) {
  const cap = Math.min(config.maxBufferedBytes, 2 * 1024 * 1024);
  const httpRows = config.httpCallbacks.map((options, id) => ({ options, id, queue: [], bytes: 0,
    state: 'idle', delivered: 0, failed: 0, dropped: 0, lastError: null, running: null, controller: null }));
  const wsRows = config.reverseWebSockets.map((options, id) => ({ options, id, socket: null,
    state: 'waiting_account', delivered: 0, failed: 0, dropped: 0, reconnects: 0, lastError: null,
    timer: null, heartbeat: null, attempt: 0, nextAt: 0, authFailed: false }));
  let stopped = false, started = false, account = null, checking = null, monitor = null;
  const tasks = new Set();

  function report(row, code) { row.lastError = code; log('warn', 'transport', code); }
  async function refreshAccount() {
    if (checking) return checking;
    checking = (async () => {
      let next = null;
      try { const value = await getAccount(); if (validId(value)) next = String(value); } catch { /* Wait for a confirmed backend identity. */ }
      if (stopped) return null;
      if (next !== account) {
        account = next;
        for (const row of httpRows) {
          row.dropped += row.queue.length; row.queue.length = 0; row.bytes = 0; row.controller?.abort();
        }
        for (const row of wsRows) { row.socket?.terminate(); row.authFailed = false; row.attempt = 0; row.nextAt = 0; }
      }
      for (const row of wsRows) if (!row.socket && !row.authFailed && Date.now() >= row.nextAt) connect(row);
      return account;
    })().finally(() => { checking = null; });
    return checking;
  }

  async function responseBody(response) {
    if (Number(response.headers.get('content-length')) > 65536) {
      await response.body?.cancel(); throw Object.assign(new Error(), { code: 'CALLBACK_RESPONSE_TOO_LARGE' });
    }
    const chunks = []; let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const value = await reader.read(); if (value.done) break;
          bytes += value.value.byteLength;
          if (bytes > 65536) throw Object.assign(new Error(), { code: 'CALLBACK_RESPONSE_TOO_LARGE' });
          chunks.push(value.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  async function quickReply(row, text, event, selfId) {
    if (!row.options.quickReply || !text.trim()) return;
    let value;
    try { value = JSON.parse(text); } catch { report(row, 'CALLBACK_INVALID_JSON'); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !withinJsonDepth(value, config.maxJsonDepth)) {
      report(row, 'CALLBACK_INVALID_RESPONSE'); return;
    }
    if (Object.keys(value).some(k => !['reply', 'auto_escape', 'at_sender'].includes(k))) report(row, 'CALLBACK_QUICK_OPERATION_UNSUPPORTED');
    if (value.reply === undefined) return;
    if (event.post_type !== 'message' || !['private', 'group'].includes(event.message_type) ||
        !(typeof value.reply === 'string' || Array.isArray(value.reply))) { report(row, 'CALLBACK_INVALID_REPLY'); return; }
    if (stopped || await refreshAccount() !== selfId) { report(row, 'OUTBOUND_ACCOUNT_CHANGED'); return; }
    const group = event.message_type === 'group';
    const params = { message: value.reply, auto_escape: value.auto_escape === true };
    if (!validId(group ? event.group_id : event.user_id)) { report(row, 'CALLBACK_INVALID_RECIPIENT'); return; }
    params[group ? 'group_id' : 'user_id'] = group ? event.group_id : event.user_id;
    // Explicit at_sender is supported for structured/plain text replies without parsing CQ content.
    if (group && value.at_sender === true && validId(event.user_id)) {
      params.message = [{ type: 'at', data: { qq: String(event.user_id) } },
        ...(Array.isArray(value.reply) ? value.reply : [{ type: 'text', data: { text: value.reply } }])];
    }
    const result = await execute({ action: group ? 'send_group_msg' : 'send_private_msg', params }, selfId);
    if (result.status !== 'ok') report(row, result.wording || 'CALLBACK_QUICK_REPLY_FAILED');
  }
  async function drain(row) {
    while (!stopped && row.queue.length) {
      const item = row.queue.shift(); row.bytes -= item.size;
      if (item.selfId !== account || Date.now() - item.createdAt > 30000) { row.dropped++; continue; }
      const controller = new AbortController(); row.controller = controller; row.state = 'sending';
      const timeout = setTimeout(() => controller.abort(), row.options.timeoutMs); timeout.unref();
      try {
        const response = await fetch(row.options.url, { method: 'POST', redirect: 'manual', signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-self-id': item.selfId,
            ...(row.options.secret ? { 'x-signature': 'sha1=' + createHmac('sha1', row.options.secret).update(item.json).digest('hex') } : {}) },
          body: item.json });
        if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(), { code: `CALLBACK_HTTP_${response.status}` }); }
        const body = await responseBody(response);
        row.delivered++; row.lastError = null;
        await quickReply(row, body, item.event, item.selfId);
      } catch (error) {
        if (!stopped) { row.failed++; report(row, controller.signal.aborted ? 'CALLBACK_ABORTED_OR_TIMEOUT' : errorCode(error)); }
      } finally { clearTimeout(timeout); row.controller = null; row.state = stopped ? 'stopped' : 'idle'; }
    }
  }

  function send(row, value) {
    const socket = row.socket;
    if (socket?.readyState !== WebSocket.OPEN) { row.dropped++; return; }
    let json;
    try { json = JSON.stringify(value); } catch { row.dropped++; return; }
    if (Buffer.byteLength(json) > config.maxResponseBytes || socket.bufferedAmount + Buffer.byteLength(json) > cap) {
      row.dropped++; report(row, 'REVERSE_WS_BACKPRESSURE'); socket.terminate(); return;
    }
    socket.send(json, error => { if (error) { row.failed++; socket.terminate(); } else row.delivered++; });
  }
  function connect(row) {
    if (stopped || !account) { row.state = stopped ? 'stopped' : 'waiting_account'; return; }
    const selfId = account;
    row.state = 'connecting';
    const socket = new WebSocket(row.options.url, { followRedirects: false, perMessageDeflate: false,
      maxPayload: config.maxBodyBytes, handshakeTimeout: config.requestTimeoutMs,
      headers: { 'x-self-id': selfId, 'x-client-role': 'Universal',
        ...(row.options.token ? { authorization: 'Bearer ' + row.options.token } : {}) } });
    row.socket = socket;
    socket.on('open', () => {
      if (stopped || account !== selfId) { socket.terminate(); return; }
      row.state = 'open'; row.lastError = null; row.attempt = 0;
      let alive = true;
      socket.on('pong', () => { alive = true; });
      row.heartbeat = setInterval(() => {
        if (!alive) { report(row, 'REVERSE_WS_HEARTBEAT_TIMEOUT'); socket.terminate(); return; }
        alive = false; if (socket.readyState === WebSocket.OPEN) socket.ping();
      }, config.wsHeartbeatMs); row.heartbeat.unref();
    });
    socket.on('message', (bytes, binary) => {
      if (stopped || selfId !== account) return;
      if (binary) { send(row, failure('TEXT_JSON_REQUIRED')); return; }
      let request;
      try { request = JSON.parse(bytes.toString('utf8')); } catch { send(row, failure('INVALID_JSON')); return; }
      const task = execute(request, selfId, bytes.length).then(value => {
        if (!stopped && account === selfId && row.socket === socket) send(row, value);
      }).catch(() => { if (!stopped && row.socket === socket) send(row, failure('REVERSE_WS_ACTION_FAILED')); });
      tasks.add(task); task.finally(() => tasks.delete(task));
    });
    socket.on('unexpected-response', (_req, response) => {
      row.authFailed = response.statusCode === 401 || response.statusCode === 403;
      report(row, `REVERSE_WS_HTTP_${response.statusCode}`); response.resume(); socket.terminate();
    });
    socket.on('error', () => { if (!row.authFailed && !stopped) report(row, 'REVERSE_WS_ERROR'); });
    socket.on('close', () => {
      clearInterval(row.heartbeat); row.heartbeat = null;
      if (row.socket === socket) row.socket = null;
      row.state = stopped ? 'stopped' : row.authFailed ? 'auth_failed' : 'disconnected';
      if (stopped || row.authFailed) return;
      row.reconnects++;
      const delay = Math.min(config.reconnectMaxMs, config.reconnectMinMs * 2 ** Math.min(row.attempt++, 16));
      row.nextAt = Date.now() + delay;
      clearTimeout(row.timer);
      row.timer = setTimeout(() => { row.timer = null; void refreshAccount(); }, delay); row.timer.unref();
    });
  }

  return {
    start() {
      if (started || stopped) return; started = true;
      if (httpRows.length || wsRows.length) {
        void refreshAccount(); monitor = setInterval(() => void refreshAccount(), 1000); monitor.unref();
      }
    },
    publish(event) {
      if (stopped || !validId(event?.self_id)) return;
      const selfId = String(event.self_id);
      // Source events carry an authenticated native/backend identity; the monitor handles subsequent switches.
      if (!account) { account = selfId; for (const row of wsRows) if (!row.socket) connect(row); }
      if (selfId !== account) return;
      let json; try { json = JSON.stringify(event); } catch { return; }
      const size = Buffer.byteLength(json);
      for (const row of httpRows) {
        if (size > config.maxResponseBytes || row.queue.length + Number(!!row.running) >= row.options.maxQueue || row.bytes + size > cap) {
          row.dropped++; report(row, 'CALLBACK_QUEUE_FULL'); continue;
        }
        row.queue.push({ event, selfId, json, size, createdAt: Date.now() }); row.bytes += size;
        if (!row.running) row.running = drain(row).finally(() => { row.running = null; });
      }
      for (const row of wsRows) send(row, event);
    },
    snapshot() {
      const common = row => ({ id: row.id, state: row.state, delivered: row.delivered, failed: row.failed,
        dropped: row.dropped, lastError: row.lastError });
      return { httpCallbacks: httpRows.map(row => ({ ...common(row), pending: row.queue.length + Number(!!row.running), queuedBytes: row.bytes })),
        reverseWebSockets: wsRows.map(row => ({ ...common(row), reconnects: row.reconnects })) };
    },
    async close() {
      if (stopped) return; stopped = true; clearInterval(monitor);
      for (const row of httpRows) { row.queue.length = 0; row.bytes = 0; row.controller?.abort(); row.state = 'stopped'; }
      for (const row of wsRows) { clearTimeout(row.timer); clearInterval(row.heartbeat); row.socket?.terminate(); row.state = 'stopped'; }
      await Promise.allSettled(httpRows.map(row => row.running));
    }
  };
}
