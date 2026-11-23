// Convert one OpenAI-compatible SSE completion into the same shape as a JSON reply.
export async function readChatStream(response) {
  const message = { role: 'assistant', content: null };
  const calls = new Map();
  let model, usage, finishReason, done = false;
  const consume = (data) => {
    if (data === '[DONE]') { done = true; return; }
    let chunk;
    try { chunk = JSON.parse(data); }
    catch { throw new Error('模型 SSE 流包含无效 JSON'); }
    if (chunk.error) throw new Error('模型 SSE 流错误：' + (chunk.error.message || JSON.stringify(chunk.error)));
    model ??= chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.find(c => (c.index ?? 0) === 0);
    if (!choice) return; // usage-only or heartbeat
    const delta = choice.delta ?? {};
    for (const key of ['content', 'reasoning_content', 'reasoning', 'refusal']) {
      if (typeof delta[key] === 'string') message[key] = (message[key] || '') + delta[key];
    }
    for (const part of delta.tool_calls || []) {
      if (!Number.isInteger(part.index) || part.index < 0) throw new Error('模型 SSE 流缺少工具序号');
      const call = calls.get(part.index) || { type: 'function', function: { name: '', arguments: '' } };
      if (part.id) call.id = part.id;
      if (part.extra_content) call.extra_content = part.extra_content;
      call.function.name += part.function?.name || '';
      call.function.arguments += part.function?.arguments || '';
      calls.set(part.index, call);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  const decoder = new TextDecoder();
  let pending = '', data = [];
  const line = (value) => {
    if (!value) {
      if (data.length) consume(data.join('\n'));
      data = [];
    } else if (value === 'data' || value.startsWith('data:')) {
      data.push(value.slice(5).replace(/^ /, ''));
    }
  };
  for await (const bytes of response.body) {
    pending += decoder.decode(bytes, { stream: true });
    // A trailing CR may be the first byte of the next CRLF.
    const lines = pending.split(/\r\n|\n|\r(?!$)/);
    pending = lines.pop();
    for (const value of lines) { line(value); if (done) break; }
    if (done) break;
  }
  if (!done) {
    pending += decoder.decode();
    for (const value of pending.split(/\r\n|\n|\r/)) line(value);
    line('');
  }
  if (!finishReason) throw new Error('模型 SSE 流在完成标记前中断');
  if (calls.size) {
    message.tool_calls = [...calls].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (finishReason === 'length' || message.tool_calls.some(call => !call.id || !call.function.name)) {
      throw new Error('模型 SSE 流返回了不完整的工具调用');
    }
    for (const call of message.tool_calls) {
      try { JSON.parse(call.function.arguments); }
      catch { throw new Error('模型 SSE 流返回了不完整的工具参数'); }
    }
  }
  return { model, usage, choices: [{ index: 0, message, finish_reason: finishReason }] };
}
