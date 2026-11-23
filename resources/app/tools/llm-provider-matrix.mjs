// Offline audit of the settings probe and the Agent's Chat Completions client.
// Run with node resources/app/tools/llm-provider-matrix.mjs from the repo root.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const directory = await mkdtemp(path.join(tmpdir(), 'alcor-model-matrix-'));
process.env.ALCOR_AGENT_DATA_DIR = directory;
const directFetch = globalThis.fetch;
const key = 'offline-fixture-only';
const callId = 'Ab12Cd345';
const signature = 'c2ltdWxhdGVk';
const reasoning = 'fixture reasoning';
const prompt = [{ role: 'system', content: 'Respond briefly.' }, { role: 'user', content: 'Say pong.' }];
const toolPrompt = [...prompt.slice(0, 1), { role: 'user', content: 'List my reminders.' }];
const usage = { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 };
const openai = 'https://api.openai.com/v1';
const claude = 'https://api.anthropic.com/v1';
const qwen = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const kimi = 'https://api.moonshot.cn/v1';

// Representative wire formats, not a live catalog or a provider emulator.
// Reference contracts for the restrictions:
// https://platform.kimi.com/docs/api/models-overview
// https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk
// https://help.aliyun.com/en/model-studio/stream
// https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
const profiles = [
  { model: 'gpt-4.1', base: openai },
  { model: 'deepseek-v4-flash', base: 'https://api.deepseek.com/v1', replayReasoning: true },
  { model: 'qwen-plus', base: qwen },
  { model: 'glm-4.6', base: 'https://open.bigmodel.cn/api/paas/v4' },
  { model: 'gemini-3-flash-preview', base: 'https://generativelanguage.googleapis.com/v1beta/openai', replaySignature: true },
  { model: 'claude-sonnet-4-5', base: claude },
  { model: 'mistral-large-latest', base: 'https://api.mistral.ai/v1' },
  { model: 'grok-4', base: 'https://api.x.ai/v1' },
  { model: 'kimi-k3.1-pro', base: kimi, fixedTemp: true, replayReasoning: true },
  { model: 'claude-opus-4-7', base: claude, fixedTemp: true },
  { model: 'qwq-32b', base: qwen, streamOnly: true },
  { model: 'o3', base: openai, modernLimit: true },
  ...['gpt-6.2-astra', 'gpt-6.2-sol'].map(model => ({ model, base: openai, responses: true })),
  ...['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map(model => ({ model, base: claude, fixedTemp: true })),
  ...['gemini-4-carbon', 'gemini-4-neon', 'gemini-4-hydrogen'].map(model => ({ model, base: 'https://generativelanguage.googleapis.com/v1beta/openai', replaySignature: true })),
  { model: 'qwen4-max', base: qwen },
  { model: 'deepseek-flash', base: 'https://api.deepseek.com/v1', replayReasoning: true },
  { model: 'deepseek-v4-pro', base: 'https://api.deepseek.com/v1', replayReasoning: true },
  { model: 'glm-5.3', base: 'https://open.bigmodel.cn/api/paas/v4', replayReasoning: true },
  { model: 'grok-4.7', base: 'https://api.x.ai/v1' },
  { model: 'mistral-large-4', base: 'https://api.mistral.ai/v1' },
  { model: 'kimi-k3.1-pro-highspeed', base: kimi, fixedTemp: true, replayReasoning: true }
];

let active;
let fixtureError;
let requestCount = 0;
let fault = '';
let checkingCap = false;
let expectedWire;

function streamReply(res, message, finish) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  const frames = [': heartbeat'];
  const frame = (delta, end = null) => frames.push('data: ' + JSON.stringify({ model: active.model, choices: [{ index: 0, delta, finish_reason: end }] }));
  frame({ role: 'assistant', reasoning_content: '思考' });
  if (message.tool_calls) {
    const call = message.tool_calls[0];
    frame({ tool_calls: [{ index: 0, ...call, function: { name: call.function.name, arguments: '{' } }] });
    frame({ tool_calls: [{ index: 0, function: { arguments: '}' } }] });
  } else {
    frame({ content: message.content.slice(0, 1) });
    frame({ content: message.content.slice(1) });
  }
  if (fault !== 'truncated-stream') {
    if (fault === 'malformed-stream') frames.push('data: {');
    if (fault === 'stream-error') frames.push('data: {"error":{"message":"fixture-stream failure"}}');
    frame({}, finish);
    frames.push('data: ' + JSON.stringify({ choices: [], usage }), 'data: [DONE]');
  }
  const bytes = Buffer.from(frames.join('\r\n\r\n') + '\r\n\r\n');
  const split = bytes.indexOf(Buffer.from('思')) + 1;
  res.write(bytes.subarray(0, split));
  setImmediate(() => res.end(bytes.subarray(split)));
}
const server = http.createServer(async (req, res) => {
  const send = (status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const reject = (status, reason) => send(status, { error: { message: reason } });
  try {
    requestCount++;
    assert.equal(req.headers.authorization, 'Bearer ' + key);
    const prefix = new URL(active.base).pathname.replace(/\/$/, '');
    if (fault === 'html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html>gateway login</html>');
    }
    if (req.url === prefix + '/models' && req.method === 'GET') {
      if (fault === 'invalid-catalog') return send(200, { data: [{ object: 'model' }] });
      if (fault === 'missing-catalog') return reject(404, 'catalog unavailable');
      return send(200, { object: 'list', data: [{ id: active.model, object: 'model' }] });
    }
    const expectedChatPath = prefix + '/chat/completions';
    assert.equal(req.method, 'POST');
    assert.match(req.headers['content-type'], /application\/json/);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(body.model, active.model);
    for (const [key, expected] of Object.entries(expectedWire || {})) assert.deepEqual(body[key], expected, active.model + ' ' + key);
    if (active.responses) {
      if (req.url !== prefix + '/responses') return reject(400, 'requires Responses adapter');
      assert.equal(body.temperature, undefined);
      assert.equal(body.store, false);
      assert.ok(body.include.includes('reasoning.encrypted_content'));
      assert.ok(body.input.some(m => m.role === 'user'));
      if (checkingCap) assert.equal(body.max_output_tokens, 128);
      const reasoningItem = { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'encrypted-fixture' };
      const probeTool = body.tools?.some(t => t.name === 'alcor_probe');
      const call = { type: 'function_call', id: 'fc_fixture', call_id: callId, name: probeTool ? 'alcor_probe' : 'list_reminders', arguments: '{}' };
      const usage = { input_tokens: 11, output_tokens: 5, total_tokens: 16 };
      let content = 'pong';
      if (body.tools) {
        assert.ok(body.tools.some(t => t.type === 'function' && t.name === call.name && t.parameters));
        const output = body.input.find(m => m.type === 'function_call_output');
        if (!output) return send(200, { status: 'completed', model: active.model, output: [reasoningItem, call], usage });
        assert.equal(output.call_id, callId);
        if (probeTool) assert.match(output.output, /^alcor-[a-f0-9-]+$/);
        else assert.equal(output.output, '[]');
        assert.deepEqual(body.input.slice(-3, -1), [reasoningItem, call]);
        content = probeTool ? output.output : 'No reminders.';
      }
      return send(200, { status: 'completed', model: active.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }], usage });
    }
    assert.equal(req.url, expectedChatPath);
    assert.ok(body.messages.some(m => m.role === 'user' && typeof m.content === 'string'));
    if (fault === 'error-envelope') return reject(200, 'simulated upstream error');
    if (fault === 'denied') return reject(403, 'model access denied');
    if (active.fixedTemp && body.temperature !== undefined && body.temperature !== 1) return reject(400, 'requires temperature 1');
    if (active.streamOnly && !body.stream) return reject(400, 'requires streaming');
    if (active.modernLimit && 'max_tokens' in body) return reject(400, 'requires max_completion_tokens');
    if (active.modernLimit && body.temperature !== undefined && body.temperature !== 1) return reject(400, 'unsupported sampling setting');
    if (checkingCap) assert.equal(body[active.modernLimit ? 'max_completion_tokens' : 'max_tokens'], 128);
    const reply = (message, finish = 'stop') => active.streamOnly ? streamReply(res, message, finish) : send(200, {
      object: 'chat.completion', model: active.model, usage,
      choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', ...message } }]
    });
    if (fault === 'budget') return reply({ content: '', reasoning_content: reasoning }, 'length');
    if (!body.tools) return reply({ content: 'pong' });
    const probeTool = body.tools.some(t => t.function.name === 'alcor_probe');
    assert.deepEqual(body.tools.map(t => t.function.name).sort(), probeTool ? ['alcor_probe'] : ['finish', 'list_reminders', 'send_message']);
    if (fault === 'no-tools') return reject(400, 'tools unsupported');
    for (const tool of body.tools) {
      assert.equal(tool.type, 'function');
      assert.equal(tool.function.parameters.type, 'object');
    }
    assert.equal(body.tool_choice ?? 'auto', 'auto');
    if (body.messages.at(-1).role === 'tool') {
      const assistant = body.messages.at(-2);
      assert.equal(assistant.role, 'assistant');
      const call = assistant.tool_calls[0];
      assert.equal(call.id, callId);
      if (active.replayReasoning) assert.equal(assistant.reasoning_content, reasoning);
      if (active.replaySignature) assert.equal(call.extra_content.google.thought_signature, signature);
      assert.equal(body.messages.at(-1).tool_call_id, callId);
      const output = body.messages.at(-1).content;
      if (probeTool) assert.match(output, /^alcor-[a-f0-9-]+$/);
      else assert.equal(output, '[]');
      return reply({ content: probeTool ? (fault === 'ignores-tool' ? 'irrelevant' : output) : 'No reminders.' });
    }
    const call = { id: callId, type: 'function', function: { name: probeTool ? 'alcor_probe' : 'list_reminders', arguments: '{}' } };
    if (active.replaySignature) call.extra_content = { google: { thought_signature: signature } };
    return reply({ content: null, tool_calls: [call], ...(active.replayReasoning ? { reasoning_content: reasoning } : {}) }, 'tool_calls');
  } catch (error) {
    fixtureError = error;
    reject(500, 'fixture assertion failed');
  }
});

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const local = 'http://127.0.0.1:' + server.address().port;
  // Retain the original host for Alcor's dialect selection. All HTTP goes to loopback.
  globalThis.fetch = (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, new URL(active.base).origin);
    return directFetch(local + url.pathname + url.search, { ...init, redirect: 'error' });
  };
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
  function select(profile, settings = {}) {
    active = profile;
    const cfg = structuredClone(DEFAULT_CONFIG);
    Object.assign(cfg.api, { baseUrl: profile.base, provider: 'fixture', model: profile.model }, profile.settings, settings);
    cfg.dshProviderKeys = { fixture: key };
    setRuntimeConfig(cfg);
  }
  select(profiles[0]);
  const { chatCompletionWithRetry, listModels } = await import('../src/llm.js');
  const { testProvider, probeApiKey, setProviderKey, fetchModelsFrom } = await import('../src/providers.js');
  const { updateConfig, getConfig } = await import('../src/config.js');
  const { resolveApiKey } = await import('../src/llm.js');
  const { createRoutes } = await import('../src/routes.js');
  const { buildToolDefs, toOpenAiTools } = await import('../src/tools.js');
  const tools = toOpenAiTools(buildToolDefs().filter(d => ['finish', 'list_reminders', 'send_message'].includes(d.id)));
  const routes = createRoutes({ readBody: async req => req });
  const runRoute = (pattern, body) => routes.find(r => r.method === 'POST' && r.pattern === pattern).handler({
    req: body, json: (_res, status, payload) => {
      assert.equal(status, 200);
      return payload;
    }
  });
  const ask = (args) => chatCompletionWithRetry(args, 0);
  const probe = async () => (await runRoute('/api/providers/test-chat', { baseUrl: active.base, model: active.model })).result;
  const catalog = () => testProvider({ baseURL: active.base, apiKey: key });

  // Return only modeled rejections as compatibility results. Unexpected errors fail the run.
  async function observe(fn) {
    try {
      await fn();
      return 'OK';
    } catch (error) {
      if (fixtureError) throw fixtureError;
      const reason = /requires temperature 1|requires streaming|requires max_completion_tokens|unsupported sampling setting|requires Responses adapter/.exec(error.message);
      if (!reason) throw error;
      return reason[0];
    }
  }
  async function checkProfile(profile, settings, label) {
    select(profile, settings);
    const ping = await observe(async () => {
      const r = await probe();
      if (!r.ok) throw new Error(r.note);
      assert.match(r.note, /pong/);
    });
    const activePing = await observe(async () => {
      const r = await runRoute('/api/test/api');
      if (!r.ok) throw new Error(r.error);
      assert.equal(r.reply, 'pong');
    });
    const text = await observe(async () => {
      const r = await ask({ messages: prompt });
      assert.equal(r.message.content, 'pong');
      assert.equal(r.usage.total_tokens, usage.total_tokens);
    });
    const tool = await observe(async () => {
      const first = await ask({ messages: toolPrompt, tools });
      assert.equal(first.finishReason, 'tool_calls');
      const call = first.message.tool_calls[0];
      assert.equal(call.function.name, 'list_reminders');
      assert.deepEqual(JSON.parse(call.function.arguments), {});
      const result = { role: 'tool', tool_call_id: call.id, name: call.function.name, content: '[]' };
      const last = await ask({ messages: [...toolPrompt, first.message, result], tools });
      assert.equal(last.message.content, 'No reminders.');
      assert.equal(last.finishReason, 'stop');
    });
    const capped = await observe(async () => {
      checkingCap = true;
      try {
        const r = await ask({ messages: prompt, maxTokens: 128 });
        assert.equal(r.message.content, 'pong');
      } finally { checkingCap = false; }
    });
    return { model: label || profile.model, ping, activePing, text, tool, capped };
  }
  const rows = [];
  for (const profile of profiles) rows.push(await checkProfile(profile));
  // Each profile runs with the shipping defaults.
  console.table(rows);

  // Model listing, a genuine chat reply and a settings green light are separate observations.
  select(profiles[0]);
  assert.deepEqual(await listModels(), [{ id: active.model }]);
  assert.equal((await catalog()).modelCount, 1);
  const gateway = [];
  for (fault of ['html', 'error-envelope', 'budget', 'denied', 'missing-catalog']) {
    const endpoint = await catalog();
    const ping = await probe();
    let real;
    try {
      const r = await ask({ messages: prompt });
      real = r.message.content || 'empty (' + r.finishReason + ')';
    } catch (error) {
      if (fixtureError) throw fixtureError;
      if (!/JSON|choices|HTTP 403|simulated upstream|length|正文/.test(error.message)) throw error;
      real = /HTTP 403/.test(error.message) ? 'HTTP 403' : 'invalid response';
    }
    gateway.push({ fixture: fault, providerOK: endpoint.ok, probeOK: ping.ok, chat: real });
  }
  console.table(gateway);
  for (const {model, ...stages} of rows) assert.ok(Object.values(stages).every(x => x === 'OK'), model + ' ' + JSON.stringify(stages));
  for (const row of gateway) {
    assert.equal(row.probeOK, row.chat === 'pong', row.fixture);
    assert.equal(row.providerOK, !['html', 'missing-catalog'].includes(row.fixture), row.fixture);
  }
  fault = 'invalid-catalog';
  await assert.rejects(listModels(), /模型目录/);
  await assert.rejects(fetchModelsFrom(active.base, key), /模型目录/);
  assert.equal((await catalog()).ok, false);
  fault = 'no-tools';
  const textOnly = await probe();
  assert.equal(textOnly.ok, false);
  assert.equal(textOnly.textOK, true);
  assert.equal(textOnly.toolsOK, false);
  select(profiles.find(p => p.streamOnly));
  for (fault of ['truncated-stream', 'stream-error', 'malformed-stream']) {
    await assert.rejects(ask({ messages: prompt }), /流|SSE|fixture-stream/);
  }
  fault = '';
  for (const [model, settings, wire] of [
    ['o3', {thinkingEffort: 'off'}, {reasoning_effort: 'low', temperature: undefined}],
    ['kimi-k3.1-pro', {thinkingEffort: 'ultra'}, {reasoning_effort: 'max', thinking: undefined, temperature: undefined}],
    ['glm-5.3', {thinkingEffort: 'off'}, {reasoning_effort: 'low', thinking: undefined}],
    ['qwen4-max', {thinkingEffort: 'off'}, {reasoning_effort: 'none', enable_thinking: undefined}],
    ['qwen4-max', {thinkingEffort: 'high', thinkingBudget: 2048}, {thinking_budget: 2048, reasoning_effort: undefined}],
    ['gemini-4-neon', {thinkingEffort: 'max'}, {reasoning_effort: 'xhigh', extra_body: undefined}],
    ['gemini-4-carbon', {thinkingEffort: 'off'}, {reasoning_effort: 'low'}],
    ['gpt-6.2-astra', {thinkingEffort: 'high'}, {reasoning: {effort: 'high'}, temperature: undefined}],
    ['claude-opus-4-7', {thinkingEffort: 'high'}, {thinking: {type: 'enabled', budget_tokens: 1024}, temperature: undefined}],
    ['deepseek-flash', {thinkingEffort: 'max'}, {thinking: {type: 'enabled'}, reasoning_effort: 'max'}],
    ['grok-4.7', {thinkingEffort: 'high'}, {reasoning_effort: 'high'}]
  ]) {
    select(profiles.find(p => p.model === model), settings);
    expectedWire = wire;
    await ask({messages: prompt});
  }
  expectedWire = undefined;
  select(profiles[0]);
  fault = 'ignores-tool';
  assert.equal((await probe()).toolsOK, false);
  fault = '';
  const cfg = getConfig();
  cfg.providers = [{ id: 'fixture', baseURL: openai }, { id: 'other', baseURL: kimi }];
  cfg.api.apiKey = 'legacy-fixture';
  cfg.dshProviderKeys.other = 'saved-other-fixture';
  assert.equal(probeApiKey({baseUrl: kimi, providerId: 'other'}), 'saved-other-fixture');
  assert.equal(probeApiKey({baseUrl: 'https://unconfigured.invalid/v1', providerId: 'fixture'}), '');
  updateConfig({api: {baseUrl: kimi, model: 'kimi-k3.1-pro', provider: 'other', apiKey: 'edited-fixture'}});
  assert.equal(resolveApiKey(getConfig()), 'edited-fixture');
  setProviderKey('other', '');
  assert.equal(resolveApiKey(getConfig()), '');
  assert.equal(probeApiKey({baseUrl: kimi, providerId: 'other'}), '');
  if (fixtureError) throw fixtureError;
  console.log('Node ' + process.version + ' | loopback HTTP requests: ' + requestCount);
} finally {
  globalThis.fetch = directFetch;
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
