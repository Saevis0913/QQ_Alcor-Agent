import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setImmediate as waitForRender } from 'node:timers/promises';
import vm from 'node:vm';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { diagnoseQQ, formatReport } from '../src/qq-diagnosis.js';
import { inspectPeFormat, probeHostArtifact } from '../src/qq-compat.js';
import { createRoutes } from '../src/routes.js';
import { createAlcorRuntime } from '../src/alcor-runtime.js';
import { loadConfig } from '../../alcor/src/config.mjs';
import { createBridge } from '../../alcor/src/server.mjs';

const run = promisify(execFile);
const knownQQ = {
  pid: 101, path: 'C:/QQ/QQ.exe', supported: true, verification: 'live',
  version: '9.9.36-53644', foreignModules: [], alcorHostLoaded: false
};

test('reports Alcor’s own resident host from the last connection attempt', () => {
  const result = diagnoseQQ({
    running: true, processes: [knownQQ],
    lastFailure: { code: 'HOST_ALREADY_PRESENT', stage: 'module_already_loaded', status: 1 }
  });
  assert.equal(result.code, 'INJECTION_BLOCKED');
  assert.equal(result.failure?.code, 'HOST_ALREADY_PRESENT');
});

test('keeps an unrecognized failure and its stage, status and time in the report', (t) => {
  const lastFailure = {
    code: 'NATIVE_CONNECT_FAILED', stage: 'process_creation', status: 0, at: '2026-11-21T16:00:00Z'
  };
  const result = diagnoseQQ({ running: true, processes: [knownQQ], lastFailure });
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  formatReport(result);
  assert.equal(result.code, 'INJECTION_BLOCKED');
  const failureLine = lines.find((line) => line.includes('NATIVE_CONNECT_FAILED'));
  assert.match(failureLine ?? '', /process_creation.*status=0.*2026-11-21T16:00:00Z/);
});

test('retains the attempted connection failure when the current build is unlisted', () => {
  const result = diagnoseQQ({
    running: true,
    processes: [{ ...knownQQ, supported: false, verification: 'family', reason: 'FAMILY_UNVERIFIED' }],
    lastFailure: { code: 'HOST_LOAD_BLOCKED', stage: 'load_library', status: 6 }
  });
  assert.equal(result.code, 'QQ_BUILD_UNLISTED');
  assert.equal(result.failure?.code, 'HOST_LOAD_BLOCKED');
});

test('distinguishes an unreadable process from a build outside the support list', () => {
  const result = diagnoseQQ({
    running: true, processes: [{ pid: 101, supported: false, reason: 'PROCESS_INSPECTION_UNAVAILABLE' }]
  });
  assert.equal(result.code, 'PROCESS_UNREADABLE');
  assert.equal(result.candidate ?? null, null);
});

test('distinguishes a failed process scan from a successful empty scan', () => {
  assert.equal(diagnoseQQ({ running: true, processes: [] }).code, 'NO_QQ_RUNNING');
  const result = diagnoseQQ({ running: true, processes: [], processScanError: 'HTTP 503' });
  assert.equal(result.code, 'PROCESS_SCAN_FAILED');
  assert.match(result.detail, /HTTP 503/);
});

