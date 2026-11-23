// The official GPT-6 Chat Completions endpoint cannot execute function tools.
const histories = new WeakMap();

export function usesResponses(api) {
  return /^gpt-6(?:[.-]|$)/i.test(api.model) && URL.canParse(api.baseUrl) && new URL(api.baseUrl).hostname === 'api.openai.com';
}

export function assistantForHistory(message) {
  const entry = { role: 'assistant', content: message.content ?? null };
  if (message.tool_calls?.length) entry.tool_calls = message.tool_calls;
  if (typeof message.reasoning_content === 'string') entry.reasoning_content = message.reasoning_content;
  if (histories.has(message)) histories.set(entry, histories.get(message));
  return entry;
}

function inputContent(message) {
  if (!Array.isArray(message.content)) return message.content ?? '';
  return message.content.map(part => {
    if (part.type === 'text') return { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
    if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail || 'auto' };
    throw new Error('当前 Responses 输入不支持 ' + part.type);
  });
}

export function toResponsesRequest(body, api) {
  const input = [];
  for (const message of body.messages) {
    const previous = histories.get(message);
    if (previous && previous.base === api.baseUrl && previous.model === api.model && previous.key === api.apiKey) {
      input.push(...previous.items);
    } else if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content });
    } else {
      if (message.content || !message.tool_calls?.length) input.push({ role: message.role, content: inputContent(message) });
      for (const call of message.tool_calls || []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
  }
  const request = { model: body.model, input, store: false, include: ['reasoning.encrypted_content'] };
  if (body.max_completion_tokens) request.max_output_tokens = body.max_completion_tokens;
  if (body.reasoning_effort) request.reasoning = { effort: body.reasoning_effort };
  if (body.tools?.length) {
    request.tools = body.tools.map(tool => ({ type: 'function', ...tool.function, strict: tool.function.strict ?? false }));
    request.tool_choice = typeof body.tool_choice === 'object' ? { type: 'function', name: body.tool_choice.function.name } : body.tool_choice;
  }
  return request;
}

export function fromResponsesReply(data, api) {
  if (data.error || !['completed', 'incomplete'].includes(data.status) || !Array.isArray(data.output)) {
    throw new Error('Responses API 返回错误：' + (data.error?.message || data.status || '缺少 output'));
  }
  const message = { role: 'assistant', content: null };
  const calls = [];
  let text = '';
  for (const item of data.output) {
    if (item.type === 'message') {
      for (const part of item.content || []) {
        if (part.type === 'output_text') text += part.text;
        if (part.type === 'refusal') text += part.refusal;
      }
    } else if (item.type === 'function_call') {
      if (data.status !== 'completed' || !item.call_id || !item.name || typeof item.arguments !== 'string') throw new Error('Responses 工具调用不完整');
      calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    }
  }
  if (text) message.content = text;
  if (calls.length) message.tool_calls = calls;
  histories.set(message, { base: api.baseUrl, model: api.model, key: api.apiKey, items: data.output });
  const u = data.usage;
  const usage = u && { ...u, prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens, prompt_tokens_details: u.input_tokens_details, completion_tokens_details: u.output_tokens_details };
  const finish = data.status === 'incomplete' ? (data.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length') : calls.length ? 'tool_calls' : 'stop';
  return { model: data.model ?? api.model, usage, choices: [{ message, finish_reason: finish }] };
}
