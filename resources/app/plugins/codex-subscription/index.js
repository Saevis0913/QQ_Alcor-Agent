import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';
import { withCodex } from './codex.js';
import { ChatConnections } from './chat-connections.js';
import { archiveFiles } from './artifacts.js';
import { WorkQueue } from './work-mode.js';
import { CHAT_SCHEMA, WORK_INSTRUCTIONS, WORK_SCHEMA, chatRequest, chatResponse, pickChatModel, quotaText } from './policy.js';
import { subscriptionState } from './runtime-state.js';

const root = path.join(DATA_DIR, 'codex-subscription');
const artifactRoot = path.join(root, 'artifacts');
const choiceFile = path.join(root, 'choices.json');
const cwd = path.join(root, 'session');
const chatMode = '订阅聊天';
const workMode = '订阅工作';
let api;

function configuredMode() {
  const value = api?.config().mode;
  return value === chatMode ? 'chat' : value === workMode ? 'work' : null;
}

// 留空=自动找本机安装：Codex CLI 装在 %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe，
// 登录目录默认是 %USERPROFILE%\.codex。用户不必先知道这两个路径才能用。
function detectExecutable() {
  const root = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  if (!root || !existsSync(root)) return '';
  let best = '';
  let bestTime = -1;
  for (const dir of readdirSync(root)) {
    const exe = path.join(root, dir, 'codex.exe');
    try {
      const at = statSync(exe).mtimeMs;
      if (at > bestTime) { best = exe; bestTime = at; }
    } catch { /* 不是这一层安装 */ }
  }
  return best;
}

function detectHome() {
  const home = path.join(process.env.USERPROFILE || '', '.codex');
  return existsSync(home) ? home : '';
}

function settings() {
  const config = api.config();
  const executable = String(config.codexExecutable || '').trim() || detectExecutable();
  const home = String(config.codexData || '').trim() || detectHome();
  return { executable, home, cwd };
}

function checkDependency() {
  const { executable, home } = settings();
  if (!path.isAbsolute(executable) || !existsSync(executable)) return '没有找到本机 Codex 程序：先安装并登录 Codex CLI，或在插件设置里填写 codex.exe 的完整路径。';
  if (!path.isAbsolute(home) || !existsSync(home)) return '没有找到 Codex 登录目录：先在命令行完成一次 codex 登录，或在插件设置里填写 .codex 目录。';
  return '';
}

function reset() {
  const { lifetime, work, chat } = subscriptionState;
  subscriptionState.lifetime = new AbortController();
  subscriptionState.work = undefined;
  subscriptionState.listCache = undefined;
  subscriptionState.chat = undefined;
  const reason = new DOMException('Alcor 订阅模式已停用或切换。', 'AbortError');
  lifetime.abort(reason);
  chat?.connections.close(reason);
  work?.stop();
}

function ensureMode() {
  const mode = configuredMode();
  if (mode !== subscriptionState.activeMode) {
    subscriptionState.activeMode = mode;
    reset();
  }
  return mode;
}

const timedSignal = (signal, ms) =>
  AbortSignal.any([subscriptionState.lifetime.signal, AbortSignal.timeout(ms), ...(signal ? [signal] : [])]);

function connect(signal, ms, operation) {
  const error = checkDependency();
  if (error) throw new Error(error);
  return withCodex(settings(), timedSignal(signal, ms), operation);
}

async function modelCatalog(signal, connection) {
  const { executable, home } = settings();
  const key = JSON.stringify([executable, home]);
  const { listCache, lifetime } = subscriptionState;
  if (listCache?.key === key && listCache.expires > Date.now()) return listCache.models;
  const models = connection ? await connection.catalog() : await connect(signal, 30_000, server => server.catalog());
  lifetime.signal.throwIfAborted();
  subscriptionState.listCache = { key, models, expires:Date.now() + 30_000 };
  return models;
}

function readChoices() {
  try {
    const contents = JSON.parse(readFileSync(choiceFile, 'utf8'));
    if (!contents || typeof contents !== 'object' || Array.isArray(contents)) throw new Error();
    return contents;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('工作模式的模型选择记录无法读取。');
  }
}

