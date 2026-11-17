import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export const qqPattern = /^[1-9]\d{0,9}$/;
export const sourcePattern = /^(group|private):([1-9]\d{0,9})$/;
export const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const archiveLimit = 512 * 1024;

export function integer(value, fallback, min, max) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.trunc(value)))
    : fallback;
}

export function localDay(time, offset = 0) {
  const date = new Date(time);
  date.setDate(date.getDate() + offset);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map(value => String(value).padStart(2, '0')).join('-');
}

export function archiveFile(dataDir, feature, account, day, group) {
  if (!qqPattern.test(account) || !dayPattern.test(day) || (group !== undefined && !qqPattern.test(group))) {
    throw new Error('QQ 账号或档案日期无效。');
  }
  const dir = path.join(dataDir, 'builtins', feature, account);
  return path.join(dir, group ? `${group}-${day}.json.gz` : `${day}.json.gz`);
}

export function readArchive(file, validate) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('无法读取本地压缩档案。');
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size > archiveLimit) throw new Error();
    const bytes = Buffer.alloc(size);
    if (fs.readSync(fd, bytes, 0, size, 0) !== size) throw new Error();
    const value = JSON.parse(gunzipSync(bytes, { maxOutputLength: archiveLimit }).toString('utf8'));
    if (!validate(value)) throw new Error();
    return value;
  } catch {
    throw new Error('本地压缩档案损坏或格式无效。');
  } finally {
    fs.closeSync(fd);
  }
}

export function writeArchive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > archiveLimit) throw new Error();
    fs.writeFileSync(temp, gzipSync(json), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    throw new Error('无法保存本地压缩档案。');
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function boundedRows(store, key, limit, account, day) {
  const options = { limit };
  if (day) {
    // 先按日期限定范围，避免午夜后的消息挤掉昨日样本。
    const date = new Date(`${day}T00:00:00`);
    options.fromTs = date.getTime();
    options.beforeTs = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  }
  return store.recent(key, options).slice(-limit).filter(row =>
    row && !row.recalled && !row.isPoke && !row.forwardVersion && String(row.selfId) === account &&
    Number.isFinite(row.ts) && (!day || localDay(row.ts) === day) &&
    typeof row.text === 'string' && row.text.slice(0, 1024).trim() && !/^\s*\[合并转发/.test(row.text.slice(0, 24)) &&
    !/^\s*(?:\[[^\]\n]{1,20}\]\s*)+$/.test(row.text.slice(0, 1024)));
}

export function sourceList(store, kind) {
  return store.listChats().filter(key =>
    typeof key === 'string' && sourcePattern.test(key) && (!kind || key.startsWith(kind + ':')))
    .slice(-128);
}

export function sanitizedText(value, limit) {
  if (typeof value !== 'string') return '';
  return value.slice(0, limit).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

export function completionJson(result, maximumLength) {
  const text = result?.message?.content;
  if (typeof text !== 'string' || text.length > maximumLength || result.finishReason === 'length') {
    throw new Error('归档模型输出无效或超出长度限制。');
  }
  try {
    return JSON.parse(text.trim().replace(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i, '$1'));
  } catch {
    throw new Error('归档模型未返回有效 JSON。');
  }
}

export function startArchiveWorker({ runtime, tick, enabled, report, everyMs = 60_000, timer = globalThis }) {
  let job;
  let scheduled;
  let stopped = false;
  const current = () => {
    if (job && (!runtime.isCurrent(job.account) || !enabled())) job.controller.abort();
  };
  const run = () => {
    current();
    const account = runtime.account();
    if (stopped || job || !enabled() || !qqPattern.test(account) || !runtime.isCurrent(account)) return;
    const now = runtime.now();
    if (scheduled?.account === account && now < scheduled.after) return;
    scheduled = { account, after: now + everyMs };
    const controller = new AbortController();
    const captured = { account, controller };
    job = captured;
    Promise.resolve()
      .then(() => tick({ account, signal: controller.signal }))
      .catch(error => { if (!controller.signal.aborted) report(error); })
      .finally(() => { if (job === captured) job = undefined; });
  };
  const unsubscribe = runtime.subscribe('status', () => { current(); run(); });
  const handle = timer.setInterval(run, everyMs);
  handle?.unref?.();
  run();
  return () => {
    stopped = true;
    unsubscribe();
    timer.clearInterval(handle);
    job?.controller.abort();
  };
}