async function runDoctor(t, processStatus, processReply, options = {}) {
  const tempRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempRoot, 'alcor-qq-doctor-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), tempRoot);
    await fs.rm(root, { recursive: true });
  });

  const app = path.join(root, 'resources', 'app');
  await fs.mkdir(path.join(app, 'src'), { recursive: true });
  await fs.mkdir(path.join(app, 'tools'));
  await fs.mkdir(path.join(root, 'resources', 'alcor', 'src'), { recursive: true });
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const file of ['qq-diagnosis.js', 'alcor-runtime.js', 'profile.js', 'standard-connection.js', 'injection-policy.js']) {
    await fs.copyFile(new URL('../src/' + file, import.meta.url), path.join(app, 'src', file));
  }
  await fs.copyFile(new URL('../../alcor/src/config.mjs', import.meta.url), path.join(root, 'resources', 'alcor', 'src', 'config.mjs'));
  // The test exercises the real CLI without starting Windows compatibility probes.
  await fs.writeFile(path.join(app, 'src', 'qq-compat.js'), 'export async function probeQQCompat() { return { testedNative: true }; }');
  const cli = path.join(app, 'tools', 'qq-doctor.mjs');
  await fs.copyFile(new URL('../tools/qq-doctor.mjs', import.meta.url), cli);

  const requests = [];
  const core = createServer(async (req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') {
      if (options.slowHealth && requests.length === 1) await new Promise(resolve => setTimeout(resolve, 1900));
      res.statusCode = options.healthStatus ?? 200;
      res.end(options.rawHealth ?? JSON.stringify({ name: 'Alcor', listening: true, version: '0.3.1', backend: options.health ?? { ws: 'closed' } }));
    } else if (req.url === '/manage/processes') {
      res.statusCode = processStatus;
      res.end(JSON.stringify(processReply));
    } else if (req.url === '/get_status') {
      if (options.slowStatus) await new Promise(resolve => setTimeout(resolve, 1600));
      if (options.standard && (req.headers.authorization !== 'Bearer fixture-status' || req.method !== 'POST')) return res.writeHead(401).end();
      res.statusCode = options.statusCode ?? 200;
      res.end(JSON.stringify(options.status ?? { status: 'ok', retcode: 0, data: { online: false } }));
    } else {
      res.writeHead(404).end();
    }
  }).listen(0, options.host ?? '127.0.0.1');
  t.after(() => new Promise((resolve, reject) => core.close((error) => error ? reject(error) : resolve())));
  await once(core, 'listening');
  if (options.standard) {
    const wsDir = path.dirname(fileURLToPath(import.meta.resolve('ws/package.json')));
    await fs.cp(wsDir, path.join(app, 'node_modules', 'ws'), { recursive: true });
    await fs.writeFile(path.join(app, 'onebot-edition.json'), '{}');
    const port = core.address().port;
    const ws = new WebSocketServer({ server: core, verifyClient: ({ req }) => {
      requests.push('upgrade');
      return req.headers.authorization === 'Bearer fixture-events';
    } });
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ alcor: {
      httpUrl: 'http://127.0.0.1:' + port, wsUrl: 'ws://127.0.0.1:' + port, accessToken: 'fixture-events',
      httpAccessToken: 'fixture-status'
    } }));
  }

  const cfg = JSON.stringify({
    listen: { host: options.host === '::1' ? '[::1]' : '127.0.0.1', port: core.address().port, token: 'local-test-only-token' },
    backend: options.onebot ? { type: 'onebot', wsUrl: 'ws://127.0.0.1:1' } : { type: 'native' }
  });
  const file = path.join(root, options.custom ? '已选择的核心.json' : 'alcor.config.json');
  if (options.custom) await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ alcor: { configFile: file } }));
  if (!options.standard) await fs.writeFile(file, options.encoding ? '\uFEFF' + cfg : cfg, options.encoding ?? 'utf8');
  const command = await run(process.execPath, [cli, '--json'], {
    env: { ...process.env, ALCOR_DATA_DIR: options.custom ? '' : root, ALCOR_AGENT_DATA_DIR: root }, timeout: 10_000
  }).catch((error) => {
    if (!Number.isInteger(error.code) || !error.stdout) throw error;
    return error;
  });
  return { requests, exitCode: command.code ?? 0, ...JSON.parse(command.stdout) };
}

test('standard edition CLI checks the configured OneBot service without an embedded core', async t => {
  const result = await runDoctor(t, 404, {}, { standard: true, status: { status: 'ok', retcode: 0, data: { online: true } } });
  assert.equal(result.verdict.code, 'ALREADY_CONNECTED');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.requests.sort(), ['/get_status', 'upgrade']);
  assert.ok(!JSON.stringify(result.report).includes('fixture-'));
});

test('health retry gets a fresh deadline and accepts a slow backend status query', async t => {
  const result = await runDoctor(t, 404, {}, {
    onebot: true, slowHealth: true, slowStatus: true, health: { ws: 'open', receiveReady: true },
    status: { status: 'ok', retcode: 0, data: { online: true } }
  });
  assert.equal(result.verdict.code, 'ALREADY_CONNECTED');
  assert.deepEqual(result.requests, ['/health', '/health', '/get_status']);
});

