import { randomUUID } from 'node:crypto';
import { errorCode } from './session-effects.js';

const secret = /(?:api.?key|access.?token|authorization|password|passwd|secret|cookie|credential|^token$|console.?token)/i;
export function redactToolRecord(value, depth = 0) {
  if (depth > 8) return '[嵌套内容已省略]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactToolRecord(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100)
    .map(([key, item]) => [key, secret.test(key) ? '[已隐藏]' : redactToolRecord(item, depth + 1)]));
  if (typeof value !== 'string') return value;
  try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') return JSON.stringify(redactToolRecord(parsed, depth + 1)); } catch { /* plain text */ }
  const safe = value.replace(/(?:data:[^\s"']+;base64,|base64:\/\/)[A-Za-z0-9+/=]+/g, '[媒体数据已省略]')
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret|cookie|token|x-console-token)["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi, '$1[已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@');
  return safe.length > 12000 ? safe.slice(0, 12000) + '\n[记录已截断]' : safe;
}

export function preserveToolExecutions(session) {
  if (!Array.isArray(session.toolExecutions)) session.toolExecutions = (session.messages || [])
    .filter(item => item.toolCall).map(({ toolCall }) => ({ ...redactToolRecord(toolCall), id: randomUUID(),
      status: toolCall.isError ? 'failed' : 'succeeded', legacy: true }));
  return session.toolExecutions;
}

export function interruptToolExecutions(session, code = 'SESSION_INTERRUPTED', message = '会话已结束，调用结果未确认') {
  for (const row of session.toolExecutions || []) if (row.status === 'running') {
    row.status = 'aborted'; row.isError = true; row.code = code; row.result = message;
    row.endedAt = Date.now(); row.durationMs = Math.max(0, row.endedAt - row.startedAt);
  }
}

// This audit never changes the tool result or retries an operation. In-flight
// cancellation is visible immediately; a late completion cannot rewrite it.
export async function recordToolExecution(ctx, name, args, operation, label = '') {
  if (!ctx.session) return operation();
  const rows = preserveToolExecutions(ctx.session);
  let parsed = args;
  try { if (typeof args === 'string') parsed = JSON.parse(args); } catch { /* keep invalid input for diagnosis */ }
  const row = { id: randomUUID(), callId: ctx.toolCallId || null, name, label,
    sequence: rows.length + 1, attempt: ctx.session.toolAttempt || 1, startedAt: Date.now(),
    status: 'running', args: redactToolRecord(parsed), result: '', code: null, isError: false };
  rows.push(row);
  const changed = () => { ctx.onToolUpdate?.(); ctx.emit?.('session-update', ctx.session.id); };
  const finish = result => {
    if (row.status !== 'running') return;
    const parts = Array.isArray(result?.content) ? result.content : [];
    const content = parts.length ? parts.filter(part => part.type === 'text').map(part => part.text || '').join('\n') : String(result?.content ?? '');
    const code = result?.code || errorCode(content);
    row.code = result?.isError && code !== 'AGENT_OPERATION_FAILED' ? code : null;
    row.isError = !!result?.isError;
    row.status = row.isError ? (/TIMEOUT|TIMEDOUT|DEADLINE/.test(row.code || '') || /超时|timed?\s*out/i.test(content) ? 'timeout' : 'failed') : 'succeeded';
    row.result = redactToolRecord(content);
    row.images = parts.filter(part => part.type === 'image_url').length;
    row.videos = parts.filter(part => part.type === 'video_url').length;
    row.endedAt = Date.now(); row.durationMs = Math.max(0, row.endedAt - row.startedAt);
    changed();
  };
  const abort = () => {
    if (row.status !== 'running') return;
    const reason = ctx.signal?.reason;
    finish({ isError: true, code: reason?.name === 'TimeoutError' ? 'TOOL_TIMEOUT' : 'TOOL_ABORTED', content: reason?.message || '调用已中断，结果未确认' });
    row.status = reason?.name === 'TimeoutError' ? 'timeout' : 'aborted'; changed();
  };
  changed();
  ctx.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (ctx.signal?.aborted) { abort(); ctx.signal.throwIfAborted(); }
    const result = await operation(); finish(result); return result;
  } catch (error) {
    finish({ isError: true, code: error?.code, content: error?.message || String(error) }); throw error;
  } finally { ctx.signal?.removeEventListener('abort', abort); }
}
