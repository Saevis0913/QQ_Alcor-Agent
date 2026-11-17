import { EventEmitter } from 'node:events';
import { encodeNativeFrame, createNativeFrameDecoder } from './frame.mjs';

const fault = (code, detail = code, extra = {}) => Object.assign(new Error(detail), { code, ...extra });
const accountValid = value => typeof value === 'string' && /^[0-9]{5,10}$/.test(value) && BigInt(value) > 0n;
function positive(value, name, upper = 0x7fffffff) {
  if (!Number.isInteger(value) || value < 1 || value > upper) throw new RangeError(`INVALID_${name}`);
  return value;
}

// Stream ownership transfers to the session. A closed session is terminal;
// a supervisor must create new streams and a new session, without replaying sends.
export class NativeSession extends EventEmitter {
  #phase = 'handshaking';
  #account = null;
  #channels;
  #peer = null;
  #helloTimer;
  #resolveReady;
  #rejectReady;
  #pending = new Map();
  #bytes = 0;
  #queuedWrites = 0;
  #next = 1;
  #ackTimeout;
  #replyTimeout;
  #maxPending;
  #maxBytes;

  constructor({ control, events, handshakeTimeoutMs = 5000, ackTimeoutMs = 5000,
    replyTimeoutMs = 30000, maxPending = 64, maxPendingBytes = 32 * 1024 * 1024 } = {}) {
    super();
    for (const stream of [control, events]) {
      if (!stream || typeof stream.on !== 'function' || typeof stream.write !== 'function' ||
        typeof stream.destroy !== 'function' || stream.destroyed || stream.readableEnded || stream.writableEnded) {
        throw new TypeError('CONNECTED_DUPLEX_REQUIRED');
      }
    }
    if (control === events) throw new TypeError('DISTINCT_CHANNELS_REQUIRED');
    positive(handshakeTimeoutMs, 'HELLO_TIMEOUT');
    this.#ackTimeout = positive(ackTimeoutMs, 'ACK_TIMEOUT');
    this.#replyTimeout = positive(replyTimeoutMs, 'REPLY_TIMEOUT');
    this.#maxPending = positive(maxPending, 'CAPACITY', 65535);
    this.#maxBytes = positive(maxPendingBytes, 'BYTE_CAPACITY');
    this.#channels = { control: { stream: control, hello: false }, events: { stream: events, hello: false } };
    this.ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject; });
    // Users may create the session before awaiting its ready promise.
    this.ready.catch(() => {});
    this.#helloTimer = setTimeout(() => this.#stop(fault('HELLO_TIMEOUT')), handshakeTimeoutMs);
    for (const [kind, channel] of Object.entries(this.#channels)) {
      const decoder = createNativeFrameDecoder({ onFrame: frame => this.#frame(kind, frame) });
      channel.stream.on('data', chunk => {
        if (this.#phase === 'closed') return;
        try { decoder.push(chunk); }
        catch (cause) { this.#stop(fault('PROTOCOL_ERROR', cause.message, { cause })); }
      });
      const ended = () => {
        if (this.#phase === 'closed') return;
        try { decoder.finish(); }
        catch (cause) { this.#stop(fault('PROTOCOL_ERROR', cause.message, { cause })); return; }
        this.#stop(fault('DISCONNECTED'));
      };
      channel.stream.on('end', ended);
      channel.stream.on('close', ended);
      channel.stream.on('error', cause => this.#stop(fault('IO_ERROR', cause.message, { cause })));
    }
  }

  snapshot() {
    return { phase: this.#phase, loggedIn: this.#account !== null, account: this.#account,
      usable: this.#phase === 'connected' && this.#account !== null,
      pendingRequests: this.#pending.size, retainedBytes: this.#bytes };
  }

  async request(command, payload, { wantReply = true, ackTimeoutMs = this.#ackTimeout, replyTimeoutMs = this.#replyTimeout } = {}) {
    this.#checkReady();
    if (!this.#account) throw fault('NOT_LOGGED_IN');
    if (typeof command !== 'string' || command.length === 0 || typeof wantReply !== 'boolean') throw new TypeError('INVALID_REQUEST');
    return this.#submit({ operation: 2, flags: wantReply ? 1 : 0, command, payload }, wantReply, ackTimeoutMs, replyTimeoutMs);
  }

  async hintIdentity(account) {
    this.#checkReady();
    if (!accountValid(account)) throw new TypeError('INVALID_ACCOUNT');
    return this.#submit({ operation: 17, scalar: BigInt(account) }, false, this.#ackTimeout, this.#replyTimeout);
  }

  close() { this.#stop(fault('CLOSED')); }

  #checkReady() {
    if (this.#phase === 'closed') throw fault('CLOSED');
    if (this.#phase !== 'connected') throw fault('NOT_READY');
  }

  #submit(frame, wantReply, ackTimeout, replyTimeout) {
    positive(ackTimeout, 'ACK_TIMEOUT'); positive(replyTimeout, 'REPLY_TIMEOUT');
    if (this.#pending.size >= this.#maxPending || this.#queuedWrites >= this.#maxPending) throw fault('CAPACITY');
    let id = this.#next;
    while (this.#pending.has(id)) id = id === 0xffffffff ? 1 : id + 1;
    this.#next = id === 0xffffffff ? 1 : id + 1;
    const encoded = encodeNativeFrame({ ...frame, correlationId: id });
    if (this.#bytes + encoded.length > this.#maxBytes) throw fault('CAPACITY');
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, wantReply, acked: false, earlyReply: null, earlyReplyBytes: 0,
        written: false, settled: false, bytes: encoded.length, replyTimeout,
        timer: setTimeout(() => this.#settle(id, fault('ACK_TIMEOUT')), ackTimeout) };
      this.#pending.set(id, pending); this.#bytes += encoded.length; this.#queuedWrites += 1;
      try {
        // Node serializes writes; the retained-byte/count budgets bound its queue.
        // The ACK deadline also bounds time spent waiting in that queue.
        this.#channels.control.stream.write(encoded, cause => {
          if (this.#phase === 'closed' || pending.written) return;
          pending.written = true; this.#queuedWrites -= 1;
          if (pending.settled) this.#bytes -= pending.bytes;
          if (cause) this.#stop(fault('IO_ERROR', cause.message, { cause }));
        });
      } catch (cause) { this.#stop(fault('IO_ERROR', cause.message, { cause })); }
    });
  }

  #settle(id, error, result) {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id); clearTimeout(pending.timer); pending.settled = true;
    // A timeout does not cancel a write already buffered by the stream.
    // Keep charging those bytes until its callback runs or the session closes.
    if (pending.written) this.#bytes -= pending.bytes;
    else { this.#bytes -= pending.earlyReplyBytes; pending.bytes -= pending.earlyReplyBytes; }
    pending.earlyReply = null;
    if (error) pending.reject(error); else pending.resolve(result);
  }

  #stop(error) {
    if (this.#phase === 'closed') return;
    this.#phase = 'closed'; this.#account = null; clearTimeout(this.#helloTimer);
    this.#rejectReady(error);
    for (const id of this.#pending.keys()) this.#settle(id, error);
    this.#bytes = 0; this.#queuedWrites = 0;
    for (const channel of Object.values(this.#channels)) channel.stream.destroy();
    this.emit('state', this.snapshot());
    if (error.code !== 'CLOSED') this.emit('fault', error);
    this.emit('closed', error);
  }

  #frame(kind, frame) {
    if (this.#phase === 'closed') return;
    const channel = this.#channels[kind];
    if (frame.operation === 1) {
      if (frame.scalar === 0n || frame.scalar > 0xffffffffn || (this.#peer !== null && this.#peer !== frame.scalar)) {
        throw fault('HELLO_IDENTITY');
      }
      this.#peer = frame.scalar; channel.hello = true;
      if (this.#phase === 'handshaking' && this.#channels.control.hello && this.#channels.events.hello) {
        this.#phase = 'connected'; clearTimeout(this.#helloTimer);
        this.#resolveReady(this.snapshot()); this.emit('state', this.snapshot());
      }
      return;
    }
    if (!channel.hello) throw fault('FRAME_BEFORE_HELLO');
    if (frame.operation === 7) {
      const loggedIn = (frame.flags & 4) !== 0 || frame.status !== 0;
      const account = loggedIn ? (frame.detail || frame.scalar.toString()) : null;
      if (loggedIn && (!accountValid(account) || (frame.scalar !== 0n && frame.scalar.toString() !== account))) {
        throw fault('INVALID_LOGIN');
      }
      if (account !== this.#account) {
        for (const id of this.#pending.keys()) this.#settle(id, fault('IDENTITY_CHANGED'));
        this.#account = account;
      }
      this.emit('state', this.snapshot()); return;
    }
    if (kind === 'events') { this.#event(frame); return; }
    const pending = this.#pending.get(frame.correlationId);
    if (!pending) return;
    if (frame.operation === 5) {
      this.#settle(frame.correlationId, fault('REMOTE_ERROR', frame.detail || 'Remote request failed', { status: frame.status })); return;
    }
    if (frame.operation === 3 && !pending.acked) {
      pending.acked = true; clearTimeout(pending.timer);
      if (!pending.wantReply) this.#settle(frame.correlationId, null, { stage: 'accepted', correlationId: frame.correlationId });
      else if (pending.earlyReply) this.#settle(frame.correlationId, null, pending.earlyReply);
      else pending.timer = setTimeout(() => this.#settle(frame.correlationId, fault('REPLY_TIMEOUT')), pending.replyTimeout);
      return;
    }
    if (frame.operation === 4 && pending.wantReply && !pending.earlyReply) {
      const reply = { stage: 'reply', correlationId: frame.correlationId, status: frame.status, detail: frame.detail, payload: frame.payload };
      if (pending.acked) { this.#settle(frame.correlationId, null, reply); return; }
      const extra = frame.payload.length + Buffer.byteLength(frame.detail);
      if (this.#bytes + extra > this.#maxBytes) { this.#settle(frame.correlationId, fault('CAPACITY')); return; }
      this.#bytes += extra; pending.bytes += extra; pending.earlyReplyBytes = extra; pending.earlyReply = reply;
    }
  }

  #event(frame) {
    const value = { sequence: frame.scalar, status: frame.status, command: frame.command,
      account: frame.detail, payload: frame.payload };
    if (frame.operation === 6) this.emit('packet', value);
    else if (frame.operation === 22) this.emit('receiptAvailability', { available: frame.status === 1, status: frame.status });
    else if (frame.operation === 21) {
      if (frame.command !== '' || frame.correlationId !== 0 || frame.flags !== 0 || frame.scalar <= 0n ||
        frame.scalar > BigInt(Number.MAX_SAFE_INTEGER) || !accountValid(frame.detail)) return;
      this.emit('receipt', value);
    }
  }
}
