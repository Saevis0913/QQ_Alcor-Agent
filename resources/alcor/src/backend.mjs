import WebSocket from '../vendor/ws/wrapper.mjs';
import { withinJsonDepth } from './json.mjs';

export const isQuery = action => /^(get_|can_)/.test(action);
export class BridgeError extends Error {
  constructor(code, httpStatus, delivery) { super(code); this.code = code; this.httpStatus = httpStatus; this.delivery = delivery; }
}

async function readResponse(response, limit, depthLimit, reserve) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel(); throw new BridgeError('UPSTREAM_RESPONSE_TOO_LARGE', 502);
  }
  const chunks = []; let bytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) throw new BridgeError('UPSTREAM_RESPONSE_TOO_LARGE', 502);
        reserve?.(value.byteLength);
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BridgeError('UPSTREAM_INVALID_JSON', 502); }
  if (!withinJsonDepth(result, depthLimit)) throw new BridgeError('UPSTREAM_JSON_TOO_DEEP', 502);
  if (!result || Array.isArray(result) || !['ok', 'failed', 'async'].includes(result.status) || !Number.isInteger(result.retcode)) throw new BridgeError('UPSTREAM_INVALID_RESPONSE', 502);
  if ((result.status === 'ok') !== (result.retcode === 0)) throw new BridgeError('UPSTREAM_INCONSISTENT_RESPONSE', 502);
  return result;
}

export class Backend {
  constructor(config) {
    this.config = config; this.stopped = true; this.socket = null; this.timer = null;
    this.heartbeat = null; this.attempt = 0; this.controllers = new Set();
    this.state = { ws: 'stopped', http: 'unverified', qqOnline: null, lastError: null, reconnects: 0, events: 0 };
  }
  snapshot() { return { ...this.state }; }
  async call(action, params, reserveResponseBytes) {
    const controller = new AbortController(); this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), isQuery(action) ? this.config.requestTimeoutMs : this.config.sendTimeoutMs);
    try {
      const response = await fetch(`${this.config.backend.httpUrl}/${action}`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(this.config.backend.httpToken ? { authorization: `Bearer ${this.config.backend.httpToken}` } : {}) },
        body: JSON.stringify(params)
      });
      if (!response.ok) {
        await response.body?.cancel();
        this.state.http = response.status === 401 || response.status === 403 ? 'auth_failed' : 'failed';
        throw new BridgeError(`UPSTREAM_HTTP_${response.status}`, 502);
      }
      const result = await readResponse(response, this.config.maxResponseBytes, this.config.maxJsonDepth, reserveResponseBytes);
      this.state.http = 'reachable';
      if (action === 'get_status') this.state.qqOnline = result.status === 'ok' && result.retcode === 0 && result.data?.online === true;
      this.state.lastError = null;
      return result;
    } catch (error) {
      const failure = error instanceof BridgeError ? error : new BridgeError(controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE', controller.signal.aborted ? 504 : 502, isQuery(action) ? undefined : 'unknown');
      this.state.lastError = failure.code;
      if (this.state.http !== 'auth_failed') this.state.http = 'failed';
      this.state.qqOnline = null;
      throw failure;
    } finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }
  start(onEvent) { if (!this.stopped) return; this.stopped = false; this.onEvent = onEvent; this.connect(); }
  connect() {
    if (this.stopped) return;
    this.state.ws = 'connecting';
    let authFailed = false;
    const socket = new WebSocket(this.config.backend.wsUrl, {
      headers: this.config.backend.wsToken ? { authorization: `Bearer ${this.config.backend.wsToken}` } : {},
      maxPayload: this.config.maxResponseBytes, handshakeTimeout: this.config.requestTimeoutMs,
      perMessageDeflate: false, followRedirects: false
    });
    this.socket = socket;
    socket.on('open', () => {
      this.attempt = 0; this.state.ws = 'open'; this.state.lastError = null;
      let alive = true;
      socket.on('pong', () => { alive = true; });
      this.heartbeat = setInterval(() => {
        if (!alive) { socket.terminate(); return; }
        alive = false; if (socket.readyState === WebSocket.OPEN) socket.ping();
      }, this.config.wsHeartbeatMs);
      this.heartbeat.unref();
    });
    socket.on('message', (bytes, binary) => {
      if (binary) return;
      let event; try { event = JSON.parse(bytes.toString('utf8')); } catch { this.state.lastError = 'UPSTREAM_INVALID_EVENT'; return; }
      if (!withinJsonDepth(event, this.config.maxJsonDepth)) { this.state.lastError = 'UPSTREAM_EVENT_TOO_DEEP'; return; }
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.post_type !== 'string') return;
      this.state.events++;
      try { this.onEvent(event); } catch { this.state.lastError = 'EVENT_DELIVERY_ERROR'; }
    });
    socket.on('unexpected-response', (_request, response) => {
      authFailed = response.statusCode === 401 || response.statusCode === 403;
      this.state.lastError = `UPSTREAM_WS_HTTP_${response.statusCode}`;
      if (authFailed) this.state.ws = 'auth_failed';
      response.resume(); socket.terminate();
    });
    socket.on('error', () => { if (!authFailed) this.state.lastError = 'UPSTREAM_WS_ERROR'; });
    socket.on('close', () => {
      clearInterval(this.heartbeat); this.heartbeat = null;
      if (this.stopped) { this.state.ws = 'stopped'; return; }
      if (authFailed) return;
      this.state.ws = 'disconnected';
      this.state.qqOnline = null;
      const delay = Math.min(this.config.reconnectMaxMs, this.config.reconnectMinMs * 2 ** Math.min(this.attempt++, 16));
      this.state.reconnects++;
      this.timer = setTimeout(() => this.connect(), delay + Math.floor(Math.random() * delay / 4));
      this.timer.unref();
    });
  }
  async close() {
    this.stopped = true; clearTimeout(this.timer); clearInterval(this.heartbeat);
    for (const controller of this.controllers) controller.abort();
    this.socket?.terminate(); this.state.ws = 'stopped';
  }
}
