// Alcor Agent integration. Only the child created by this manager may be stopped.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { loadConfig } from '../../alcor/src/config.mjs';

export function readAlcorConnection(configFile) {
  const config = loadConfig(path.resolve(configFile));
  const host = config.listen.host.includes(':') ? `[${config.listen.host}]` : config.listen.host;
  const httpUrl = `http://${host}:${config.listen.port}`;
  return { httpUrl, wsUrl: httpUrl.replace('http:', 'ws:') + '/events', accessToken: config.listen.token,
    httpAccessToken: config.listen.token, host: config.listen.host, port: config.listen.port };
}

const delay = ms => new Promise(r => setTimeout(r, ms));
export function createAlcorRuntime({ getSettings, dataDir, appRoot, nodeExecutable,
  onLog = () => {}, onStatus = () => {} }) {
  let child = null, starting = null, stopping = null;
  const logs = [];
  const dir = () => path.resolve(getSettings()?.dir || path.join(appRoot, '../alcor'));
  const configFile = () => path.resolve(getSettings()?.configFile || path.join(dataDir, 'alcor.config.json'));
  const connection = () => readAlcorConnection(configFile());
  const owned = () => ({ embedded: !!child && child.exitCode === null, pid: child?.pid ?? null });
  const log = (text, stream = 'stdout') => {
    const line = { at: Date.now(), stream, text };
    logs.push(line); if (logs.length > 200) logs.shift(); onLog(line);
  };
  async function inspect() {
    let config;
    try { config = connection(); }
    catch { return { ...owned(), running: false, backendReady: false, code: 'ALCOR_CONFIG_INVALID', error: 'Alcor 本地配置不可用', occupied: false }; }
    try {
      const res = await fetch(config.httpUrl + '/health', { headers: { authorization: `Bearer ${config.accessToken}` }, signal: AbortSignal.timeout(1200) });
      if (res.status === 401) return { ...owned(), running: false, backendReady: false, occupied: true, code: 'ALCOR_AUTH_FAILED', error: 'Alcor 访问令牌不匹配，请核对所选配置' };
      const health = await res.json();
      if (!res.ok || health.name !== 'Alcor' || health.listening !== true) return { ...owned(), running: false, backendReady: false, occupied: true, code: 'ALCOR_IDENTITY_MISMATCH', error: '指定端口不是可验证的 Alcor 服务' };
      let backendReady = false;
      try {
        const status = await fetch(config.httpUrl + '/get_status', { headers: { authorization: `Bearer ${config.accessToken}` }, signal: AbortSignal.timeout(1200) });
        const body = await status.json();
        backendReady = health.backend?.ws === 'open' && status.ok && body.status === 'ok' && body.data?.online === true;
      } catch { /* The core is alive even when its QQ backend cannot answer. */ }
      return { ...owned(), running: true, backendReady, backendType:health.backend?.type??'onebot', receiveReady:health.backend?.receiveReady??null, occupied: true, version: health.version, error: '', code: null };
    } catch (error) {
      const refused = error?.cause?.code === 'ECONNREFUSED' || error?.cause?.errors?.every(e => e.code === 'ECONNREFUSED');
      return { ...owned(), running: false, backendReady: false, occupied: !refused,
        code: refused ? 'ALCOR_OFFLINE' : 'ALCOR_UNAVAILABLE', error: refused ? 'Alcor 核心未启动' : 'Alcor 无法响应，请检查端口或服务状态' };
    }
  }
  async function stopChild() {
    const current = child;
    if (!current) return false;
    const exited = once(current, 'exit').catch(() => {});
    if (current.connected) { try { current.send({ type: 'alcor-stop' }); } catch { /* exited concurrently */ } }
    await Promise.race([exited, delay(2500)]);
    if (current.exitCode === null && current.signalCode === null) { current.kill(); await Promise.race([exited, delay(1500)]); }
    if (child === current) child = null;
    log('已关闭本 Agent 启动的 Alcor 核心。');
    return true;
  }
  async function launch() {
    const status = await inspect();
    if (status.running) return { ok: true, alreadyRunning: true, ...owned() };
    if (status.code === 'ALCOR_CONFIG_INVALID' || status.occupied) return { ok: false, code: status.code, error: status.error };
    if (child) return { ok: false, code: 'ALCOR_CHILD_NOT_READY', error: '本 Agent 的核心进程尚未就绪，请先停止后重试' };
    const entry = path.join(dir(), 'src/main.mjs');
    const node = nodeExecutable || path.resolve(appRoot, '../../runtime/node.exe');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir(), 'package.json'), 'utf8'));
      if (pkg.name !== 'alcor' || !fs.existsSync(entry) || !fs.existsSync(node)) throw new Error();
    } catch { return { ok: false, code: 'ALCOR_FILES_MISSING', error: '未找到完整的 Alcor 核心或 Node 运行时' }; }
    const temp = path.join(dataDir, 'temp'); fs.mkdirSync(temp, { recursive: true });
    const current = spawn(node, [entry, '--config', configFile()], { cwd: dir(), windowsHide: true,
      env: { ...process.env, TEMP: temp, TMP: temp }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child = current;
    // Do not forward raw child output, which may include future configuration diagnostics.
    current.stdout.resume(); current.stderr.resume();
    let spawnFailed = false;
    current.on('error', () => { spawnFailed = true; if (child === current) child = null; log('Alcor 核心启动失败。', 'stderr'); });
    current.on('exit', () => { if (child === current) child = null; onStatus({ running: false, backendReady: false, ...owned() }); });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !spawnFailed && current.exitCode === null && current.signalCode === null) {
      await delay(80); const ready = await inspect();
      if (ready.running) { log('Alcor 核心已启动；QQ 账号是否在线请查看后端状态。'); onStatus(ready); return { ok: true, launched: true, ...owned() }; }
    }
    await stopChild(); return { ok: false, code: 'ALCOR_START_FAILED', error: 'Alcor 未能启动，请检查配置和端口' };
  }
  return {
    dir, configFile, connection, owned, logs, inspect,
    panelUrl: () => connection().httpUrl + '/panel/',
    panelLoginUrl: () => connection().httpUrl + '/panel/#token=' + encodeURIComponent(connection().accessToken),
    start() {
      if (stopping) return stopping.then(() => this.start());
      if (!starting) starting = launch().finally(() => { starting = null; });
      return starting;
    },
    stop() {
      if (!stopping) stopping = (async () => { if (starting) await starting; return stopChild(); })().finally(() => { stopping = null; });
      return stopping;
    }
  };
}
