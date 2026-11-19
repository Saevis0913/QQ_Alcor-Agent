// Shared, revocable service access for the bundled extensions. Never exposes credentials.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

let active = null;
export const getBuiltinRuntime = () => active;
export function bindBuiltinRuntime(runtime) {
  if (active && active !== runtime) active.close();
  active = runtime;
  return runtime;
}
const fail = (code, message) => Object.assign(new Error(message), { code });
const qq = /^[1-9]\d{4,10}$/;

export function createBuiltinRuntime(services) {
  const listeners = new Map(), pending = new Set(), busy = new Set();
  let closed = false, previousAccount = String(services.account?.() || '');
  const now = services.now || Date.now;
  const account = () => closed ? '' : String(services.account?.() || '');
  const isCurrent = value => !!value && qq.test(String(value)) && account() === String(value);
  function assertCurrent(meta) {
    if (closed || !isCurrent(meta.account)) throw fail('BUILTIN_CANCELLED', '账号已断开或切换，本次扩展任务已停止。');
    if (services.isEnabled?.(meta.extensionId) === false) throw fail('BUILTIN_DISABLED', '扩展已关闭。');
  }
  function reserve(meta) {
    const day = new Date(now() + 8 * 3600000).toISOString().slice(0, 10);
    const dir = path.join(services.dataDir, 'builtins', 'usage', meta.account);
    const file = path.join(dir, meta.extensionId + '.json');
    let usage = { day, calls: 0 };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.day === day) usage.calls = Math.max(0, Number(saved.calls) || 0);
    } catch (error) {
      if (error.code !== 'ENOENT') throw fail('BUILTIN_BUDGET_INVALID', '扩展用量记录无法读取，请检查本地数据文件。');
    }
    const limit = Math.max(1, Math.min(500, Number(services.settings?.(meta.extensionId)?.maxModelCallsPerDay) || 60));
    if (usage.calls >= limit) throw fail('BUILTIN_DAILY_LIMIT', '该扩展今日模型调用已达上限，明日恢复。');
    usage.calls++;
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(usage)); fs.renameSync(tmp, file); }
    finally { try { fs.unlinkSync(tmp); } catch { /* already renamed */ } }
  }
  const runtime = {
    store: services.store, memory: services.memory, sender: services.sender,
    onebot: services.onebot, sessions: services.sessions, stickers: services.stickers,
    account, isCurrent, now,
    // 机器人被暂停时后台任务（记忆归档、群风格学习、异常汇总）不该继续花模型额度或对外发消息。
    isPaused: () => services.isPaused?.() === true,
    async status() {
      const state = await services.status?.() || {};
      return { connected: !!account(), backendReady: !!account(), receiveReady: !!account(), paused: false, ...state, selfId: account() };
    },
    subscribe(event, listener) {
      if (closed || typeof listener !== 'function') return () => {};
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return () => listeners.get(event)?.delete(listener);
    },
    publish(event, payload) {
      if (closed) return;
      for (const listener of listeners.get(event) || []) {
        try { Promise.resolve(listener(payload)).catch(() => {}); } catch { /* isolate subscribers */ }
      }
    },
    refresh() {
      const current = account();
      if (current !== previousAccount) {
        for (const controller of pending) controller.abort();
        previousAccount = current;
      }
      runtime.status().then(state => runtime.publish('status', state)).catch(() => {});
    },
    async complete(args, meta = {}) {
      if (!/^[a-z][a-z0-9-]{1,63}$/.test(meta.extensionId || '') || !qq.test(String(meta.account || ''))) {
        throw fail('BUILTIN_CONTEXT_INVALID', '缺少扩展标识或有效账号。');
      }
      assertCurrent(meta);
      const key = `${meta.account}/${meta.extensionId}`;
      if (busy.has(key)) throw fail('BUILTIN_BUSY', '该扩展已有模型任务正在执行。');
      meta.signal?.throwIfAborted(); args.signal?.throwIfAborted();
      reserve(meta);
      const controller = new AbortController();
      const signals = [controller.signal, meta.signal, args.signal, AbortSignal.timeout(90000)].filter(Boolean);
      const signal = AbortSignal.any(signals);
      busy.add(key); pending.add(controller);
      let response, error;
      try {
        response = await services.complete({ ...args, tools: null, toolChoice: 'none', signal,
          maxTokens: Math.min(4096, Math.max(128, Number(args.maxTokens) || 2048)),
          skillContext: { selfId: meta.account, chatKey: meta.chatKey, extensionId: meta.extensionId } });
        if (signal.aborted) throw fail('BUILTIN_CANCELLED', '扩展任务已取消。');
        assertCurrent(meta);
        return response;
      } catch (caught) { error = caught; throw caught; }
      finally {
        busy.delete(key); pending.delete(controller);
        // Bill actual returned usage even when an account change invalidates the result.
        try { services.recordUsage?.({ ...meta, signal: undefined, usage: response?.usage, error, at: now() }); }
        catch { runtime.publish('error', { code: 'BUILTIN_USAGE_SAVE_FAILED', category: 'status', selfId: meta.account }); }
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const controller of pending) controller.abort();
      pending.clear(); listeners.clear();
      if (active === runtime) active = null;
    }
  };
  return runtime;
}