test('OneBot diagnosis and stale desktop buttons stay on the external backend', async () => {
  let inspected = 0;
  const state = { running: true, backendType: 'onebot', backendReady: false, statusOnline: false,
    connection: { ws: 'open', receiveReady: true } };
  const calls = [];
  const routes = createRoutes({ alcorInspect: async () => { inspected++; return state; },
    alcorManage: (...args) => { calls.push(args); throw new Error('unexpected management call'); } });
  for (const [route, status] of [['diagnosis', 200], ['autoconnect', 200], ['connect', 409], ['restart', 409]]) {
    const handler = routes.find(r => r.pattern === '/api/qq/' + route).handler;
    const result = await handler({ body: { pid: 1234 }, json: (_res, status, value) => ({ status, value }) });
    assert.equal(result.status, status);
    assert.equal(result.value.data?.code ?? result.value.wording, status === 200 ? 'ONEBOT_ACCOUNT_OFFLINE' : 'ONEBOT_EXTERNAL');
  }
  assert.equal(inspected, 4);
  assert.deepEqual(calls, []);
});

test('Agent route observes authentication failure and recovery through the actual Alcor bridge', async t => {
  let allowStatus = true;
  const apiCalls = [];
  const upstream = createServer((req, res) => {
    apiCalls.push(req.url);
    if (!allowStatus || req.headers.authorization !== 'Bearer fixture-http') return res.writeHead(401).end();
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { online: true } }));
  });
  const ws = new WebSocketServer({ server: upstream, verifyClient: ({ req }) => req.headers.authorization === 'Bearer fixture-ws' });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const parent = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'alcor-agent-bridge-'));
  const file = path.join(directory, 'alcor.config.json');
  let bridge;
  t.after(async () => {
    await bridge?.close();
    for (const peer of ws.clients) peer.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
    await fs.unlink(file);
    await fs.rmdir(directory);
  });
  const port = upstream.address().port;
  const raw = { listen: { port: 0, token: 'fixture-listener-token' }, backend: { type: 'onebot',
    httpUrl: 'http://127.0.0.1:' + port, wsUrl: 'ws://127.0.0.1:' + port, httpToken: 'fixture-http', wsToken: 'fixture-ws' } };
  await fs.writeFile(file, JSON.stringify(raw));
  bridge = createBridge(loadConfig(file));
  const open = once(ws, 'connection');
  const endpoints = await bridge.listen();
  await open;
  await t.waitFor(() => bridge.status().backend.receiveReady, { timeout: 2000 });
  raw.listen.port = Number(new URL(endpoints.httpUrl).port);
  await fs.writeFile(file, JSON.stringify(raw));
  const runtime = createAlcorRuntime({ getSettings: () => ({}), dataDir: directory });
  const route = createRoutes({ alcorInspect: runtime.inspect }).find(r => r.pattern === '/api/qq/diagnosis');
  const diagnose = () => route.handler({ json: (_res, _status, reply) => reply.data.code });
  assert.equal(await diagnose(), 'ALREADY_CONNECTED');
  allowStatus = false;
  assert.equal(await diagnose(), 'ONEBOT_AUTH_FAILED');
  allowStatus = true;
  assert.equal(await diagnose(), 'ALREADY_CONNECTED');
  assert.deepEqual(apiCalls, ['/get_status', '/get_status', '/get_status']);
  // A saved backend switch takes effect on core restart.
  await fs.writeFile(file, JSON.stringify({ ...raw, backend: { type: 'native' } }));
  assert.equal((await runtime.inspect()).backendType, 'onebot');
});

test('standard connection form can save, preserve and clear independent HTTP and WS tokens', async () => {
  const source = await fs.readFile(new URL('../ui/app/03-alcor.js', import.meta.url), 'utf8');
  const fields = new Map();
  const form = { querySelector(key) {
    if (!fields.has(key)) fields.set(key, { value: '', addEventListener() {} });
    return fields.get(key);
  }, addEventListener(_event, fn) { this.submit = () => fn({ preventDefault() {} }); } };
  const box = { innerHTML: '', querySelector: () => form };
  const bodies = [];
  const context = { window: { addEventListener() {} }, document: { addEventListener() {} }, esc: String,
    CONSOLE_MARKER: '', refreshStatus: async () => {}, api: async (_path, options) => bodies.push(JSON.parse(options.body)) };
  vm.runInNewContext(source, context);
  context.loadAlcorPage = async () => {};
  context.renderOneBotEdition(box, { onebotEdition: { hasToken: true } }, false);
  assert.match(box.innerHTML, /type="password"[^>]*|type='password'/);
  assert.match(box.innerHTML, /id="onebot-http-token"/);
  form.querySelector('#onebot-token').value = 'ws-fixture';
  form.querySelector('#onebot-http-token').value = 'http-fixture';
  await form.submit();
  assert.equal(bodies[0].accessToken, 'ws-fixture');
  assert.equal(bodies[0].httpAccessToken, 'http-fixture');
  form.querySelector('#onebot-token').value = 'rotated';
  await form.submit();
  assert.equal(bodies[1].accessToken, 'rotated');
  assert.ok(!Object.hasOwn(bodies[1], 'httpAccessToken'));
  form.querySelector('#onebot-clear-token').checked = true;
  await form.submit();
  assert.equal(bodies[2].accessToken, '');
  assert.equal(bodies[2].httpAccessToken, '');
});

