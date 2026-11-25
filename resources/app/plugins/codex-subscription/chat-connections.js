import { openCodex } from './codex.js';

const MAX_IDLE = 2;
const IDLE_MS = 90_000;
const MAX_AGE_MS = 5 * 60_000;
// Unsubscribing stops events, but a Codex version can retain the ephemeral
// thread internally. Recycle the process to bound that memory.
const MAX_REQUESTS = 16;

export class ChatConnections {
  #idle = new Map();
  #lifetime = new AbortController();

  constructor(options) {
    this.options = options;
  }

  #take() {
    for (const [worker, timer] of this.#idle) {
      this.#idle.delete(worker);
      clearTimeout(timer);
      if (!worker.server.closed && Date.now() < worker.expiresAt) return worker;
      worker.server.close();
    }
    return null;
  }

  #return(worker) {
    const remaining = worker.expiresAt - Date.now();
    if (worker.server.closed || remaining <= 0 || worker.requests >= MAX_REQUESTS || this.#idle.size >= MAX_IDLE) {
      worker.server.close();
      return;
    }
    const timer = setTimeout(() => {
      this.#idle.delete(worker);
      worker.server.close();
    }, Math.min(IDLE_MS, remaining));
    timer.unref();
    this.#idle.set(worker, timer);
  }

  async run(signal, operation) {
    const scope = AbortSignal.any([this.#lifetime.signal, signal]);
    scope.throwIfAborted();
    let worker = this.#take();
    if (!worker) {
      const { server } = await openCodex(this.options, scope);
      worker = { server, expiresAt:Date.now() + MAX_AGE_MS, requests:0 };
    }
    try {
      const result = await worker.server.scoped(scope, operation);
      worker.requests++;
      this.#return(worker);
      return result;
    } catch (error) {
      worker.server.close();
      throw error;
    }
  }

  close(reason) {
    this.#lifetime.abort(reason);
    for (const [worker, timer] of this.#idle) {
      clearTimeout(timer);
      worker.server.close(reason);
    }
    this.#idle.clear();
  }
}
