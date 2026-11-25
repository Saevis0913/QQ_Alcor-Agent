import { execFile, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const disabledFeatures = [
  'shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'computer_use',
  'browser_use', 'in_app_browser', 'memories', 'multi_agent', 'multi_agent_v2', 'view_image'
];
const clientInfo = { name:'alcor_subscription', title:'Alcor Subscription', version:'1.0.2' };

export function codexEnvironment(home) {
  const env = { ...process.env, CODEX_HOME:home };
  for (const key of Object.keys(env)) {
    if (/^(?:OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY|CODEX_AUTH_JSON)$/i.test(key)) delete env[key];
  }
  return env;
}

async function startupArgs(executable, options) {
  let servers;
  try {
    const response = await executeFile(executable, ['mcp', 'list', '--json'],
      { ...options, timeout:12_000, maxBuffer:4 * 1024 * 1024 });
    servers = JSON.parse(response.stdout);
  } catch {
    options.signal?.throwIfAborted();
    throw new Error('无法读取本机 Codex 的工具设置，请确认 Codex 程序路径和版本。');
  }
  if (!Array.isArray(servers) || servers.some(server => !/^[A-Za-z0-9_-]+$/.test(server.name || '')
      || !['stdio', 'streamable_http'].includes(server.transport?.type))) {
    throw new Error('本机 Codex 返回的工具设置格式不受支持。');
  }
  const args = ['app-server', '--listen', 'stdio://', '-c', 'forced_login_method="chatgpt"',
    '-c', 'model_provider="openai"', '-c', 'web_search="disabled"'];
  for (const feature of disabledFeatures) args.push('--disable', feature);
  for (const { name, transport } of servers) {
    const prefix = 'mcp_servers.' + name;
    // The CLI validates each override layer before merging it with the saved config.
    const endpoint = transport.type === 'stdio' ? '.command="alcor-mcp-disabled"' : '.url="http://127.0.0.1:1"';
    args.push('-c', prefix + '.enabled=false', '-c', prefix + endpoint);
  }
  return args;
}

export class CodexConnection {
  #pending = new Map();
  #id = 0;
  #closed = null;
  #turn = null;
  #signedIn = false;

  constructor(child) {
    this.child = child;
    child.stderr.resume();
    child.stdin.on('error', () => this.close(new Error('本机 Codex 的通信管道已关闭。')));
    child.on('error', () => this.close(new Error('本机 Codex 启动失败。')));
    child.on('exit', () => this.close(new Error('本机 Codex 已退出。')));
    this.reader = createInterface({ input:child.stdout, crlfDelay:Infinity });
    this.reader.on('line', line => this.#read(line));
  }

  get closed() {
    return Boolean(this.#closed);
  }

  async scoped(signal, operation) {
    signal?.throwIfAborted();
    if (this.#closed) throw this.#closed;
    const abort = () => this.close(signal.reason);
    signal?.addEventListener('abort', abort, { once:true });
    try {
      const result = await operation(this);
      signal?.throwIfAborted();
      return result;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  #send(message) {
    if (this.#closed) throw this.#closed;
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  #read(line) {
    if (this.#closed) return;
    if (line.length > 8_000_000) {
      this.close(new Error('订阅服务返回的数据过大。'));
      return;
    }
    let packet;
    try { packet = JSON.parse(line); } catch { return; }
    if (!packet || typeof packet !== 'object') return;
    if (packet.method && packet.id !== undefined) {
      this.#send({ id:packet.id, error:{ code:-32601, message:'Tool or approval request is not supported in Alcor.' } });
      return;
    }
    if (this.#signedIn && packet.method === 'account/updated' &&
        Object.hasOwn(packet.params || {}, 'authMode') && packet.params.authMode !== 'chatgpt') {
      this.close(new Error('本机 Codex 已退出 ChatGPT 登录。'));
      return;
    }
    const pending = this.#pending.get(packet.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(packet.id);
      if (packet.error) pending.reject(new Error('Codex ' + pending.method + ' 返回错误（' + Number(packet.error.code) + '）。'));
      else pending.resolve(packet.result);
      return;
    }
    const turn = this.#turn;
    const params = packet.params;
    if (!turn || params?.threadId !== turn.threadId) return;
    if (packet.method === 'item/completed' && params.item?.type === 'agentMessage' && typeof params.item.text === 'string') {
      if (params.item.phase !== 'commentary') turn.text = params.item.text;
    }
    if (packet.method === 'turn/completed') {
      if (params.turn?.status === 'completed' && turn.text) turn.resolve(turn.text);
      else turn.reject(new Error('Codex 未完成本次请求，请检查账号额度和模型权限。'));
    }
  }

  request(method, params, timeoutMs = 25_000) {
    if (this.#closed) return Promise.reject(this.#closed);
    return new Promise((resolve, reject) => {
      const id = ++this.#id;
      const timer = setTimeout(() => this.close(new Error('本机 Codex ' + method + ' 响应超时。')), timeoutMs);
      timer.unref();
      this.#pending.set(id, { method, timer, resolve, reject });
      this.#send({ method, id, ...(params === undefined ? {} : { params }) });
    });
  }

  async initialize() {
    await this.request('initialize', { clientInfo, capabilities:{ experimentalApi:true } });
    this.#send({ method:'initialized' });
    const result = await this.request('account/read', { refreshToken:false });
    if (result?.account?.type !== 'chatgpt') throw new Error('本机 Codex 未使用 ChatGPT 账号登录。');
    this.#signedIn = true;
    return { plan:result.account.planType };
  }

  async catalog() {
    const all = [];
    let cursor;
    do {
      const result = await this.request('model/list', { limit:100, includeHidden:false, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result?.data)) throw new Error('Codex 返回的模型目录格式异常。');
      all.push(...result.data);
      cursor = result.nextCursor;
    } while (cursor && all.length < 200 && all.length > 0);
    return all;
  }

  async turn({ model, effort, cwd, instructions, input, schema, beforeTurn, releaseThread = false }) {
    const result = await this.request('thread/start', {
      model, modelProvider:'openai', allowProviderModelFallback:false, cwd,
      approvalPolicy:'never', sandbox:'read-only', ephemeral:true,
      runtimeWorkspaceRoots:[], environments:[], selectedCapabilityRoots:[],
      baseInstructions:instructions, developerInstructions:'', serviceTier:'default'
    });
    const threadId = result?.thread?.id;
    if (!threadId || result.model !== model) throw new Error('Codex 未采用指定的订阅模型。');
    let settled;
    const completed = new Promise((resolve, reject) => { settled = { resolve, reject }; });
    completed.catch(() => {});
    this.#turn = { threadId, ...settled, text:'' };
    try {
      if (this.#closed) throw this.#closed;
      beforeTurn?.();
      await this.request('turn/start', { threadId, model, effort, environments:[], input, outputSchema:schema, serviceTier:'default' });
      const text = await completed;
      if (releaseThread) {
        try {
          const released = await this.request('thread/unsubscribe', { threadId }, 1500);
          if (!['unsubscribed', 'notLoaded', 'notSubscribed'].includes(released?.status)) this.close();
        } catch {
          // The answer is complete. Retire this worker without replaying the request.
          this.close();
        }
      }
      return text;
    } finally {
      this.#turn = null;
    }
  }

  close(reason = new Error('本机 Codex 连接已结束。')) {
    if (this.#closed) return;
    this.#closed = reason instanceof Error ? reason : new Error('本机 Codex 操作已取消。');
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.#closed);
    }
    this.#pending.clear();
    this.#turn?.reject(this.#closed);
    this.reader.close();
    this.child.stdin.destroy();
    this.child.kill();
  }
}

export async function openCodex({executable, home, cwd}, signal) {
  signal?.throwIfAborted();
  await mkdir(cwd, { recursive:true });
  const options = { cwd, env:codexEnvironment(home), windowsHide:true, signal };
  const args = await startupArgs(executable, options);
  signal?.throwIfAborted();
  const child = spawn(executable, args, { cwd, env:options.env, windowsHide:true, stdio:['pipe','pipe','pipe'] });
  const server = new CodexConnection(child);
  try {
    const account = await server.scoped(signal, connection => connection.initialize());
    return { server, account };
  } catch (error) {
    server.close();
    throw error;
  }
}

export async function withCodex(options, signal, operation) {
  const { server, account } = await openCodex(options, signal);
  try {
    return await server.scoped(signal, connection => operation(connection, account));
  } finally {
    server.close();
  }
}