function saveChoice(key, value) {
  mkdirSync(root, { recursive:true });
  const temporary = path.join(root, randomUUID() + '.choice.tmp');
  try {
    writeFileSync(temporary, JSON.stringify({ ...readChoices(), [key]:value }), { encoding:'utf8', flag:'wx' });
    renameSync(temporary, choiceFile);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function workQueue() {
  subscriptionState.work ||= new WorkQueue({
    catalog:modelCatalog,
    async quota(signal) {
      return connect(signal, 25_000, async (server, account) => {
        const limits = await server.request('account/rateLimits/read').catch(() => null);
        return quotaText(account.plan, limits);
      }).catch(error => {
        if (signal.aborted) throw error;
        api.warn('工作确认时暂时无法查询 Codex 额度。');
        return '订阅额度暂不可用';
      });
    },
    async run(selection, request, signal, beforeTurn) {
      if (configuredMode() !== 'work') throw new Error('工作模式已切换。');
      const text = await connect(signal, 5 * 60_000, server => server.turn({
        ...selection, cwd, instructions:WORK_INSTRUCTIONS,
        input:[{ type:'text', text:request, text_elements:[] }], schema:WORK_SCHEMA, beforeTurn
      }));
      let result;
      try { result = JSON.parse(text); } catch { throw new Error('Codex 未返回可解析的工作产物。'); }
      if (typeof result?.summary !== 'string' || !Array.isArray(result.files)) throw new Error('Codex 工作产物格式无效。');
      return result;
    },
    async archive(files, signal) {
      if (configuredMode() !== 'work') throw new Error('工作模式已切换。');
      const out = await archiveFiles(artifactRoot, files, timedSignal(signal, 40_000));
      if (out) api.log('工作产物已保存 %s', out);
      return out && path.basename(out);
    },
    getChoice:key => readChoices()[key],
    saveChoice,
    onError:error => api.warn(error.message)
  });
  return subscriptionState.work;
}

function requireChatScope(request) {
  if (configuredMode() !== 'chat' || !request.scopeValid()) {
    throw new DOMException('订阅聊天会话已失效。', 'AbortError');
  }
}

function chatConnections() {
  const error = checkDependency();
  if (error) throw new Error(error);
  const options = settings();
  const key = JSON.stringify([options.executable, options.home]);
  const previous = subscriptionState.chat;
  if (previous?.key !== key) {
    previous?.connections.close(new DOMException('本机 Codex 连接设置已变化。', 'AbortError'));
    subscriptionState.chat = { key, connections:new ChatConnections(options) };
  }
  return subscriptionState.chat.connections;
}

async function completeChat(request) {
  requireChatScope(request);
  const config = api.config();
  const {instructions, input} = chatRequest(request);
  const {selection, text} = await chatConnections().run(timedSignal(request.signal, 150_000), async server => {
    const models = await modelCatalog(request.signal, server);
    const admin = request.isAdmin();
    const selection = pickChatModel(models, admin, config.chatModel, config.chatEffort);
    requireChatScope(request);
    const text = await server.turn({
      ...selection, cwd, instructions, input, schema:CHAT_SCHEMA, releaseThread:true,
      beforeTurn() {
        requireChatScope(request);
        if (admin && !request.isAdmin()) {
          throw new DOMException('订阅聊天的管理员权限已变化。', 'AbortError');
        }
      }
    });
    return {selection, text};
  });
  requireChatScope(request);
  const message = chatResponse(text, request.tools);
  return { message, raw:{ model:selection.model }, model:selection.model, usage:null };
}

export function setup(skillApi) {
  api = skillApi;
}

export function available() {
  const reason = checkDependency();
  return reason ? { ok:false, reason } : true;
}

export function activate() { ensureMode(); }

export function deactivate({ reason } = {}) {
  if (reason === 'reload') return;
  subscriptionState.activeMode = undefined;
  reset();
}

export function dispose() { deactivate(); }

export const providers = {
  'reply.subscription': () => {
    const mode = ensureMode();
    if (mode === 'chat') return { mode, complete:completeChat };
    if (mode === 'work') {
      return { mode, receive:ctx => workQueue().receive({
        ...ctx, scopeValid:() => configuredMode() === 'work' && ctx.scopeValid()
      }) };
    }
    return null;
  }
};
