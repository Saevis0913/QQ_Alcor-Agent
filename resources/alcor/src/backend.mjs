import { randomUUID } from 'node:crypto';
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
  try { result = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); } catch { throw new BridgeError('UPSTREAM_INVALID_JSON', 502); }
  return validateResponse(result, depthLimit);
}

function validateResponse(result, depthLimit) {
  if (!withinJsonDepth(result, depthLimit)) throw new BridgeError('UPSTREAM_JSON_TOO_DEEP', 502);
  if (!result || Array.isArray(result) || !['ok', 'failed', 'async'].includes(result.status) || !Number.isInteger(result.retcode)) throw new BridgeError('UPSTREAM_INVALID_RESPONSE', 502);
  if ((result.status === 'ok') !== (result.retcode === 0)) throw new BridgeError('UPSTREAM_INCONSISTENT_RESPONSE', 502);
  return result;
}

export class Backend {
  constructor(config) {
    this.config = config; this.stopped = true; this.socket = null; this.timer = null;
    this.heartbeat = null; this.attempt = 0; this.controllers = new Set();
    this.wsWaiters = new Set();
    this.wsRequests = new Map();
    this.lastWsApiReply = null;
    this.state = {
      ws: 'stopped', http: config.backend.httpUrl ? 'unverified' : 'disabled',
      qqOnline: null, lastError: null, reconnects: 0, events: 0
    };
  }
  snapshot() {
    const httpApi = Boolean(this.config.backend.httpUrl);
    const receiveReady = this.socket?.readyState === WebSocket.OPEN;
    return {
      ...this.state, type: 'onebot', receiveReady,
      apiTransport: httpApi ? 'http' : 'websocket',
      apiReady: httpApi ? this.state.http === 'reachable' : receiveReady && this.lastWsApiReply !== null
    };
  }

