import fs from 'node:fs';
import path from 'node:path';

function validSelection(value) {
  return value && Number.isInteger(value.pid) && value.pid > 0 && value.pid <= 0xffffffff
    && typeof value.startedAt === 'string' && /^[1-9]\d{16,18}$/.test(value.startedAt)
    && typeof value.account === 'string' && /^[1-9]\d{0,9}$/.test(value.account) && Number(value.account) <= 0xffffffff;
}

const retryDelays = [1000, 2000, 4000, 8000, 15000, 30000];
// 恢复连接时「宿主已驻留」不是终点：上一次运行注入的宿主会一直留到 QQ 退出，
// 这时清掉选择等于让用户每次开机都重新手动连一次。保留选择、放慢重试，等 QQ 重启后自动接上。
const terminalFailures = new Set(['INVALID_QQ_PID', 'INVALID_QQ_SELECTION', 'UNSUPPORTED_QQ',
  'NATIVE_PROCESS_CHANGED', 'NATIVE_ACCOUNT_CHANGED', 'HOST_ACCOUNT_CHANGED',
  'DISCONNECT_CURRENT_ACCOUNT_FIRST', 'CONTROLLER_CLOSED']);
const restartQqFailures = new Set(['HOST_ALREADY_PRESENT']);

export function createNativeResume(configFile, backend, { setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout } = {}) {
  const file = typeof configFile === 'string' && configFile ? path.resolve(configFile) + '.native-resume.json' : null;
  let pending;
  let revision = 0;
  let selected = null;
  let timer = null;
  let retry = 0;
  let closed = false;
  let closing;
  let onFailure;
  let failureReported = false;
  let established = false;

  function stopTimer() { if (timer) cancel(timer); timer = null; }
  function forget() {
    revision++; selected = null; retry = 0; established = false; stopTimer();
  }

  function clear() {
    forget();
    if (!file) return;
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  function save(selection) {
    if (!validSelection(selection)) return clear();
    selected = { pid: selection.pid, startedAt: selection.startedAt, account: selection.account };
    if (!file) return;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ pid: selection.pid, startedAt: selection.startedAt, account: selection.account }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* The file was renamed or could not be created. */ }
    }
  }

  function arm(delay, fn) {
    stopTimer();
    if (closed || !selected) return;
    const attempt = revision;
    timer = schedule(() => {
      timer = null;
      if (closed || revision !== attempt || !selected) return;
      return fn();
    }, delay);
    timer.unref?.();
  }

  function monitor() {
    if (closed || !selected || pending) return;
    const status = backend.snapshot();
    if (status.connected && status.receiveReady) arm(1000, monitor);
    else return resume();
  }

  function resume() {
    if (closed || !selected || pending) return pending;
    const attempt = revision, target = selected;
    const operation = backend.connect(target.pid, { startedAt: target.startedAt, account: target.account })
      .then(() => {
        if (closed || revision !== attempt) return;
        if (established) backend.recordRecovery?.();
        established = true;
        retry = 0; failureReported = false;
        arm(1000, monitor);
      })
      .catch(error => {
        if (closed || revision !== attempt) return;
        const terminal = terminalFailures.has(error?.code || error?.message);
        if (!failureReported || terminal) {
          failureReported = true;
          try { onFailure?.(); } catch { /* Diagnostics must not break recovery scheduling. */ }
        }
        if (restartQqFailures.has(error?.code || error?.message)) {
          // 只有退出并重开 QQ 才能清掉残留宿主；在此之前每 30 秒轻量重试一次，不丢选择。
          arm(30000, resume);
        } else if (terminal) {
          // Never adopt a replacement process/account or a host owned by somebody else.
          try { clear(); } catch { /* Monitoring is stopped even if the stale file cannot be removed. */ }
        } else {
          arm(retryDelays[Math.min(retry++, retryDelays.length - 1)], resume);
        }
      })
      .finally(() => { if (pending === operation) pending = null; });
    pending = operation;
    return operation;
  }

  return {
    start(reportFailure) {
      onFailure = reportFailure;
      if (closed || !file || pending || selected) return;
      let saved;
      try {
        if (fs.statSync(file).size > 512) return;
        saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch { return; }
      if (!validSelection(saved)) return;
      selected = { pid: saved.pid, startedAt: saved.startedAt, account: saved.account };
      return resume();
    },
    async select(pid) {
      if (closed) throw new Error('NATIVE_CONNECT_CANCELLED');
      forget();
      const attempt = revision;
      if (pending) await pending.catch(() => {});
      if (closed || revision !== attempt) throw new Error('NATIVE_CONNECT_CANCELLED');
      const operation = backend.connect(pid);
      pending = operation;
      try {
        const result = await operation;
        if (closed || revision !== attempt) throw new Error('NATIVE_CONNECT_CANCELLED');
        save(backend.controller.resumeSelection());
        established = true;
        failureReported = false;
        arm(1000, monitor);
        return result;
      } finally { if (pending === operation) pending = null; }
    },
    async disconnect() {
      const operation = pending;
      try { clear(); }
      finally {
        try { await backend.disconnect(); }
        finally { await operation?.catch(() => {}); }
      }
    },
    close() {
      if (closing) return closing;
      closed = true; forget();
      const operation = pending;
      closing = (async () => {
        try { await backend.disconnect(); }
        finally { await operation?.catch(() => {}); }
      })();
      return closing;
    }
  };
}
