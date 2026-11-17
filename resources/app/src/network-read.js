import { setTimeout as sleep } from 'node:timers/promises';

const transientCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
let activeReads = 0;

export function httpReadError(status, retryAfter) {
  const error = Object.assign(new Error('HTTP ' + status), { code: 'HTTP_READ_ERROR', status });
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(delay)) error.retryAfterMs = Math.max(0, delay);
  }
  return error;
}

// DNS and injected fetch implementations may not support cancellation themselves.
export function waitForRead(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function retryable(error) {
  return transientStatuses.has(error?.status) || transientCodes.has(error?.code) ||
    transientCodes.has(error?.cause?.code) || error?.code === 'READ_ATTEMPT_TIMEOUT';
}

/** GET only. The budget includes all attempts, response bodies and backoff.
 * The second operation argument records actual body progress, refreshing only
 * the attempt's idle timer. DNS/connect/headers and stalled bodies are bounded;
 * a slow but healthy stream still cannot exceed the shared total deadline. */
export async function retryRead(operation, {
  signal, timeoutMs = 20000, attemptMs = 8000, attempts = 3, label = '联网读取'
} = {}) {
  signal?.throwIfAborted();
  if (activeReads >= 4) throw Object.assign(new Error(label + '：读取任务繁忙，请稍后重试'), { code: 'READ_BUSY' });
  activeReads++;
  const budget = Math.max(1, Math.min(60000, Number(timeoutMs) || 20000));
  const deadline = Date.now() + budget;
  const total = new AbortController();
  const expired = Object.assign(new Error(label + '：总时限 ' + budget + 'ms 已到，读取超时'), { code: 'READ_DEADLINE' });
  const timer = setTimeout(() => total.abort(expired), budget);
  const overall = signal ? AbortSignal.any([signal, total.signal]) : total.signal;
  const count = Math.max(1, Math.min(3, Math.trunc(attempts) || 1));
  let attempted = 0;
  try {
    for (let index = 0; index < count; index++) {
      overall.throwIfAborted();
      attempted++;
      const attempt = new AbortController();
      const current = AbortSignal.any([overall, attempt.signal]);
      let attemptTimer;
      let active = true;
      const progress = () => {
        if (!active || current.aborted) return;
        clearTimeout(attemptTimer);
        const idleMs = Math.max(1, Number(attemptMs) || 8000);
        // Let the original total timer own its boundary; scheduling a second
        // timer for the same deadline can mislabel a total timeout as idle.
        if (deadline - Date.now() <= idleMs) return;
        attemptTimer = setTimeout(() => attempt.abort(Object.assign(new Error('单次读取超时'),
          { code: 'READ_ATTEMPT_TIMEOUT' })), idleMs);
      };
      progress();
      let failure;
      try {
        return await waitForRead(Promise.resolve().then(() => operation(current, progress)), current);
      } catch (error) {
        if (overall.aborted) throw overall.reason;
        failure = attempt.signal.aborted ? attempt.signal.reason : error;
        if (!retryable(failure) || index + 1 >= count) throw failure;
      } finally { active = false; clearTimeout(attemptTimer); }
      const delay = Math.max(200 * 2 ** index + Math.floor(Math.random() * 100), failure.retryAfterMs || 0);
      if (delay >= deadline - Date.now()) throw failure;
      await sleep(delay, undefined, { signal: overall });
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (total.signal.aborted) throw total.signal.reason;
    if (retryable(error)) {
      const reason = error.status ? 'HTTP ' + error.status : error.code === 'READ_ATTEMPT_TIMEOUT'
        ? '单次读取超时' : error.code || error.cause?.code || '网络错误';
      throw Object.assign(new Error(label + '：' + reason + '（已尝试 ' + attempted + ' 次）', { cause: error }),
        { code: error.code || error.cause?.code, status: error.status, attempts: attempted });
    }
    throw error;
  } finally { clearTimeout(timer); activeReads--; }
}

/** Fixed/admin-configured endpoints only; safe-fetch owns the SSRF boundary. */
export async function readGet(url, {
  fetchImpl = globalThis.fetch, headers, redirect = 'error', maxBytes = 1024 * 1024,
  accepts = () => true, label = '联网读取', beforeAttempt, ...options
} = {}) {
  return retryRead(async (signal, progress) => {
    beforeAttempt?.();
    const response = await fetchImpl(url, { method: 'GET', headers, redirect, credentials: 'omit', signal });
    if (signal.aborted) { await response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
    if (!response.ok) {
      await response.body?.cancel();
      throw httpReadError(response.status, response.headers.get('retry-after'));
    }
    const contentType = response.headers.get('content-type') || '';
    if (!response.body || !accepts(contentType)) {
      await response.body?.cancel();
      throw new Error(label + '：响应内容类型无效');
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body.cancel(); throw new Error(label + '：响应超过大小上限');
    }
    const reader = response.body.getReader();
    const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    let size = 0;
    const chunks = [];
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await waitForRead(reader.read(), signal);
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error(label + '：响应超过大小上限');
        if (value.byteLength > 0) progress();
        chunks.push(value);
      }
      signal.throwIfAborted();
      return { buffer: Buffer.concat(chunks, size), contentType };
    } finally {
      signal.removeEventListener('abort', abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }, { ...options, label });
}