  async call(action, params, reserveResponseBytes) {
    if (!this.config.backend.httpUrl) return this.#callOverWebSocket(action, params, reserveResponseBytes);
    const socket = this.socket;
    const controller = new AbortController(); this.controllers.add(controller);
    let delivery = isQuery(action) ? undefined : 'unknown';
    const timeout = setTimeout(() => controller.abort(), isQuery(action) ? this.config.requestTimeoutMs : this.config.sendTimeoutMs);
    try {
      const response = await fetch(`${this.config.backend.httpUrl}/${action}`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(this.config.backend.httpToken ? { authorization: `Bearer ${this.config.backend.httpToken}` } : {}) },
        body: JSON.stringify(params)
      });
      if (!response.ok) {
        if (response.status !== 408 && (response.status < 500 || response.status === 501)) delivery = undefined;
        await response.body?.cancel();
        this.state.http = response.status === 401 || response.status === 403 ? 'auth_failed' : 'failed';
        throw new BridgeError(`UPSTREAM_HTTP_${response.status}`, 502);
      }
      const result = await readResponse(response, this.config.maxResponseBytes, this.config.maxJsonDepth, reserveResponseBytes);
      this.state.http = 'reachable';
      this.#observeStatus(action, result, socket);
      this.state.lastError = null;
      return result;
    } catch (error) {
      const failure = error instanceof BridgeError ? error : new BridgeError(controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE', controller.signal.aborted ? 504 : 502);
      this.state.lastError = failure.code;
      if (this.state.http !== 'auth_failed') this.state.http = 'failed';
      throw delivery ? new BridgeError(failure.code, failure.httpStatus, delivery) : failure;
    } finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }
  #observeStatus(action, result, socket) {
    if (action === 'get_status' && socket && this.socket === socket && result.status === 'ok' &&
        typeof result.data?.online === 'boolean') this.state.qqOnline = result.data.online;
  }

  async #awaitWebSocket(signal) {
    signal.throwIfAborted();
    if (this.stopped) throw new BridgeError('UPSTREAM_WS_STOPPED', 503);
    if (this.state.ws === 'auth_failed') throw new BridgeError('UPSTREAM_WS_AUTH_FAILED', 502);
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    return new Promise((resolve, reject) => {
      const finish = (settle, value) => {
        this.wsWaiters.delete(waiter);
        signal.removeEventListener('abort', abort);
        settle(value);
      };
      const abort = () => finish(reject, signal.reason);
      const waiter = {
        resolve: socket => finish(resolve, socket),
        reject: error => finish(reject, error)
      };
      this.wsWaiters.add(waiter);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  async #callOverWebSocket(action, params, reserveResponseBytes) {
    // get_bridge_info can issue three backend queries for one client request.
    if (this.controllers.size >= (this.config.maxConcurrent ?? 32) * 3) throw new BridgeError('UPSTREAM_WS_BUSY', 503);
    const controller = new AbortController();
    this.controllers.add(controller);
    const query = isQuery(action);
    const timeout = setTimeout(() => controller.abort(new BridgeError('UPSTREAM_TIMEOUT', 504)),
      query ? this.config.requestTimeoutMs : this.config.sendTimeoutMs);
    let sent = false;
    let socket, previousApiReply;
    try {
      socket = query ? await this.#awaitWebSocket(controller.signal) : this.socket;
      controller.signal.throwIfAborted();
      if (socket !== this.socket || socket?.readyState !== WebSocket.OPEN) {
        if (query) throw new BridgeError('UPSTREAM_WS_DISCONNECTED', 502);
        throw new BridgeError('UPSTREAM_WS_NOT_READY', 503);
      }

      previousApiReply = this.lastWsApiReply;
      const echo = randomUUID();
      const payload = JSON.stringify({ action, params, echo });
      if (socket.bufferedAmount + Buffer.byteLength(payload) > this.config.maxBufferedBytes) {
        throw new BridgeError('UPSTREAM_WS_BACKPRESSURE', 503);
      }
      const result = await new Promise((resolve, reject) => {
        const finish = (settle, value) => {
          if (!this.wsRequests.delete(echo)) return;
          controller.signal.removeEventListener('abort', abort);
          settle(value);
        };
        const abort = () => finish(reject, controller.signal.reason);
        const pending = {
          socket, reserveResponseBytes,
          resolve: value => finish(resolve, value),
          reject: error => finish(reject, error)
        };
        this.wsRequests.set(echo, pending);
        controller.signal.addEventListener('abort', abort, { once: true });
        try {
          socket.send(payload, error => {
            if (error) pending.reject(new BridgeError('UPSTREAM_WS_SEND_FAILED', 502));
          });
          sent = true;
        } catch {
          pending.reject(new BridgeError('UPSTREAM_WS_SEND_FAILED', 502));
        }
      });
      this.#observeStatus(action, result, socket);
      if (this.socket === socket) {
        this.lastWsApiReply = echo;
        this.state.lastError = null;
      }
      return result;
    } catch (error) {
      const failure = error instanceof BridgeError ? error : new BridgeError('UPSTREAM_WS_ERROR', 502);
      if (action === 'get_status' && sent && this.socket === socket &&
          this.lastWsApiReply === previousApiReply && failure.code.startsWith('UPSTREAM_')) {
        this.lastWsApiReply = null;
      }
      if (!this.stopped) this.state.lastError = failure.code;
      if (sent && !query) throw new BridgeError(failure.code, failure.httpStatus, 'unknown');
      throw failure;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  start(onEvent) { if (!this.stopped) return; this.stopped = false; this.onEvent = onEvent; this.connect(); }
  connect() {
    if (this.stopped) return;
    this.state.ws = 'connecting';
    this.lastWsApiReply = null;
    let authFailed = false;
    const socket = new WebSocket(this.config.backend.wsUrl, {
      headers: this.config.backend.wsToken ? { authorization: `Bearer ${this.config.backend.wsToken}` } : {},
      maxPayload: this.config.maxResponseBytes, handshakeTimeout: this.config.requestTimeoutMs,
      perMessageDeflate: false, followRedirects: false
    });
    this.socket = socket;
    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.attempt = 0; this.state.ws = 'open'; this.state.lastError = null;
      for (const waiter of this.wsWaiters) waiter.resolve(socket);
      let alive = true;
      socket.on('pong', () => { alive = true; });
      this.heartbeat = setInterval(() => {
        if (!alive) { socket.terminate(); return; }
        alive = false; if (socket.readyState === WebSocket.OPEN) socket.ping();
      }, this.config.wsHeartbeatMs);
      this.heartbeat.unref();
    });
    socket.on('message', (bytes, binary) => {
      if (this.socket !== socket || binary) return;
      let event; try { event = JSON.parse(bytes.toString('utf8')); } catch { this.state.lastError = 'UPSTREAM_INVALID_EVENT'; return; }
      const pending = this.wsRequests.get(event?.echo);
      if (pending?.socket === socket && !Object.hasOwn(event, 'post_type')) {
        try {
          pending.reserveResponseBytes?.(bytes.length);
          pending.resolve(validateResponse(event, this.config.maxJsonDepth));
        } catch (error) {
          pending.reject(error);
        }
        return;
      }
      if (!withinJsonDepth(event, this.config.maxJsonDepth)) { this.state.lastError = 'UPSTREAM_EVENT_TOO_DEEP'; return; }
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.post_type !== 'string') return;
      if (event.post_type === 'meta_event' && event.meta_event_type === 'heartbeat' && typeof event.status?.online === 'boolean') {
        this.state.qqOnline = event.status.online;
      }
      this.state.events++;
      try { this.onEvent(event); } catch { this.state.lastError = 'EVENT_DELIVERY_ERROR'; }
    });
    socket.on('unexpected-response', (_request, response) => {
      if (this.socket === socket) {
        authFailed = response.statusCode === 401 || response.statusCode === 403;
        this.state.lastError = `UPSTREAM_WS_HTTP_${response.statusCode}`;
        if (authFailed) this.state.ws = 'auth_failed';
      }
      response.resume(); socket.terminate();
    });
    socket.on('error', () => { if (this.socket === socket && !authFailed) this.state.lastError = 'UPSTREAM_WS_ERROR'; });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      clearInterval(this.heartbeat); this.heartbeat = null;
      this.state.qqOnline = null;
      this.lastWsApiReply = null;
      for (const pending of this.wsRequests.values()) {
        if (pending.socket === socket) pending.reject(new BridgeError('UPSTREAM_WS_DISCONNECTED', 502));
      }
      if (authFailed) {
        for (const waiter of this.wsWaiters) waiter.reject(new BridgeError('UPSTREAM_WS_AUTH_FAILED', 502));
        return;
      }
      this.state.ws = 'disconnected';
      const delay = Math.min(this.config.reconnectMaxMs, this.config.reconnectMinMs * 2 ** Math.min(this.attempt++, 16));
      this.state.reconnects++;
      this.timer = setTimeout(() => this.connect(), delay + Math.floor(Math.random() * delay / 4));
      this.timer.unref();
    });
  }
  async close() {
    this.stopped = true; clearTimeout(this.timer); clearInterval(this.heartbeat);
    this.timer = null; this.heartbeat = null;
    const socket = this.socket; this.socket = null;
    this.state.ws = 'stopped'; this.state.qqOnline = null;
    this.lastWsApiReply = null;
    const reason = this.config.backend.httpUrl ? undefined : new BridgeError('UPSTREAM_WS_STOPPED', 503);
    for (const controller of this.controllers) controller.abort(reason);
    socket?.terminate();
  }
}