test('doctor uses the selected UTF-16 core config and bracketed IPv6 listener', async t => {
  const result = await runDoctor(t, 200, { processes: [] }, {
    host: '::1', custom: true, encoding: 'utf16le', onebot: true, health: { ws: 'open', receiveReady: true },
    status: { status: 'ok', retcode: 0, data: { online: true } }
  });
  assert.equal(result.verdict.code, 'ALREADY_CONNECTED');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.requests, ['/health', '/get_status']);
  assert.ok(!result.report.compat?.testedNative);
});

for (const [description, options, code] of [
  ['core rejects its listener token', { healthStatus: 401 }, 'ALCOR_AUTH_FAILED'],
  ['port responds with an HTML page', { rawHealth: '<html></html>' }, 'ALCOR_IDENTITY_MISMATCH'],
  ['upstream rejects its HTTP token', { health: { ws: 'open', http: 'reachable' }, statusCode: 502,
    status: { status: 'failed', retcode: 502, wording: 'UPSTREAM_HTTP_401' } }, 'ONEBOT_AUTH_FAILED'],
  ['event socket is down', { health: { ws: 'disconnected' } }, 'ONEBOT_EVENTS_UNAVAILABLE'],
  ['account is explicitly offline', { health: { ws: 'open', receiveReady: true } }, 'ONEBOT_ACCOUNT_OFFLINE'],
  ['status request failed despite a heartbeat', { health: { ws: 'open', qqOnline: true }, statusCode: 504 }, 'ONEBOT_STATUS_UNAVAILABLE']
]) {
  test('doctor distinguishes ' + description, async t => {
    const result = await runDoctor(t, 404, {}, { onebot: true, ...options });
    assert.equal(result.verdict.code, code);
    assert.ok(!result.requests.includes('/manage/processes'));
    assert.ok(!result.report.compat?.testedNative);
    assert.ok(!JSON.stringify(result.verdict).includes('local-test-only-token'));
  });
}

test('doctor keeps the core online when its process endpoint returns HTTP 503', async (t) => {
  const result = await runDoctor(t, 503, { status: 'failed' });
  assert.equal(result.report.running, true);
  assert.equal(result.verdict.code, 'PROCESS_SCAN_FAILED');
  assert.match(result.verdict.detail, /HTTP 503/);
  assert.equal(result.exitCode, 4);
});

test('doctor reports the process snapshot failure even when health provides backend details', async (t) => {
  const result = await runDoctor(t, 200, {
    processes: [knownQQ],
    connection: { connected: false, lastFailure: { code: 'HOST_ALREADY_PRESENT', status: 6 } }
  });
  assert.equal(result.report.running, true);
  assert.equal(result.verdict.code, 'INJECTION_BLOCKED');
  assert.equal(result.verdict.failure?.code, 'HOST_ALREADY_PRESENT');
  assert.equal(result.report.connection?.ws, 'closed');
});

test('keeps security settings unknown when the environment probe is unavailable', (t) => {
  const result = diagnoseQQ({ running: true, compat: { supported: false, security: null } });
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  formatReport(result);
  const securityLine = lines.find((line) => line.includes('安全策略'));
  assert.match(securityLine ?? '', /内存完整性未知.*智能应用控制未知/);
});

test('keeps the connection attempt result after refreshing the card', async () => {
  const source = await fs.readFile(new URL('../ui/app/19-qq-link.js', import.meta.url), 'utf8');
  let statusNode;
  let click;
  const autoButton = { dataset: { qq: 'auto' }, addEventListener: (_, action) => { click = action; } };
  const box = {
    set innerHTML(html) {
      statusNode = html.includes('class="qq-status"') ? { textContent: '', style: {} } : null;
    },
    querySelectorAll: () => statusNode ? [autoButton] : [],
    querySelector: (selector) => selector === '.qq-status' ? statusNode : null
  };
  const verdict = { code: 'READY_TO_CONNECT', processes: [knownQQ] };
  const context = {
    window: {}, document: { getElementById: () => box, addEventListener() {} }, esc: String,
    api: async (route) => {
      if (route === '/api/qq/diagnosis') return { data: verdict };
      assert.equal(route, '/api/qq/autoconnect');
      return { data: { code: 'HOST_LOADER_FAILED', steps: [{ status: 'error', text: '加载器执行失败' }] } };
    }
  };
  vm.runInNewContext(source, context);
  context.window.renderQqLinkCard();
  await waitForRender();
  await click();
  assert.match(statusNode.textContent, /加载器执行失败[\s\S]*HOST_LOADER_FAILED/);
});

test('a foreign-session QQ does not veto a usable candidate in this session', () => {
  const other = { ...knownQQ, pid: 202 };
  const result = diagnoseQQ({
    running: true, processes: [knownQQ, other],
    compat: { flags: { foreignSession: [202] } }
  });
  assert.equal(result.code, 'READY_TO_CONNECT');
  assert.equal(result.candidate?.pid, 101);
  assert.match(result.warnings.join('|'), /其它 Windows 会话/);
});

test('an x86 QQ does not veto a usable x64 candidate', () => {
  const other = { ...knownQQ, pid: 203 };
  const result = diagnoseQQ({
    running: true, processes: [knownQQ, other],
    compat: { flags: { archMismatch: [{ pid: 203, arch: 'x86' }] } }
  });
  assert.equal(result.code, 'READY_TO_CONNECT');
  assert.equal(result.candidate?.pid, 101);
});

test('when every QQ is in another session the session verdict still wins', () => {
  const result = diagnoseQQ({
    running: true, processes: [knownQQ],
    compat: { flags: { foreignSession: [101] } }
  });
  assert.equal(result.code, 'SESSION_MISMATCH');
  assert.ok(!result.candidate);
});

test('a failure recorded for a QQ process that has exited no longer blocks readiness', () => {
  const stale = diagnoseQQ({ running: true, processes: [knownQQ],
    lastFailure: { code: 'HOST_LOAD_BLOCKED', pid: 999, stage: 'load_library', at: '2026-11-22T08:00:22.750Z' } });
  assert.equal(stale.code, 'READY_TO_CONNECT');
  assert.match(stale.warnings.join('|'), /已退出的 QQ 进程（PID 999）/);
  const fresh = diagnoseQQ({ running: true, processes: [knownQQ],
    lastFailure: { code: 'HOST_LOAD_BLOCKED', pid: 101, stage: 'load_library' } });
  assert.equal(fresh.code, 'INJECTION_BLOCKED');
  assert.match(fresh.hint, /排除项|HVCI/);
});

test('the host artifact probe rejects a same-size file that is not an x64 PE', () => {
  const real = probeHostArtifact();
  assert.equal(real.ok, true, 'the bundled host DLL should pass');
  assert.equal(real.format, 'pe32+x64');
  const junk = Buffer.alloc(0x4000, 0x41);
  junk[0] = 0x4d; junk[1] = 0x5a;
  assert.equal(inspectPeFormat(junk).ok, false);
  assert.equal(inspectPeFormat(Buffer.alloc(0)).ok, false);
});

test('a failed process scan is not cached for the next ten seconds', async () => {
  let fail = true;
  const state = { running: true, backendReady: false, backendType: 'native', connection: null };
  const routes = createRoutes({
    alcorInspect: async () => state,
    alcorManage: async (what) => {
      if (what !== 'processes') return { ok: false, status: 404 };
      if (fail) throw new Error('HTTP 503');
      return { ok: true, status: 200, body: { processes: [knownQQ], connection: null } };
    }
  });
  const route = routes.find(r => r.pattern === '/api/qq/diagnosis');
  const call = () => route.handler({ json: (_res, _status, reply) => reply.data });
  assert.equal((await call()).code, 'PROCESS_SCAN_FAILED');
  fail = false;
  assert.equal((await call()).code, 'READY_TO_CONNECT');
});
