// API 路由表：把 handleHttp 的巨型 if-else 链拆成声明式路由。
//
// 每个路由：{ method, pattern, handler }
//   - method: 'GET' | 'POST' | 'PUT' | 'DELETE' | '*'（'*' 匹配任意方法）
//   - pattern: 字符串（精确匹配）或 RegExp（exec 捕获组传给 handler）
//   - handler: async (ctx) => 结果
//       ctx = { req, res, url, pathname, method, match, body?, ...deps }
//       handler 返回 undefined 表示"已自行写响应"（如 SSE）；否则框架统一 json() 返回。
//
// 依赖（store/memory/sessions/onebot/orchestrator/…）通过 createRoutes(deps) 注入，
// 路由 handler 通过闭包取用，避免在 app.js 里反复传参。

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getConfig, updateConfig, deepMerge as deepMergeConfig, DATA_DIR, ROOT } from './config.js';
import { runPreflight } from './preflight.js';
import { customSearch, SEARCH_PROVIDER_META, testSearchProvider } from './web-search.js';
import { readUpdateSource, writeUpdateSource } from './update-source.js';
import { diagnoseQQ, readQQProcessSnapshot, scanFrameworkDirs, qqInstallRoots } from './qq-diagnosis.js';
import { collectInjectionCheck, runInjectionFix, formatInjectionReport } from './injection-doctor.js';
import { probeQQCompat } from './qq-compat.js';
import { collectPolicyReport, evaluatePolicy, policyRemedies, readPolicyMemory, recordPolicyOutcome, addDefenderExclusion } from './injection-policy.js';
import { restartQQ, waitForQQ, locateQQExecutable } from './qq-repair.js';
import { listModels, chatCompletion, resolveApiKey, estimateCost, cacheHitRate } from './llm.js';
import { resolveOfficialPrice, listOfficialPrices } from './model-prices.js';
import { refreshPriceFeed, priceFeedStatus, initPriceFeed } from './price-feed.js';
import {
  currentProviders, setProviderKey, testAllProviders, testOneProvider,
  testModelChat, fetchModelsFrom, upsertProvider, addModelsToProvider, removeModelFromProvider, removeProvider
} from './providers.js';
import { scanModelsVision, visionResults, modelImageVerdict } from './vision-scan.js';
import { builtinVisionResults } from './model-vision-docs.js';
import { todayKey } from './util.js';
import { logger } from './logger.js';
import { skillManager } from './skills/manager.js';
import { getSkillConfig, setSkillConfig, setSkillEnabled, listConfiguredSkillIds } from './skills/config.js';
import { availabilityOf, listTools, CATEGORY_META } from './tool-registry.js';
import { safeFetchBinary, browseLockState } from './safe-fetch.js';
import { getGlobalBlocklist, updateGlobalBlocklist, FIXED_PRICE_FEED_URL } from './community.js';
import { verifyInstallCodes, installByCode } from './market.js';
import { extensionWorkspace } from './extension-workspace.js';
import { collectEnvironment, formatEnvironmentReport } from './environment-check.mjs';
import { contactChoices } from './contacts.js';
import { createStickerRoutes } from './sticker-routes.js';
import { fetchMessageImage } from './onebot.js';
import { detectDialect as detectThinkingDialect } from './thinking.js';
import { createQzoneRoutes } from './qzone-routes.js';
import { releaseProjectUrl } from './release-update.js';
import { checkForUpdate } from './update-manager.js';
import { updateState, downloadUpdate, installUpdate, repairUpdate, dismissUpdate } from './update-manager.js';
import { createDesktopActions } from './desktop-actions.js';
import { createChatActionRoutes } from './chat-actions.js';
import { chatAllowed } from './inbound-policy.js';
import { renderReplyPreview } from './prompt.js';

/**
 * 构建路由表。
 * @param {object} deps 依赖注入
 */
export function createRoutes(deps) {
  const {
    store, memory, sessions, onebot, orchestrator, inbox,
    emit, log,
    // app.js 内部的过程/状态
    localVersion,
    sanitizeConfig, keyEndpointAllowed, sanitizeProvider,
    readBody, authorize,
    alcorDir, alcorWsPort, alcorWebuiUrl, alcorStatus, alcorLogs,
    launchAlcor, stopAlcor,
    qqPortableStatus, qqPortableLogs, launchPortableQQ, stopPortableQQ,
    visionScan,
    buildUsageStats, buildUsageBreakdown,
    reloadSkills
  } = deps;

  // QQ 连接排查：进程清单来自核心，判定逻辑只有一份（src/qq-diagnosis.js），界面、状态栏和自带排查程序共用。
  let qqDiagCache = null;
  async function collectQQDiagnosis(depsRef, { fresh = false, state = null } = {}) {
    state ??= await depsRef.alcorInspect();
    const facts = { running: state.running, backendReady: state.backendReady, backendType: state.backendType,
      directOneBot: state.directOneBot, coreCode: state.code, connection: state.connection,
      statusOnline: state.statusOnline, statusError: state.statusError };
    if (!state.running || state.backendType === 'onebot') {
      qqDiagCache = null;
      return diagnoseQQ(facts);
    }
    const now = Date.now();
    // 扫描失败（进程接口 503 / 超时）不进缓存：十秒内环境一变，缓存会把「还在失败」当成结论。
    if (!fresh && qqDiagCache && now - qqDiagCache.at < 10_000 && !qqDiagCache.processScanError
      && qqDiagCache.running === state.running && qqDiagCache.backendReady === state.backendReady) return qqDiagCache.verdict;
    let processes = [], connection = state.connection ?? null, processScanError = '';
    if (typeof depsRef.alcorManage !== 'function') {
      processScanError = '核心管理接口不可用。';
    } else {
      try {
        const result = await depsRef.alcorManage('processes');
        if (!result.ok) throw new Error(`HTTP ${result.status}`);
        const snapshot = readQQProcessSnapshot(result.body);
        processes = snapshot.processes;
        if (snapshot.connection) connection = { ...connection, ...snapshot.connection,
          receiveReady: state.receiveReady ?? snapshot.connection.receiveReady };
      } catch (error) {
        processScanError = error?.message || '核心未返回 QQ 进程清单。';
      }
    }
    let compat = null;
    try {
      // 进程清单为空时也要探：注入器/宿主 DLL 缺不缺，与 QQ 有没有打开无关。
      compat = await probeQQCompat({ processRows: processes });
    } catch { compat = null; }
    const verdict = diagnoseQQ({ ...facts, processes, connection,
      frameworkDirs: scanFrameworkDirs(qqInstallRoots(processes)),
      compat, processScanError });
    qqDiagCache = { at: now, running: state.running, backendReady: state.backendReady, processScanError, verdict };
    return verdict;
  }

  // 防护策略（HVCI / 智能应用控制 / Defender / QQ 自身缓解策略）只回答「会不会被拦、被拦了走哪条路」。
  // 它不阻断已实测能注入的机器：策略开着但上次注入成功过，会降级成提示（见 injection-policy.js）。
  const POLICY_PACK_ROOT = process.env.ALCOR_PROFILE_PACK_DIR
    || path.join(process.env.ProgramData || process.env.ALLUSERSPROFILE || DATA_DIR, 'Alcor', 'host');
  const policyInstallRoot = () => path.resolve(ROOT, '../..');
  // 宿主组件的实际哈希 vs 发布清单：对不上就说明文件被换过/截断/隔离过。
  function artifactDigests() {
    const root = policyInstallRoot();
    const base = path.join(root, 'resources', 'alcor', 'artifacts', 'native');
    let expected = new Map();
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release-manifest.json'), 'utf8'));
      for (const row of manifest?.files || []) expected.set(String(row.path || '').replace(/\//g, '\\').toLowerCase(), String(row.sha256 || ''));
    } catch { expected = new Map(); }
    return ['alcor-host.dll', 'qq-host-loader.exe'].map((name) => {
      const file = path.join(base, name);
      const key = ('resources\\alcor\\artifacts\\native\\' + name).toLowerCase();
      const sha256 = fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : '';
      return { name, sha256, expectedSha256: expected.get(key) || '' };
    });
  }
  async function collectPolicy(pid, extra = {}) {
    try {
      const report = await collectPolicyReport({ pid: Number(pid) || 0, dataDir: DATA_DIR });
      const memory = readPolicyMemory(DATA_DIR);
      const evaluated = evaluatePolicy(report, { memory, installRoot: policyInstallRoot(), packRoot: POLICY_PACK_ROOT,
        artifacts: artifactDigests(), lastFailure: extra.lastFailure || null });
      return { ...evaluated, report: { ...report, script: undefined }, remedies: policyRemedies(report) };
    } catch (error) {
      return { ok: false, error: error?.message || 'POLICY_PROBE_FAILED', findings: [], blocked: false, summary: '', remedies: [] };
    }
  }
  function recordConnectOutcome(verdict, result) {
    try {
      const cig = verdict?.policy?.report?.process?.mitigations?.microsoftSignedOnly === true;
      const wording = String(result?.body?.wording || result?.body?.error || '');
      const ok = Boolean(result?.ok) && result?.body?.status !== 'failed';
      recordPolicyOutcome(DATA_DIR, {
        cig: ok ? 'loaded' : (cig ? 'blocked' : 'unknown'),
        elevation: verdict?.policy?.report?.self?.elevated ? 'elevated' : 'user',
        stage: String(result?.body?.stage || ''),
        code: ok ? 'CONNECTED' : (wording || 'CONNECT_FAILED')
      });
    } catch { /* 记忆写不进去不影响连接本身 */ }
  }

  // 小工具：读请求体（容错：没 body 当空对象）。
  // 但 readBody 明确标记的可暴露错误（400 非法 JSON / 413 过大）必须透传，
  // 否则会从"应返回 400"退化成静默当成空 patch。
  const bodyOf = (req) => readBody(req).catch((e) => { if (e?.expose) throw e; return {}; });

  /**
   * Skill 可用性判断的运行期上下文。
   * 必须和 orchestrator 用同一份输入，否则会出现
   * "设置页说可用、运行时空工具列表"的口径分裂。
   */
  const skillRuntimeContext = () => {
    const cfg = getConfig();
    return {
      skills: skillManager,
      toolsCfg: cfg.tools || {},
      // 与 orchestrator 同款判定：vision 开关开着，且当前模型没有被
      // 视觉扫描判定为 no-vision（曾经只看前半项，模型不支持时
      // 设置页仍显示视觉工具可用，运行时却剔除）
      visionEnabled: cfg.api?.vision !== false
        && modelImageVerdict(cfg.api?.provider, cfg.api?.model) !== 'no-vision',
      searchEnabled: cfg.webSearch?.enabled !== false,
      runtimeContext: {
        model: cfg.api?.model || '',
        provider: cfg.api?.provider || '',
        source: 'api'
      }
    };
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // 「一键检测并连接」：启动核心、拉起 QQ、重试注入、未适配构建走兼容模式（用户已同意时），
  // 每一步都留记录，界面照抄显示。
  async function autoConnect({ allowUnverified = false } = {}) {
    const steps = [];
    const push = (id, text, status = 'ok') => { steps.push({ id, text, status }); };
    let state = await deps.alcorInspect();
    if (state.backendType === 'onebot' || (state.code && state.code !== 'ALCOR_OFFLINE')) {
      const verdict = await collectQQDiagnosis(deps, { state, fresh: true });
      push('probe', [verdict.title, verdict.hint].filter(Boolean).join('。'), verdict.backendReady ? 'ok' : 'manual');
      return { code: verdict.code, steps };
    }
    if (!state.running) {
      push('core', 'Alcor 核心没在运行，先启动它', 'running');
      try { await launchAlcor(); } catch { /* 下面统一判定 */ }
      await wait(2500);
      state = await deps.alcorInspect();
    }
    push('core', state.running ? '核心已运行' : '核心没有起来', state.running ? 'ok' : 'error');
    if (!state.running) return { code: 'CORE_OFFLINE', steps };

    if (state.backendType === 'native' && state.connection?.connected && !state.backendReady) {
      const verdict = diagnoseQQ(state);
      push('probe', [verdict.title, verdict.detail].join('。'), 'manual');
      return { code: verdict.code, steps, connection: state.connection };
    }
    let verdict = await collectQQDiagnosis(deps, { state, fresh: true });
    push('probe', '当前判定：' + verdict.code + (verdict.title ? '（' + verdict.title + '）' : ''), 'ok');
    if (verdict.code === 'ALREADY_CONNECTED') return { code: 'ALREADY_CONNECTED', steps, connection: verdict.connection || null };

    verdict.policy = await collectPolicy(verdict.candidate?.pid ?? verdict.connection?.pid, { lastFailure: verdict.connection?.lastFailure || null });
    const worst = verdict.policy.findings.find((item) => item.level === 'block');
    if (verdict.policy.findings.length) push('policy', verdict.policy.summary || '防护策略已检查', worst ? 'manual' : 'ok');
    if (worst) {
      push('policy', worst.detail || worst.title, 'manual');
      return { code: worst.code, steps, policy: verdict.policy, remedies: verdict.policy.remedies };
    }

    if (verdict.code === 'NO_QQ_RUNNING') {
      const exe = await locateQQExecutable();
      if (!exe) { push('qq', '没找到 QQ 安装位置，请先安装官方 QQ', 'manual'); return { code: 'NO_QQ_INSTALL', steps }; }
      try {
        const { spawn } = await import('node:child_process');
        const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
        push('qq', '已启动 QQ（' + exe + '），登录后点「重新检测」', 'ok');
      } catch (error) { push('qq', '启动 QQ 失败：' + (error?.message || error), 'manual'); return { code: 'NO_QQ_INSTALL', steps }; }
      await wait(12_000);
      verdict = await collectQQDiagnosis(deps, { fresh: true });
      push('qq', '重新检测：' + verdict.code, 'ok');
      if (verdict.code === 'NO_QQ_RUNNING') return { code: 'WAITING_LOGIN', steps };
    }

    if (verdict.code === 'ELEVATION_MISMATCH') { push('elevation', 'QQ 与 Alcor 权限不一致，需要统一权限后重开', 'manual'); return { code: 'ELEVATION_MISMATCH', steps, canRelaunchAdmin: true }; }
    if (verdict.code === 'SESSION_MISMATCH') { push('session', 'QQ 与 Alcor 不在同一个 Windows 会话', 'manual'); return { code: 'SESSION_MISMATCH', steps }; }
    if ((verdict.code === 'UNSUPPORTED_BUILD' || verdict.code === 'QQ_BUILD_UNLISTED') && !allowUnverified) { push('build', '当前 QQ 构建未登记，可以选「仍然尝试注入」试一次', 'manual'); return { code: verdict.code, steps, needConsent: true }; }
    if (verdict.code === 'HOST_PRESENT') {
      push('host', '宿主还在 QQ 里，等它自己接回来（最多 30 秒）', 'running');
      await wait(30_000);
      verdict = await collectQQDiagnosis(deps, { fresh: true });
      push('host', '等待后判定：' + verdict.code, 'ok');
      if (verdict.code === 'ALREADY_CONNECTED') return { code: 'ALREADY_CONNECTED', steps, connection: verdict.connection || null };
    }

    const pid = Number(verdict.candidate?.pid) || null;
    if (!pid) { push('connect', '没有可连接的 QQ 进程（' + verdict.code + '）', 'manual'); return { code: verdict.code, steps }; }
    const retryable = new Set(['HOST_ENTRY_FAILED', 'HOST_THREAD_PENDING', 'HOST_LOADER_TIMEOUT', 'HOST_START_INCOMPLETE', 'NATIVE_CONNECT_FAILED', 'HOST_ALREADY_PRESENT', 'HOST_REFERENCE_STUCK']);
    const needsCleanQQ = new Set(['HOST_ALREADY_PRESENT', 'HOST_REFERENCE_STUCK']);
    const listProcesses = async () => {
      try { const r = await deps.alcorManage('processes'); return Array.isArray(r.body?.processes) ? r.body.processes : []; } catch { return []; }
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await deps.alcorManage('native/connect', { method: 'POST', body: { pid, ...(allowUnverified ? { allowUnverified: true } : {}) }, timeoutMs: 90_000 });
      const wording = result.body?.wording || result.body?.error || '';
      const ok = result.ok && result.body?.status !== 'failed';
      recordConnectOutcome(verdict, result);
      if (ok) { push('connect', '第 ' + attempt + ' 次就注入成功（PID ' + pid + '）', 'ok'); return { code: 'CONNECTED', steps, connection: result.body?.data || result.body || null, pid }; }
      push('connect', '第 ' + attempt + ' 次失败：' + (wording || '未知原因'), attempt < 3 && retryable.has(String(wording)) ? 'retry' : 'error');
      if (!retryable.has(String(wording))) break;
      if (needsCleanQQ.has(String(wording))) {
        push('clean', '先把 QQ 关干净再重开，清掉驻留的旧模块', 'running');
        const restarted = await restartQQ({ listProcesses });
        push('clean', restarted.ok ? 'QQ 已重新启动，继续尝试注入' : ('重启 QQ 没成功：' + (restarted.error || restarted.code)), restarted.ok ? 'ok' : 'manual');
        if (!restarted.ok) break;
        await wait(10_000);
      }
      await wait(1200 * attempt);
    }
    const policy = await collectPolicy(pid, { lastFailure: verdict.connection?.lastFailure || null });
    if (policy.remedies?.length) push('policy', '可尝试：' + policy.remedies.map((item) => item.title).join(' / '), 'manual');
    return { code: 'CONNECT_FAILED', steps, policy };
  }

  return [
    ...createStickerRoutes({ stickers: deps.stickers, readBody, log }),
    ...createQzoneRoutes(deps.qzone),
    ...createDesktopActions(deps.onRestart),
    ...createChatActionRoutes({ onebot, store, inbox, readBody, emit, standard: deps.standard,
      onRecall: (entry) => orchestrator.onRecall(entry) }),
    {
      method: 'POST', pattern: '/api/onebot/connection',
      handler: async ({ req, res, json }) => {
        if (!deps.standard) return json(res, 404, { error: '当前安装使用内置核心连接。' });
        if (req.headers['x-alcor-local-action'] !== 'configure-onebot') return json(res, 403, { error: '此操作只能由本机管理端发起。' });
        const body = await readBody(req);
        try {
          await deps.configureStandardConnection(body);
          return json(res, 200, { ok: true });
        } catch (error) { return json(res, 400, { error: String(error.message || '无法保存连接设置。') }); }
      }
    },
    {
      method:'GET', pattern:'/api/environment',
      handler:async({res,json})=>{
        const cfg=getConfig(),allowedPorts=[res.socket.localPort];
        try {if((await deps.alcorInspect()).running)allowedPorts.push(deps.alcorConnection().port);}catch{}
        const report=await collectEnvironment({installRoot:path.resolve(ROOT,'../..'),dataDir:DATA_DIR,config:cfg,allowedPorts,standard:deps.standard});
        return json(res,200,{...report,text:formatEnvironmentReport(report)});
      }
    },
    {
      method: 'GET', pattern: '/api/extensions/workspace',
      handler: async ({res, json}) => json(res, 200, extensionWorkspace())
    },
    // 桌面端重复启动兜底：让「已经在跑的那个实例」把窗口亮出来。
    // 旧实现里新进程拿不到锁就退出或报错，用户看到的是"双击打不开"。
    {
      method: 'POST', pattern: '/api/window/show',
      handler: async ({ res, json }) => {
        try { deps.showWindow?.(); } catch (error) { log?.(['[window] 唤出窗口失败', error.message]); }
        return json(res, 200, { ok: true });
      }
    },
    // ── 状态 / 数据目录 / 重置 ─────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/status',
      handler: async ({ res, json }) => {
        const dayKey = todayKey();
        const usage = sessions.todayUsage(dayKey);
        const cfgNow = getConfig();
        const cost = estimateCost(usage, { model: cfgNow.api?.model });
        const alcorState = await deps.alcorInspect();
        const slRunning = alcorState.running;
        let onebotDiagnosis = alcorState.error || '';
        let qqVerdict = null;
        if ((slRunning || alcorState.directOneBot) && !alcorState.backendReady) {
          // 「连不上」有很多种，状态栏只说最贴近的那一种，完整排查在设置页的 QQ 接入诊断里。
          try { qqVerdict = await collectQQDiagnosis(deps, { state: alcorState }); onebotDiagnosis = qqVerdict.title + (qqVerdict.hint ? '：' + qqVerdict.hint : ''); }
          catch { onebotDiagnosis = 'Alcor 已启动，账号状态尚未确认；请在 Alcor 控制台查看 QQ 接入'; }
        }
        else if (slRunning && !onebot.connected) onebotDiagnosis = onebot.lastConnectError || '正在连接 Alcor…';
        return json(res, 200, {
          ...(deps.standard && { onebotEdition: { httpUrl: onebot.httpUrl, wsUrl: onebot.wsUrl,
            hasToken: Boolean(onebot.accessToken), hasHttpToken: Boolean(cfgNow.alcor?.httpAccessToken) } }),
          onebot: {
            connected: onebot.connected,
            everConnected: onebot.everConnected,
            error: onebot.lastConnectError,
            diagnosis: onebotDiagnosis,
            self: onebot.selfInfo && (!deps.standard || alcorState.backendReady)
              ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null
          },
          alcor: {
            dir: alcorDir(),
            running: slRunning,
            webuiUrl: alcorWebuiUrl(),
            ...alcorState,
            ...(qqVerdict ? { qq: { code: qqVerdict.code, title: qqVerdict.title, hint: qqVerdict.hint } } : {})
          },
          qqPortable: await qqPortableStatus(),
          orchestrator: orchestrator.statusSummary(),
          usage,
          cost,
          cacheHitRate: cacheHitRate(usage),
          webSearchCount: usage.webSearchCount || 0,
          paused: orchestrator.paused,
          pauseReason: orchestrator.pauseReason ?? null,
          dataDir: DATA_DIR
        });
      }
    },
    {
      method: 'POST', pattern: '/api/open-data-dir',
      handler: async ({ res, json }) => {
        try {
          spawn('explorer.exe', [DATA_DIR], { detached: true, stdio: 'ignore' }).unref();
          return json(res, 200, { ok: true, dir: DATA_DIR });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/reset-data',
      handler: async ({ res, json }) => {
        try {
          // 安全闸：只允许重置"看起来确实是数据目录"的路径。
          // ALCOR_AGENT_DATA_DIR 被误设成 C:\ 或用户目录时，无闸直接 rmSync 就是删盘。
          const resolved = path.resolve(DATA_DIR);
          const looksLikeDataDir = path.basename(resolved).toLowerCase().startsWith('data')
            || fs.existsSync(path.join(resolved, 'config.json'));
          if (!looksLikeDataDir || resolved === path.parse(resolved).root) {
            return json(res, 400, { ok: false, error: `数据目录不像 Alcor Agent 数据目录，已拒绝重置：${resolved}` });
          }

          await orchestrator.abortAll();
          onebot.close();

          // 删前先备份：同级带时间戳的副本，出问题还能捞回来；备份失败则中止重置。
          let backupDir = '';
          try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            backupDir = `${resolved}.backup-${stamp}`;
            fs.cpSync(resolved, backupDir, { recursive: true, force: true });
          } catch (error) {
            return json(res, 500, { ok: false, error: `备份失败，已中止重置：${String(error?.message ?? error)}` });
          }

          // 只清内容，不删目录本身（目录可能被占用/是挂载点）；
          // 跳过 qq-agent.lock —— 那是本进程活着的凭证，删了会让第二个实例误判无锁启动。
          for (const name of fs.readdirSync(resolved)) {
            if (name === 'qq-agent.lock') continue;
            fs.rmSync(path.join(resolved, name), { recursive: true, force: true });
          }
          const { loadConfig } = await import('./config.js');
          updateConfig(loadConfig());
          return json(res, 200, { ok: true, backupDir, message: `已重置为初始形态（原数据已备份到 ${backupDir}），请重启应用` });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 成本看板 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/usage/stats',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || url.searchParams.get('days') || '7');
          const stats = await buildUsageStats({ range: raw });
          return json(res, 200, { ok: true, range: raw, ...stats });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/usage/breakdown',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || '7');
          const dim = String(url.searchParams.get('dim') || '');
          const key = String(url.searchParams.get('key') || '');
          const by = String(url.searchParams.get('by') || '');
          const r = await buildUsageBreakdown({ range: raw, dim, key, by });
          return json(res, 200, { ok: true, ...r });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 价格表 ───────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/model-prices',
      handler: async ({ res, json, url }) => json(res, 200, {
        prices: listOfficialPrices(),
        current: resolveOfficialPrice(String(url.searchParams.get('model') || getConfig().api?.model || '')),
        remote: { ...priceFeedStatus(), url: FIXED_PRICE_FEED_URL }
      })
    },
    {
      method: 'POST', pattern: '/api/model-prices/refresh',
      handler: async ({ res, json }) => {
        const st = await refreshPriceFeed(FIXED_PRICE_FEED_URL);
        return json(res, 200, {
          ok: st.ok, remote: st,
          prices: listOfficialPrices(),
          current: resolveOfficialPrice(getConfig().api?.model || '')
        });
      }
    },

    // ── Alcor 进程管理 ────────────────────────────────────────────
    {
      // Explicit user reveal/copy only; ordinary status/config responses stay redacted.
      method: 'GET', pattern: '/api/alcor/connection',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任。' });
        try {
          const c = deps.alcorConnection();
          const panelUrl = c.httpUrl + '/panel/';
          return json(res, 200, { token: c.accessToken, httpUrl: c.httpUrl, wsUrl: c.wsUrl,
            panelUrl, panelLoginUrl: panelUrl + '#token=' + encodeURIComponent(c.accessToken) });
        } catch { return json(res, 400, { error: 'Alcor 配置暂不可用，请检查框架页的核心配置。' }); }
      }
    },
    {
      method: 'POST', pattern: '/api/alcor/access-guide/dismiss',
      handler: async ({ res, json }) => {
        updateConfig({ ui: { alcorAccessGuideSeen: true } });
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'POST', pattern: '/api/alcor/launch',
      handler: async ({ res, json }) => {
        try {
          const result = await launchAlcor();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/alcor/logs',
      handler: async ({ res, json }) => json(res, 200, { logs: alcorLogs.slice(-200) })
    },
    {
      // 首启「进程注入可行性检测」：只读探测 + 明确的自动修复动作，不改任何既有功能语义。
      method: 'GET', pattern: '/api/injection-check',
      handler: async ({ res, json }) => {
        const installRoot = path.resolve(ROOT, '../..');
        let processes = [];
        try {
          if (typeof deps.alcorManage === 'function') {
            const result = await deps.alcorManage('processes');
            processes = Array.isArray(result.body?.processes) ? result.body.processes : [];
          }
        } catch { /* 核心没跑也能查本机条件 */ }
        const result = await collectInjectionCheck({ installRoot, dataDir: DATA_DIR, processRows: processes });
        return json(res, 200, { status: 'ok', data: { ...result, text: formatInjectionReport(result) } });
      }
    },
    {
      method: 'POST', pattern: '/api/injection-check/fix',
      handler: async ({ req, res, json, readJson }) => {
        const body = await readJson(req);
        const id = String(body?.id || '');
        const installRoot = path.resolve(ROOT, '../..');
        const outcome = await runInjectionFix(id, { dataDir: DATA_DIR, installRoot });
        return json(res, outcome.ok ? 200 : 502, { status: outcome.ok ? 'ok' : 'failed', data: outcome,
          ...(outcome.ok ? {} : { wording: 'INJECTION_FIX_FAILED' }) });
      }
    },
    {
      method: 'GET', pattern: '/api/qq/diagnosis',
      handler: async ({ res, json }) => {
        const state = await deps.alcorInspect();
        const verdict = await collectQQDiagnosis(deps, { fresh: true, state });
        verdict.policy = await collectPolicy(verdict.candidate?.pid ?? verdict.connection?.pid, { lastFailure: state.connection?.lastFailure || null });
        return json(res, 200, { status: 'ok', data: { ...verdict,
          core: { running: state.running, backendReady: state.backendReady, code: state.code || null, error: state.error || '', version: state.version || '' } } });
      }
    },
    {
      method: 'POST', pattern: '/api/qq/connect',
      handler: async ({ res, json, body }) => {
        const verdict = await collectQQDiagnosis(deps, { fresh: true });
        if (verdict.backendType === 'onebot') return json(res, 409, { status: 'failed', wording: 'ONEBOT_EXTERNAL', error: '当前使用 OneBot 接入。' });
        const pid = Number(body?.pid) || verdict.candidate?.pid;
        // 宿主已经连上、只是消息通道还没确认时，这不是失败：如实回 200，让界面显示「已连接/正在确认」，
        // 否则用户会看到「连接失败」，而实际上下一次扫描就已经是已连接状态。
        if (!pid && (verdict.code === 'ALREADY_CONNECTED' || verdict.code === 'RECEIVE_NOT_READY')) {
          return json(res, 200, { status: 'ok', data: { pid: verdict.connection?.pid ?? null, connection: verdict.connection || null, note: verdict.code } });
        }
        if (!pid) return json(res, 400, { status: 'failed', wording: verdict.code, error: verdict.hint || verdict.title });
        const allowUnverified = body?.allowUnverified === true;
        const result = await deps.alcorManage('native/connect', { method: 'POST', body: { pid, ...(allowUnverified ? { allowUnverified } : {}) }, timeoutMs: 90_000 });
        const failure = result.ok ? (verdict.connection?.lastFailure || null) : { code: String(result.body?.wording || result.body?.error || 'CONNECT_FAILED'), stage: String(result.body?.stage || ''), at: new Date().toISOString() };
        verdict.policy = await collectPolicy(pid, { lastFailure: failure });
        recordConnectOutcome(verdict, result);
        if (!result.ok || result.body?.status === 'failed') {
          return json(res, 502, { status: 'failed', wording: result.body?.wording || result.body?.error || 'QQ_CONNECT_FAILED',
            error: result.body?.wording || result.body?.error || '连接 QQ 失败' });
        }
        log('info', 'qq', 'QQ 原生宿主连接请求已提交 · PID ' + pid);
        return json(res, 200, { status: 'ok', data: { pid, connection: result.body?.data || result.body || null } });
      }
    },
    {
      // 防护策略报告：HVCI / 智能应用控制 / Defender / QQ 自身缓解策略 / 权限、会话、事件核对
      method: 'GET', pattern: '/api/policy/report',
      handler: async ({ res, json, url }) => {
        const pid = Number(url.searchParams.get('pid')) || 0;
        return json(res, 200, { status: 'ok', data: await collectPolicy(pid) });
      }
    },
    {
      // 把安装目录与宿主中转目录加进 Defender 排除项（会弹一次 UAC，用户点了才执行）
      method: 'POST', pattern: '/api/policy/defender-exclusion',
      handler: async ({ res, json }) => {
        const report = await collectPolicyReport({ pid: 0, dataDir: DATA_DIR });
        const normalize = (value) => String(value || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
        const paths = [policyInstallRoot(), POLICY_PACK_ROOT].filter(Boolean);
        const existing = new Set((report?.machine?.exclusions || []).map(normalize));
        const missing = paths.filter((item) => !existing.has(normalize(item)));
        if (!missing.length) return json(res, 200, { status: 'ok', data: { added: [], already: paths } });
        const outcome = await addDefenderExclusion({ paths: missing, dataDir: DATA_DIR });
        if (!outcome.ok) return json(res, 502, { status: 'failed', wording: 'POLICY_EXCLUSION_FAILED', error: outcome.error || '添加排除项失败' });
        recordPolicyOutcome(DATA_DIR, { defenderExclusion: new Date().toISOString() });
        return json(res, 200, { status: 'ok', data: { added: outcome.added || missing } });
      }
    },
    {
      // 安装后自检：目录、运行库、崩溃标记、坏配置、补丁包目录；默认会安全自愈
      method: 'GET', pattern: '/api/preflight',
      handler: async ({ res, json, url }) => {
        const fix = url.searchParams.get('fix') !== '0';
        const result = await runPreflight({
          installRoot: path.resolve(ROOT, '../..'),
          dataDir: DATA_DIR,
          dryRun: !fix,
          logger: (line) => log('info', 'preflight', line),
        });
        return json(res, 200, { status: 'ok', data: result });
      }
    },
    {
      // 一键：启动核心 → 拉起 QQ → 重试注入 → 未适配构建走兼容模式
      method: 'POST', pattern: '/api/qq/autoconnect',
      handler: async ({ res, json, body }) => {
        const outcome = await autoConnect({ allowUnverified: body?.allowUnverified === true });
        return json(res, 200, { status: 'ok', data: outcome });
      }
    },
    {
      // 以管理员身份重启自己：权限不一致时唯一的自动出路（用户点了才执行）
      method: 'POST', pattern: '/api/app/relaunch-admin',
      handler: async ({ res, json }) => {
        try {
          const { spawn } = await import('node:child_process');
          const exe = process.execPath;
          const child = spawn('powershell.exe', ['-NoProfile', '-Command', "Start-Process -FilePath '" + exe.replace(/'/g, "''") + "' -Verb RunAs"], { windowsHide: true, detached: true, stdio: 'ignore' });
          child.unref();
          return json(res, 200, { status: 'ok', data: { relaunched: true } });
        } catch (error) {
          return json(res, 502, { status: 'failed', wording: 'RELAUNCH_FAILED', error: String(error?.message || error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/qq/restart',
      handler: async ({ res, json }) => {
        if ((await deps.alcorInspect()).backendType === 'onebot') return json(res, 409, { status: 'failed', wording: 'ONEBOT_EXTERNAL', error: '当前使用 OneBot 接入。' });
        const listProcesses = async () => {
          try { const r = await deps.alcorManage('processes'); return Array.isArray(r.body?.processes) ? r.body.processes : []; }
          catch { return []; }
        };
        const restarted = await restartQQ({ listProcesses });
        if (!restarted.ok) return json(res, 400, { status: 'failed', wording: restarted.code, error: restarted.error });
        const rows = await waitForQQ({ listProcesses });
        const verdict = await collectQQDiagnosis(deps, { fresh: true });
        log('info', 'qq', '已重启 QQ 客户端 · ' + (verdict.code || ''));
        return json(res, 200, { status: 'ok', data: { launched: restarted.launched, processes: rows.length, verdict } });
      }
    },
    {
      method: 'POST', pattern: '/api/alcor/stop',
      handler: async ({ res, json }) => {
        try {
          const stopped = await stopAlcor();
          return json(res, 200, { ok: true, stopped, embedded: alcorStatus().embedded, pid: alcorStatus().pid });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/alcor/open-folder',
      handler: async ({ res, json }) => {
        const dir = alcorDir();
        if (!dir) return json(res, 400, { ok: false, error: '找不到 Alcor 目录' });
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'POST', pattern: '/api/alcor/open-webui',
      handler: async ({ res, json }) => {
        const webuiUrl = alcorWebuiUrl();
        if (!webuiUrl) return json(res, 400, { ok: false, error: '没有找到 Alcor WebUI 地址（等日志出现 listening 后再试）' });
        spawn('explorer.exe', [deps.alcorPanelLoginUrl()], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return json(res, 200, { ok: true, webuiUrl });
      }
    },

    // ── 便携 QQ 进程管理 ─────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/qq-portable/launch',
      handler: async ({ res, json }) => {
        try {
          const result = await launchPortableQQ();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/qq-portable/stop',
      handler: async ({ res, json }) => {
        try {
          const result = await stopPortableQQ();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/qq-portable/logs',
      handler: async ({ res, json }) => json(res, 200, { logs: qqPortableLogs.slice(-200) })
    },
    {
      method: 'GET', pattern: '/api/qq-portable/status',
      handler: async ({ res, json }) => json(res, 200, await qqPortableStatus())
    },

    // ── 体检 / 引导 ──────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/onebot/groups',
      handler: async ({ res, json }) => {
        return json(res, 200, await contactChoices({ kind: 'groups', onebot, inbox, store, config: getConfig() }));
      }
    },
    {
      method: 'GET', pattern: '/api/onebot/friends',
      handler: async ({ res, json }) => {
        return json(res, 200, await contactChoices({ kind: 'friends', onebot, inbox, store, config: getConfig() }));
      }
    },

    // ── 人设模板 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/persona-templates',
      handler: async ({ res, json }) => {
        const customs = (getConfig().customPersonas || []).map((p, i) => ({
          id: `custom_${i}`, name: p.name, text: p.text, customRules: p.customRules || '', builtin: false
        }));
        return json(res, 200, { templates: customs });
      }
    },
    {
      method: 'POST', pattern: '/api/persona-templates',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const name = String(body.name ?? '').trim().slice(0, 50);
        const text = String(body.text ?? '').trim();
        if (!name || !text) return json(res, 400, { ok: false, error: '人设名称和角色设定都不能为空' });
        const entry = { name, text };
        if (String(body.customRules ?? '').trim()) entry.customRules = String(body.customRules).trim();
        const next = [...(getConfig().customPersonas || []), entry];
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true, templates: next });
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/persona-templates\/(custom_\d+)$/,
      handler: async ({ res, json, match }) => {
        const idx = Number(match[1].replace('custom_', ''));
        const next = (getConfig().customPersonas || []).filter((_, i) => i !== idx);
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true });
      }
    },

    // ── 多提供商模型目录 ─────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/providers',
      handler: async ({ res, json }) => {
        const providers = currentProviders().map((p) => ({
          id: p.id, displayName: p.displayName, baseURL: p.baseURL,
          apiKey: '', apiKeyFrom: p.apiKeyFrom || '', needsBaseUrl: p.needsBaseUrl === true,
          hasKey: !!p.apiKey, anthropicOrigin: p.anthropicOrigin === true,
          models: p.models, modelNames: p.modelNames || {}
        }));
        return json(res, 200, { providers, source: getConfig().providersSourceYaml });
      }
    },
    {
      method: 'GET', pattern: '/api/providers/key',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const pid = String(url.searchParams.get('providerId') || '');
        const p = currentProviders().find((x) => x.id === pid);
        return json(res, 200, { apiKey: p?.apiKey || '' });
      }
    },
    {
      method: 'GET', pattern: '/api/api-key',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        return json(res, 200, { apiKey: String(getConfig().api.apiKey || '') });
      }
    },
    {
      method: 'GET', pattern: '/api/search-key',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const field = String(url.searchParams.get('field') || '');
        const allowed = ['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso'];
        // 各家对应的环境变量名：Key 没存进配置但环境里有时，也算"有 Key"
        //（web-search.js 的取值优先级就是 cfg.apiKey > env），UI 的掩码/显示
        // 口径必须与之一致，否则会出现"明明能搜，Key 框却显示空"的错觉。
        const ENV_OF = {
          deepseek: 'DEEPSEEK_API_KEY',
          zhipu: 'ZHIPU_API_KEY',
          bocha: 'BOCHA_API_KEY',
          baidu: 'BAIDU_SEARCH_API_KEY',
          metaso: 'METASO_API_KEY'
        };
        if (allowed.includes(field)) {
          const fromCfg = String(getConfig().webSearch?.[field]?.apiKey || '');
          return json(res, 200, { apiKey: fromCfg, hasApiKey: Boolean(fromCfg || (ENV_OF[field] && process.env[ENV_OF[field]])) });
        }
        // 自定义搜索服务：field 形如 custom:<id>，按 id 在 providers 数组里找
        if (field.startsWith('custom:')) {
          const id = field.slice('custom:'.length);
          const entry = (getConfig().webSearch?.providers || []).find((p) => String(p.id) === id);
          const k = String(entry?.apiKey || '');
          return json(res, 200, { apiKey: k, hasApiKey: Boolean(k) });
        }
        return json(res, 400, { error: `未知搜索服务：${field}` });
      }
    },
    {
      // OneBot 令牌明文读取：控制台「显示」按钮专用（与 /api/search-key 同一套来源校验）。
      // 必须有这个端点：配置经 sanitizeConfig 脱敏后前端只拿得到掩码，
      // 用户想"看一眼现有令牌"只能走这里。
      method: 'GET', pattern: '/api/onebot-token',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const which = String(url.searchParams.get('which') || '');
        const snow = getConfig().alcor || {};
        if (which === 'ws') return json(res, 200, { token: String(snow.accessToken || '') });
        if (which === 'http') return json(res, 200, { token: String(snow.httpAccessToken || snow.accessToken || '') });
        return json(res, 400, { error: `未知令牌类型：${which}` });
      }
    },
    {
      method: 'POST', pattern: '/api/providers/fetch-models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const cfgNow = getConfig();
          const baseUrl = String(body.baseUrl || cfgNow.api.baseUrl || '');
          // Key 解析顺序（2026-09-20 修 401 高发）：显式明文 > 按 providerId 查该提供商
          // 保存的 Key（dshProviderKeys / providers[].apiKey）> 顶层 api.apiKey。
          // 旧实现只看顶层 Key —— 多提供商场景下顶层只存"当前选中那个"的 Key，
          // 从其它提供商拉列表就会拿错 Key，全部 401。
          let apiKey = '';
          if (body.apiKey !== undefined && String(body.apiKey ?? '').trim() && body.apiKey !== '******') {
            apiKey = String(body.apiKey).trim();
          } else {
            const pid = String(body.providerId ?? '').trim();
            const p = pid ? currentProviders().find((x) => x.id === pid) : null;
            apiKey = String(p?.apiKey ?? '').trim();
            if (!apiKey) apiKey = String(cfgNow.api.apiKey || '').trim();
            if (apiKey === '******') apiKey = '';
          }
          const models = await fetchModelsFrom(baseUrl, apiKey);
          return json(res, 200, { ok: true, models });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-one',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const result = await testOneProvider({
            providerId: String(body.providerId ?? ''),
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-chat',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const submitted = String(body.apiKey ?? '').trim();
          const apiKey = (submitted && submitted !== '******') ? submitted : resolveApiKey(getConfig());
          const baseUrl = String(body.baseUrl ?? '');
          const model = String(body.model ?? '');
          const result = await testModelChat({ baseUrl, apiKey, model });
          // 「思考方言」由内置方言表识别（原 thinking-adapters 插件收编进核心）。
          // 接在这里是为了让用户在"测试连通性"时就能看到这个模型会走哪套思考参数，
          // 而不是开了思考模式后默默不生效、只能去翻日志。
          let thinking = null;
          try {
            thinking = detectThinkingDialect({ baseUrl, model }) || null;
          } catch { /* 识别失败不影响连通性测试结论 */ }
          return json(res, 200, { ok: true, result: { ...result, thinking } });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const r = upsertProvider({
            baseUrl: String(body.baseUrl ?? ''), apiKey: String(body.apiKey ?? ''), models: body.models || []
          });
          return json(res, 200, { ok: true, ...r, provider: sanitizeProvider(r.provider) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const p = addModelsToProvider(String(body.providerId ?? ''), body.models || []);
          if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: '/api/providers/models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const p = removeModelFromProvider(String(body.providerId ?? ''), String(body.modelId ?? ''));
          if (!p) return json(res, 404, { ok: false, error: '提供商或模型不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/set-key',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const updated = setProviderKey(String(body.providerId ?? ''), String(body.apiKey ?? ''));
        if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
        return json(res, 200, { ok: true, hasKey: !!updated.apiKey });
      }
    },
    {
      // 删除整个提供商（含 Key 与模型目录；当前选中它时一并清空选中态）
      method: 'DELETE', pattern: '/api/providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const removed = removeProvider(String(body.providerId ?? ''));
          if (!removed) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-all',
      handler: async ({ res, json }) => {
        const results = await testAllProviders(currentProviders());
        const okCount = Object.values(results).filter((r) => r.ok).length;
        return json(res, 200, { ok: true, results, okCount, total: Object.keys(results).length });
      }
    },

    // ── 视觉能力 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/vision/results',
      handler: async ({ res, json }) => json(res, 200, {
        results: { ...builtinVisionResults(currentProviders()), ...visionResults() },
        scanning: visionScan.running
      })
    },
    {
      method: 'POST', pattern: '/api/vision/scan',
      handler: async ({ req, res, json }) => {
        if (visionScan.running) return json(res, 409, { ok: false, error: '已有一次扫描正在进行' });
        const body = await bodyOf(req);
        const onlyProviderIds = Array.isArray(body?.providerIds) ? body.providerIds.map(String) : null;
        visionScan.running = true;
        emit('vision-scan', { phase: 'start' });
        scanModelsVision({ providers: currentProviders(), emit, onlyProviderIds, timeoutMs: 25000, limit: 3 })
          .then(({ total }) => emit('vision-scan', { phase: 'done', total }))
          .catch((error) => emit('vision-scan', { phase: 'error', error: String(error?.message ?? error) }))
          .finally(() => { visionScan.running = false; });
        return json(res, 202, { ok: true, started: true });
      }
    },

    // ── 搜索服务：内置服务清单与真实可用性测试 ────────────────────────
    {
      method: 'GET', pattern: '/api/search/providers',
      handler: async ({ res, json }) => {
        const cfg = getConfig().webSearch ?? {};
        const customs = (cfg.providers || []).map((p) => ({
          id: `custom:${p.id}`, label: String(p.name || p.baseUrl || '自定义搜索'), needsKey: p.type !== 'bing',
          hasKey: Boolean(String(p.apiKey || '').trim())
        }));
        const builtins = SEARCH_PROVIDER_META.map((p) => ({
          id: p.id, label: p.label, needsKey: p.needsKey !== false,
          hasKey: p.keyField
            ? Boolean(String(cfg[p.keyField]?.apiKey || '').trim())
              // DeepSeek 搜索会复用主模型 Key（web-search.js 里的 mainKey 回退），这里要跟着显示已配置
              || (p.id === 'deepseek' && /deepseek/i.test(String(getConfig().api?.baseUrl || '')) && Boolean(String(getConfig().api?.apiKey || '').trim()))
            : true,
          // DeepSeek 走 Responses API，只回模型总结、拿不到来源；标出来免得误判成「能搜网页」。
          note: p.id === 'deepseek' ? '只返回模型总结，不含来源链接' : ''
        }));
        return json(res, 200, { current: String(cfg.provider || 'bing'), enabled: cfg.enabled !== false, services: [...builtins, ...customs] });
      }
    },
    {
      method: 'POST', pattern: '/api/search/test',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const provider = String(body.provider ?? getConfig().webSearch?.provider ?? 'bing').trim() || 'bing';
          const result = await testSearchProvider(provider, String(body.query ?? '').trim() || '今天的新闻');
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    // ── 自定义搜索提供商 ─────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/search-providers',
      handler: async ({ res, json }) => {
        const list = (getConfig().webSearch?.providers || []).map((p) => ({
          id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, model: p.model,
          count: p.count, timeoutMs: p.timeoutMs, hasApiKey: Boolean(String(p.apiKey || '').trim())
        }));
        return json(res, 200, { providers: list });
      }
    },
    {
      method: 'POST', pattern: '/api/search-providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const baseUrl = String(body.baseUrl ?? '').trim();
          const type = String(body.type ?? 'openai').trim() === 'bing' ? 'bing' : 'openai';
          if (!baseUrl) return json(res, 400, { ok: false, error: '接口地址不能为空' });
          const list = [...(getConfig().webSearch?.providers || [])];
          const existing = list.find((p) => p.baseUrl === baseUrl && p.type === type);
          let entry;
          if (existing) {
            existing.name = String(body.name ?? existing.name ?? '').trim() || existing.name;
            existing.baseUrl = baseUrl;
            existing.type = type;
            existing.model = String(body.model ?? existing.model ?? '').trim();
            existing.count = Math.min(20, Math.max(1, Number(body.count) || existing.count || 6));
            existing.timeoutMs = Math.max(5000, Number(body.timeoutMs) || existing.timeoutMs || 20000);
            // apiKey 语义（与「清除密钥」按钮配套）：
            //   undefined / '******' → 不动（保持原 Key）
            //   非空字符串           → 覆盖为新 Key
            //   ''（显式空串）        → 清除
            if (body.apiKey === undefined) {
              /* 未提交：保持原值 */
            } else if (String(body.apiKey) === '******') {
              /* 掩码回传：保持原值 */
            } else {
              existing.apiKey = String(body.apiKey).trim();
            }
            entry = existing;
          } else {
            entry = {
              id: `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              name: String(body.name ?? '').trim() || baseUrl,
              type, baseUrl,
              apiKey: String(body.apiKey ?? '').trim() === '******' ? '' : String(body.apiKey ?? '').trim(),
              model: String(body.model ?? '').trim(),
              count: Math.min(20, Math.max(1, Number(body.count) || 6)),
              timeoutMs: Math.max(5000, Number(body.timeoutMs) || 20000)
            };
            list.push(entry);
          }
          updateConfig({ webSearch: { providers: list } });
          return json(res, 200, { ok: true, provider: { ...entry, apiKey: '', hasApiKey: Boolean(String(entry.apiKey || '').trim()) } });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: '/api/search-providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const id = String(body.id ?? '').trim();
          if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
          const list = (getConfig().webSearch?.providers || []).filter((p) => String(p.id) !== id);
          updateConfig({ webSearch: { providers: list } });
          const cur = String(getConfig().webSearch?.provider || '');
          if (cur === `custom:${id}`) updateConfig({ webSearch: { provider: 'bing' } });
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/search-providers/test',
      handler: async ({ req, res, json }) => {
        const startedAt = Date.now();
        try {
          const body = await bodyOf(req);
          const provId = String(body.providerId ?? '').trim();
          const r = await customSearch('qq agent 测试', provId || null);
          return json(res, 200, { ok: true, result: { ok: true, count: r.results.length, sample: r.results[0]?.title || '', latencyMs: Date.now() - startedAt } });
        } catch (error) {
          return json(res, 200, { ok: true, result: { ok: false, note: String(error?.message ?? error), latencyMs: Date.now() - startedAt } });
        }
      }
    },

    // ── 连通性测试 ───────────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/test/api',
      handler: async ({ res, json }) => {
        const startedAt = Date.now();
        try {
          const r = await chatCompletion({ messages: [{ role: 'user', content: '请只回复两个字符：pong' }], tools: null, temperature: 0 });
          const reply = typeof r.message.content === 'string' ? r.message.content.slice(0, 100) : '';
          return json(res, 200, { ok: true, model: r.model, reply, latencyMs: Date.now() - startedAt });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), latencyMs: Date.now() - startedAt });
        }
      }
    },

    // ── 配置 ─────────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/config',
      handler: async ({ res, json }) => json(res, 200, sanitizeConfig(getConfig()))
    },
    {
      // 完整系统提示词预览：按**当前**插件/技能/工具启用状态组装（没开的不出现），
      // 供设置-工具与技能页和技能页右侧预览共用。走后端而不是前端拼：组装逻辑
      // 就是运行时的 buildSystemPrompt + getToolAvailability，前端另写一份迟早漂移。
      // 注意 skillContext 与 orchestrator 同构（visionEnabled/searchEnabled/toolsCfg），
      // 否则预览和实际运行的口径会分裂。
      //
      // POST + 可选 overrides：前端自动保存有 600ms 防抖，用户刚点的开关还没落盘；
      // 调用方把"当前工具面板状态"随请求发来，这里先 deepMerge 到临时副本上组装
      // （绝不写回 currentConfig），预览就能立即反映未保存的开关。
      method: '*', pattern: '/api/prompt-preview',
      handler: async ({ req, res, json }) => {
        const cfg = getConfig();
        let overrides = {};
        try {
          if (req.method === 'POST') overrides = (await bodyOf(req)) || {};
        } catch { overrides = {}; }
        const effective = Object.keys(overrides).length
          ? deepMergeConfig(structuredClone(cfg), structuredClone(overrides))
          : cfg;
        const skillContext = {
          skills: skillManager,
          toolsCfg: effective.tools || {},
          visionEnabled: effective.api?.vision !== false
            && modelImageVerdict(effective.api?.provider, effective.api?.model) !== 'no-vision',
          searchEnabled: effective.webSearch?.enabled !== false,
          runtimeContext: { model: effective.api?.model || '', provider: effective.api?.provider || '', source: 'api' }
        };
        const { buildSystemPrompt } = await import('./prompt.js');
        const { buildToolDefs } = await import('./tools.js');
        const { getToolAvailability } = await import('./tool-registry.js');
        // 可用工具清单与 orchestrator 同一口径（tools.js 的 def → OpenAI 函数名）
        const tools = buildToolDefs()
          .filter((d) => getToolAvailability(d.id, skillContext).enabled)
          .map((d) => ({ id: d.id, name: d.name, description: d.description, category: d.category }));
        return json(res, 200, {
          // 预览要能反映「还没保存的人设」：把合并后的 persona 一起传进去，
          // 否则空人设 / 新人设都预览成当前已保存的文本。
          systemPrompt: buildSystemPrompt({ skillContext, persona: effective.persona }),
          tools
        });
      }
    },
    {
      method: 'GET', pattern: '/api/community/blocklist',
      handler: async ({ res, json }) => json(res, 200, { ok: true, ids: getGlobalBlocklist() })
    },
    {
      method: 'POST', pattern: '/api/community/blocklist',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids : [];
        try {
          const { ids: actual, warning } = await updateGlobalBlocklist(ids, { mode: String(body?.mode || 'replace') });
          emit('status', { communityBlocklistUpdated: true });
          return json(res, 200, { ok: true, ids: actual, warning: warning || '' });
        } catch (error) {
          return json(res, 502, { ok: false, error: `云端屏蔽名单更新失败：${String(error?.message ?? error)}` });
        }
      }
    },

    // ── 社区市场：口令安装 ──────────────────────────────
    {
      // 口令批量校验：body { codes: [...] } → 每个口令的条目摘要
      method: 'POST', pattern: '/api/market/verify',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const codes = (Array.isArray(body?.codes) ? body.codes : [body?.code])
          .map((c) => String(c ?? '').trim().toUpperCase())
          .filter((c) => /^[A-Z0-9]{1,32}$/.test(c))
          .slice(0, 30);
        if (!codes.length) return json(res, 400, { ok: false, error: '没有有效的口令' });
        try {
          const results = await verifyInstallCodes(codes);
          return json(res, 200, { ok: true, results });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 口令安装：body { code, entry }（entry = verify 阶段拿到的条目，含服务器判定的 type）。
      // 类型路由由服务器 entry.type 决定：技能页输插件口令也会装进 plugins/。
      method: 'POST', pattern: '/api/market/install',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const code = String(body?.code || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{4,12}$/.test(code)) return json(res, 400, { ok: false, error: '口令格式无效' });
        try {
          const r = await installByCode({ code, verified: body?.entry || null });
          // 安装完立即重扫，让新模块马上出现在页签里（热重载 watcher 也行，
          // 但目录删除重建的场景 watcher 会丢事件 —— reload 是唯一可靠路径）
          try { await reloadSkills({ reason: 'market-install' }); } catch { /* 重扫失败不影响安装结果 */ }
          return json(res, 200, { ok: true, kind: r.kind, id: r.id, dir: r.dir });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── Skill 管理 ─────────────────────────────────────────────────────
    // 统一开关入口：前端只改这里，模块内部一律读 skillManager。
    {
      method: 'GET', pattern: '/api/skills',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        // uninstalled：配置里还有 skills.<id> 段、但磁盘上已经没有这个条目
        // （删目录后的配置残留）。UI 显示成"已配置但未安装"，并提供一键清理。
        const installedIds = new Set(skillManager.list(context).map((s) => s.id));
        const uninstalled = listConfiguredSkillIds()
          .filter((id) => !installedIds.has(id))
          .map((id) => {
            const c = getConfig()?.skills?.[id] || {};
            return {
              id,
              enabled: c.enabled !== false,
              hasSettings: Object.keys(c).some((k) => k !== 'enabled')
            };
          });
        return json(res, 200, {
          skills: skillManager.list(context),
          summary: skillManager.summary(context),
          capabilities: skillManager.capabilities.list().sort(),
          uninstalled
        });
      }
    },
    {
      // 手动重扫磁盘：UI「刷新」按钮的后端动作。
      // 之前刷新只读内存注册表，watcher 丢事件（目录删除重建 / 网络盘 / 杀软）
      // 时新插件永远进不来。这里走 app.reloadSkills()：重扫 + 激活 + 刷工具 + 重建 watcher。
      method: 'POST', pattern: '/api/skills/reload',
      handler: async ({ res, json }) => {
        if (typeof reloadSkills !== 'function') {
          return json(res, 500, { ok: false, error: '核心未提供 reloadSkills（请升级或检查启动方式）' });
        }
        try {
          const result = await reloadSkills({ reason: 'manual' });
          const context = skillRuntimeContext();
          return json(res, 200, {
            ok: true,
            loaded: result.loaded.map((r) => r.id),
            failed: result.failed.map((r) => ({ id: r.id, error: r.error })),
            pruned: result.pruned,
            skills: skillManager.list(context),
            summary: skillManager.summary(context),
            capabilities: skillManager.capabilities.list().sort()
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: `重扫失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 清理"已配置但未安装"的残留配置段：删掉 config.skills.<id>。
      // body: { ids: [id...] }，只删传入的 id，且要求该 id 当前确实不在注册表里
      //（防止把正在运行的 Skill 配置误删）。
      method: 'POST', pattern: '/api/skills/cleanup',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
        if (!ids.length) return json(res, 400, { ok: false, error: '缺少 ids' });
        const installed = new Set(skillManager.list().map((s) => s.id));
        const removable = ids.filter((id) => !installed.has(id));
        if (!removable.length) {
          return json(res, 400, { ok: false, error: '没有可清理的条目（都处于已安装状态）' });
        }
        const skillsCfg = getConfig()?.skills || {};
        const next = { ...skillsCfg };
        for (const id of removable) delete next[id];
        // deepMerge 传 {} 删不掉已有键，必须用 __replace__ 整体替换
        updateConfig({ skills: { __replace__: next } });
        emit('status', { configUpdated: true });
        return json(res, 200, {
          ok: true,
          removed: removable,
          skipped: ids.filter((id) => installed.has(id)),
          config: sanitizeConfig(getConfig())
        });
      }
    },
    {
      // 单个 Skill：切开关 / 改设置。两个动作分开处理，避免"改了设置顺手把我开着的关了"。
      method: 'POST', pattern: /^\/api\/skills\/([^/]+)$/,
      handler: async ({ req, res, json, match }) => {
        const id = decodeURIComponent(match[1]);
        const body = await bodyOf(req);
        const context = skillRuntimeContext();
        const skill = skillManager.registry.get(id);
        if (!skill) return json(res, 404, { ok: false, error: `Skill 不存在：${id}` });

        // 1) 开关（先写配置，再跑生命周期；顺序不能反 ——
        //    activate 里读配置必须已经生效，否则 Skill 会以为自己是关闭的）
        if (body.enabled !== undefined) {
          setSkillEnabled(id, !!body.enabled);
          if (body.enabled) skillManager.activate(id, context);
          else skillManager.deactivate(id, context);
        }

        // 2) 设置（只允许改 manifest 声明过的键，防止前端塞垃圾字段进配置）
        if (body.settings && typeof body.settings === 'object') {
          const allowed = new Set([
            ...Object.keys(skill.manifest.settings || {}),
            ...Object.keys(skill.manifest.configSchema || {})
          ]);
          const schema = skill.manifest.configSchema || {};
          const current = getSkillConfig(id, skill.manifest.settings || {});
          const patch = {};
          // ⚠️ 与 settingsView 同一套口径（2026-09-26 审查二轮）：
          //    ① secret 标记；② 字段名命中 /key|token|secret|password|cookie/i 的
          //    字符串字段（web-fetch 的 cookie 没有 secret 标记也属密文）。
          //    收到掩码 '******' 或空串 = "不修改" —— 否则用户只是打开表单点了
          //    保存，Cookie/Key 就被覆盖成六个星号。
          const SECRET_NAME_RE = /key|token|secret|password|cookie/i;
          const isSecretField = (k) => Boolean(schema[k]?.secret)
            || (SECRET_NAME_RE.test(k) && typeof current[k] === 'string');
          for (const [k, v] of Object.entries(body.settings)) {
            if (!allowed.has(k)) continue;
            if (isSecretField(k) && (v === '******' || String(v ?? '').trim() === '')) continue;
            patch[k] = v;
          }
          if (Object.keys(patch).length) setSkillConfig(id, patch);
        }

        emit('status', { configUpdated: true });
        return json(res, 200, {
          ok: true,
          skill: skillManager.status(id, context),
          // ⚠️ 响应里的 settings 必须用脱敏视图（settingsView）：
          //    曾经直接回 getSkillConfig（明文），保存一次设置就把
          //    apiKey / Cookie 原文发回浏览器，与 GET 列表的脱敏口径相反。
          settings: skillManager.settingsView(id),
          config: sanitizeConfig(getConfig())
        });
      }
    },
    {
      // 开关配置总览：给设置页渲染"技能"区块
      method: 'GET', pattern: '/api/skills/capabilities',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const caps = skillManager.capabilities.list().sort();
        return json(res, 200, {
          capabilities: caps.map((c) => ({
            name: c,
            ...skillManager.explainCapability(c, context)
          }))
        });
      }
    },
    {
      // 工具可用性总览：明确告诉 UI "这个工具为什么没生效"
      method: 'GET', pattern: '/api/tools/availability',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const availability = availabilityOf(context);
        const defs = new Map(listTools().map((t) => [t.id, t]));
        return json(res, 200, {
          categories: CATEGORY_META,
          tools: availability.map((a) => ({
            id: a.id,
            category: defs.get(a.id)?.category || 'system',
            skillId: a.skillId,
            enabled: a.enabled,
            code: a.code,
            reason: a.reason
          }))
        });
      }
    },


    {
      method: 'POST', pattern: '/api/config',
      handler: async ({ req, res, json }) => {
        const patch = await readBody(req);
        const next = updateConfig(patch);
        store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 0);
        sessions?.setKeepFiles?.(next.store?.keepSessionFiles ?? 0);
        if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
        initPriceFeed(FIXED_PRICE_FEED_URL);
        emit('status', { configUpdated: true });
        // ⚠️ 必须脱敏：updateConfig 返回的是内存里的活配置对象，含明文 apiKey /
        //    accessToken / dshProviderKeys。GET /api/config 一直是脱敏的，
        //    这里漏掉会让"任何一次保存设置"把全部明文密钥回传给浏览器。
        return json(res, 200, { ok: true, config: sanitizeConfig(next) });
      }
    },
    {
      method: 'GET', pattern: '/api/tools',
      handler: async ({ res, json }) => {
        const { listTools } = await import('./tool-registry.js');
        const tools = listTools().map((t) => ({
          id: t.id, name: t.name, description: t.description, category: t.category,
          icon: t.icon, defaultEnabled: t.defaultEnabled, requiresVision: t.requiresVision, requiresSearch: t.requiresSearch,
          // 来源标记：属于哪个 Skill（内置工具为 null）—— UI 据此打「skill」标识，
          // 并在所属技能失活时把工具整组隐藏（与提示词口径一致）。
          skillId: t.skillId ?? null
        }));
        return json(res, 200, { tools });
      }
    },

    // ── 版本 / 更新 ──────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/version',
      handler: async ({ res, json }) => {
        const projectUrl = releaseProjectUrl();
        return json(res, 200, { version: localVersion(), ...(projectUrl && { projectUrl }) });
      }
    },
    {
      method: 'GET', pattern: '/api/update-source',
      handler: async ({ res, json }) => json(res, 200, readUpdateSource())
    },
    {
      method: 'POST', pattern: '/api/update-source',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const saved = writeUpdateSource(body && body.url ? body.url : '');
          log('info', 'update', 'Update source saved: ' + (saved.url || 'cleared'));
          return json(res, 200, saved);
        } catch (error) {
          const code = /^[A-Z_]+$/.test(error && error.message ? error.message : '') ? error.message : 'UPDATE_SOURCE_INVALID';
          return json(res, 400, { status: 'failed', retcode: 400, data: null, wording: code });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/update-status',
      handler: async ({ res, json }) => json(res, 200, updateState())
    },
    {
      method: 'POST', pattern: '/api/update-download',
      handler: async ({ res, json }) => {
        try {
          const state = await downloadUpdate();
          return json(res, 200, { status: 'ok', data: { latest: state.latest, bytes: state.readyBytes, path: state.readyPath } });
        } catch (error) {
          const code = String(error?.code || '').match(/^[A-Z_]+$/) ? String(error.code) : 'UPDATE_DOWNLOAD_FAILED';
          return json(res, 502, { status: 'failed', retcode: 502, data: null, wording: code });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/update-dismiss',
      handler: async ({ res, json }) => {
        // 本次启动不再提示这个版本；进程重启后 dismissedLatest 归零，同一版本会再提示。
        return json(res, 200, { status: 'ok', data: dismissUpdate() });
      }
    },
    {
      method: 'POST', pattern: '/api/update-install',
      handler: async ({ res, json }) => {
        try {
          const result = installUpdate({ onQuit: () => deps.quitForUpdate?.() });
          return json(res, 200, { status: 'ok', data: result });
        } catch (error) {
          const code = String(error?.code || '').match(/^[A-Z_]+$/) ? String(error.code) : 'UPDATE_INSTALL_FAILED';
          return json(res, 400, { status: 'failed', retcode: 400, data: null, wording: code });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/update-repair',
      handler: async ({ res, json }) => {
        // 下载装不上时的兜底：让已配置的模型给出候选直链，仍用清单哈希校验。
        try {
          const state = await repairUpdate();
          return json(res, 200, { status: 'ok', data: { latest: state.latest, bytes: state.readyBytes, path: state.readyPath, note: state.repairNote || '' } });
        } catch (error) {
          const code = String(error?.code || '').match(/^[A-Z_]+$/) ? String(error.code) : 'UPDATE_REPAIR_FAILED';
          return json(res, 502, { status: 'failed', retcode: 502, data: null, wording: code });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/update-check',
      handler: async ({ res, json }) => {
        // 必须走 checkForUpdate：它会把结果写回 update-manager 的 state，
        // 否则设置页轮询的 /api/update-status 还停留在启动时那次失败上。
        return json(res, 200, await checkForUpdate({ current: localVersion(), standard: deps.standard === true }));
      }
    },

    // ── 模型 / 会话 / 存档 ───────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/models',
      handler: async ({ res, json }) => {
        try {
          const models = await listModels();
          return json(res, 200, { models });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/sessions',
      handler: async ({ res, json, url }) => {
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        return json(res, 200, { sessions: sessions.listSummaries(limit), inbox: inbox?.listChats() || [] });
      }
    },
    {
      method: 'GET', pattern: /^\/api\/inbox\/(group|private)_(\d+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const messages = (inbox?.forChat(chatKey) || []).map(message => {
          if (!message.media) return message;
          const media = message.media.map(({ file, url, ...item }) => ({
            ...item, ...(item.kind === 'image' ? { preview: Boolean(file || url) } : {})
          }));
          return { ...message, media };
        });
        return json(res, 200, { chatKey, messages });
      }
    },
    {
      method: 'GET', pattern: /^\/api\/sessions\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const s = sessions.get(match[1]);
        if (!s) return json(res, 404, { error: '会话不存在' });
        return json(res, 200, s);
      }
    },
    {
      // 主动删除一条会话记录（正在运行的不能删）
      method: 'DELETE', pattern: /^\/api\/sessions\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const removed = sessions.remove(match[1]);
        if (!removed) return json(res, 409, { ok: false, error: '会话不存在或正在运行（运行中的会话不能删除）' });
        emit('session-end', { sessionId: match[1], status: 'deleted' });
        return json(res, 200, { ok: true });
      }
    },
    {
      // 清空全部已结束的会话记录（保留运行中/等待中的）
      method: 'POST', pattern: '/api/sessions/clear-finished',
      handler: async ({ res, json }) => {
        const removed = sessions.clearFinished();
        emit('session-end', { status: 'cleared', removed });
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      // 清空「最近收件」列表（会话页「清空近期聊天」用；不影响运行中的会话）
      method: 'POST', pattern: '/api/inbox/clear',
      handler: async ({ res, json }) => {
        const removed = inbox?.clear?.() ?? 0;
        emit('inbox-update', { cleared: removed });
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      // 清空「近期记忆」（会话页清空后的可选二次清理）：默认清掉最近收件涉及的那些会话，
      // 传 chatKeys 则只清指定的会话；删的是这些会话的印象与摘要，未列出的会话不受影响。
      method: 'POST', pattern: '/api/memory/clear-recent',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          // 传了 chatKeys 就只按它来（哪怕是空数组）；没传才回落到最近收件涉及的那些会话。
          // 早前用 wanted.length 判断，空数组会被当成「没传」，等于把所有会话的记忆都清了。
          const provided = Array.isArray(body.chatKeys);
          const wanted = provided ? body.chatKeys.map(String).filter(Boolean) : [];
          const targets = provided ? wanted : (inbox?.listChats?.() || []).map((c) => c.chatKey || c.key || c.id).filter(Boolean);
          let removed = 0;
          for (const key of new Set(targets)) {
            try { if (memory.removeChat(key)) removed += 1; } catch { /* 单个会话失败不影响其他 */ }
          }
          return json(res, 200, { ok: true, chats: removed, asked: targets.length });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 手动重试一条失败的会话：把触发批翻回未读并立即唤醒（会话页「重试」按钮）。
      // 只有 error 状态且未发出过消息的会话允许重试（已发言的重试 = 群里看到两遍）。
      method: 'POST', pattern: /^\/api\/sessions\/([\w-]+)\/retry$/,
      handler: async ({ res, json, match }) => {
        const r = orchestrator.retrySession(match[1]);
        if (!r.ok) return json(res, 409, { ok: false, error: r.reason });
        return json(res, 200, { ok: true, restored: r.restored });
      }
    },
    {
      // 中止一个运行中/等待中的会话（会话页「中止」按钮）。
      // 运行中的会话在下一轮 LLM 请求前安全收尾（不截断途中的请求/发送）；
      // 等待中的会话直接干净消失。不在两种状态之一（如已结束）则拒绝。
      method: 'POST', pattern: /^\/api\/sessions\/([\w-]+)\/abort$/,
      handler: async ({ res, json, match }) => {
        const r = orchestrator.abortSession(match[1]);
        if (!r.ok) return json(res, 409, { ok: false, error: r.reason });
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'GET', pattern: '/api/chats',
      handler: async ({ res, json, url }) => {
        const keys = new Set(store.listChats());
        const includeAllowed = url.searchParams.get('includeAllowed') === '1';
        if (includeAllowed) {
          const config = getConfig();
          for (const [kind, entries] of [['group', config.allow?.groups], ['private', config.allow?.private]]) {
            for (const id of entries || []) {
              if (/^[1-9]\d{0,9}$/.test(String(id)) && chatAllowed(kind, id, config)) keys.add(`${kind}:${id}`);
            }
          }
        }
        const chats = [...keys].map((key) => ({ key, ...store.getChatMeta(key) }))
          .sort((a, b) => b.lastTs - a.lastTs);
        await Promise.allSettled(chats.map(async (c) => {
          const m = /^group:(\d+)$/.exec(String(c.key || ''));
          if (!m || (includeAllowed && !c.total)) { c.chatName = ''; return; }
          try {
            c.chatName = await Promise.race([
              orchestrator.getChatName(m[1]),
              new Promise((r) => setTimeout(() => r(''), 3000))
            ]) || '';
          } catch { c.chatName = ''; }
        }));
        return json(res, 200, { chats });
      }
    },

    // ── 记忆 ─────────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/memory-files',
      handler: async ({ res, json }) => {
        const files = memory.listChats().map((chatKey) => {
          const members = memory.members(chatKey);
          const impressionCount = members.reduce((n, m) => n + m.impressions.length, 0);
          return {
            chatKey, impressionCount, memberCount: members.length,
            updatedAt: Math.max(0, ...members.map((m) => Number(m.updatedAt) || 0))
          };
        });
        const seen = new Set(files.map((f) => f.chatKey));
        for (const gid of (getConfig().allow?.groups || [])) {
          const key = `group:${String(gid)}`;
          if (!seen.has(key)) files.push({ chatKey: key, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false });
        }
        for (const uid of (getConfig().allow?.private || [])) {
          const key = `private:${String(uid)}`;
          if (!seen.has(key)) files.push({ chatKey: key, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false });
        }
        const busy = orchestrator.consolidating;
        for (const f of files) f.consolidating = busy.has(f.chatKey);
        files.sort((a, b) => b.updatedAt - a.updatedAt);
        return json(res, 200, { files, consolidating: [...busy] });
      }
    },
    {
      method: 'GET', pattern: /^\/api\/memory-files\/(group|private)_(\d+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        return json(res, 200, { ...memory.query(chatKey), members: memory.members(chatKey) });
      }
    },
    {
      method: 'PUT', pattern: /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/,
      handler: async ({ req, res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const body = await bodyOf(req);
        try {
          const member = memory.editMemberImpression(chatKey, {
            userId: match[3],
            name: String(body.name ?? ''),
            note: body.note ?? '',
            impressions: body.impressions ?? []
          });
          emit('memory-update', { chatKey });
          return json(res, 200, { ok: true, member });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        memory.removeMember(chatKey, match[3]);
        emit('memory-update', { chatKey });
        return json(res, 200, { ok: true });
      }
    },
    {
      // 删除整个会话的记忆（记忆页「删除本会话记忆」按钮）
      method: 'DELETE', pattern: /^\/api\/memory-files\/(group|private)_(\d+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        memory.removeChat(chatKey);
        emit('memory-update', { chatKey });
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'POST', pattern: '/api/memory-files/consolidate',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const chatKey = String(body.chatKey || '');
          if (!/^(group|private):\d+$/.test(chatKey)) return json(res, 400, { ok: false, error: 'chatKey 格式错误' });
          let userIds = null;
          if (body.userIds != null) {
            const arr = Array.isArray(body.userIds) ? body.userIds : [body.userIds];
            userIds = arr.map((u) => String(u ?? '').trim()).filter((u) => /^\d{1,15}$/.test(u));
            if (!userIds.length) return json(res, 400, { ok: false, error: 'userIds 需为 QQ 号数组' });
          }
          const force = body.force !== false;
          if (orchestrator.consolidating.has(chatKey)) return json(res, 409, { ok: false, error: '该群已在整理中' });
          orchestrator.consolidating.add(chatKey);
          emit('memory-update', { chatKey, phase: 'consolidate-start', userIds });
          orchestrator.consolidateMemoryForChat(chatKey, { userIds, force })
            .then((result) => emit('memory-update', { chatKey, phase: 'consolidate-done', ...(result || {}) }))
            .catch((error) => emit('memory-update', { chatKey, phase: 'consolidate-error', error: String(error?.message ?? error) }))
            .finally(() => orchestrator.consolidating.delete(chatKey));
          return json(res, 202, { ok: true, started: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 存档消息 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: /^\/api\/chats\/(group|private)_(\d+)\/messages$/,
      handler: async ({ res, json, url, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        const messages = store.recent(chatKey, { limit }).map((m) => ({
          id: m.id, mid: m.mid, ts: m.ts, senderId: m.senderId, senderName: m.senderName,
          text: m.reply?.mid != null ? renderReplyPreview(m.reply) + (m.text ? `\n${m.text}` : '') : m.text,
          self: m.self, read: m.read, reply: m.reply, media: m.media || [], recalled: m.recalled === true,
          ...(m.delivery === 'unknown' && { delivery: 'unknown' }),
          ...(m.recallUnconfirmed && { recallUnconfirmed: true })
        }));
        return json(res, 200, { chatKey, selfId: store.activeAccount, messages });
      }
    },
    {
      method: 'POST', pattern: '/api/media-data',
      handler: async ({ req, res, json }) => {
        try {
          const body = await readBody(req);
          const items = Array.isArray(body?.items) ? body.items.slice(0, 20) : [];
          const mimeOf = (p) => /\.png$/i.test(p) ? 'image/png' : /\.gif$/i.test(p) ? 'image/gif' : /\.webp$/i.test(p) ? 'image/webp' : 'image/jpeg';
          const fileToDataUrl = (fp) => {
            const st = fs.statSync(fp);
            if (st.size > 15 * 1024 * 1024) return null;
            return `data:${mimeOf(fp)};base64,${fs.readFileSync(fp).toString('base64')}`;
          };
          // 下载一律走 safe-fetch：这里的 url 来自请求体（前端/任何本机进程都能构造），
          // 直接 fetch 等于给了一个"让本机去抓内网"的 SSRF 入口。
          const safeToDataUrl = async (rawUrl) => {
            const { buffer, contentType } = await safeFetchBinary(String(rawUrl), 15 * 1024 * 1024, { browseLocked: browseLockState().enabled });
            if (!buffer?.length || buffer.length > 15 * 1024 * 1024) return null;
            const type = String(contentType || 'image/jpeg').split(';')[0].trim();
            if (!/^image\//i.test(type)) return null;
            return `data:${type};base64,${buffer.toString('base64')}`;
          };
          const results = [];
          for (const it of items) {
            let dataUrl = null;
            if (it?.receiptId != null) {
              const item = typeof it.receiptId === 'string' && Number.isInteger(it.index) && it.index >= 0
                ? inbox?.mediaAt(it.receiptId, it.index)
                : null;
              if (item?.kind === 'image') {
                try {
                  const { buffer, contentType } = await fetchMessageImage(onebot, item, { browseLocked: browseLockState().enabled });
                  dataUrl = `data:${contentType};base64,${buffer.toString('base64')}`;
                } catch { /* 收件保留，前端可重试 */ }
              }
              results.push(dataUrl ? { dataUrl } : null);
              continue;
            }
            try {
              const ret = await onebot.call('get_image', { file: String(it?.file || '') });
              if (ret?.file && fs.existsSync(String(ret.file))) dataUrl = fileToDataUrl(String(ret.file));
              if (!dataUrl && ret?.url) dataUrl = await safeToDataUrl(ret.url);
            } catch { /* 缓存没有 / 地址不可信就走下一条 */ }
            if (!dataUrl && it?.url) {
              try { dataUrl = await safeToDataUrl(it.url); } catch { /* 过期或不可信就放弃 */ }
            }
            results.push(dataUrl ? { dataUrl } : null);
          }
          return json(res, 200, { ok: true, results });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), results: [] });
        }
      }
    },

    // ── 群成员 / 会话控制 ────────────────────────────────────────────
    {
      method: 'GET', pattern: /^\/api\/groups\/(\d+)\/members$/,
      handler: async ({ res, json, match }) => {
        try {
          const list = await onebot.call('get_group_member_list', { group_id: Number(match[1]) });
          const members = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((m) => ({ userId: String(m.user_id), nickname: String(m.nickname || ''), card: String(m.card || '') }))
            .sort((a, b) => String(a.card || a.nickname).localeCompare(String(b.card || b.nickname), 'zh-CN'));
          return json(res, 200, { members });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/wake$/,
      handler: async ({ res, json }) => json(res, 410, { error: '已移除：不触发的消息现在会立即标为已读，无需手动唤醒' })
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/test-send$/,
      handler: async ({ req, res, json, match }) => {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: '消息内容为空' });
        const kind = match[1];
        const id = match[2];
        if (!chatAllowed(kind, id, getConfig())) {
          return json(res, 403, { error: '该会话不在白名单内，不能发送（先在设置里加白名单，或开启空白名单放行）' });
        }
        const selfId = onebot.selfId;
        if (!onebot.connected || !selfId || store.activeAccount !== selfId) {
          return json(res, 409, { error: '请先连接聊天后端并确认账号。' });
        }
        const chatKey = `${kind}:${id}`;
        let data;
        try {
          data = await onebot.sendText(kind, id, text, { expected_self_id: selfId });
        } catch (error) {
          if (error?.delivery === 'unknown') {
            return json(res, 502, { error: `送达状态未知，请先在收件端核对。\n${error.message}`,
              delivery: 'unknown', nonretryable: true });
          }
          return json(res, 502, { error: String(error?.message ?? error) });
        }
        const receipt = { ok: true, messageId: data.message_id };
        if (store.activeAccount !== selfId || onebot.selfId !== selfId) {
          return json(res, 200, { ...receipt, archived: false, warning: '已取得发送回执，账号已切换，本条未写入当前会话。' });
        }
        try {
          store.appendSelf(chatKey, { selfId, text, ts: Date.now(), mid: receipt.messageId });
        } catch {
          return json(res, 200, { ...receipt, archived: false, warning: '已取得发送回执，本地存档写入失败，请勿重发。' });
        }
        try { emit('chat-update', chatKey); }
        catch { return json(res, 200, { ...receipt, archived: true, warning: '已取得发送回执并存档，请刷新会话查看。' }); }
        return json(res, 200, receipt);
      }
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/mark-read$/,
      handler: async ({ res, json, match }) => json(res, 200, { ok: true, marked: store.drainUnread(`${match[1]}:${match[2]}`).length })
    },
    {
      // 清空某会话的全部消息（整体清除存档）
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/clear$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const removed = store.clearChat(chatKey);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      // 仅屏蔽（不删除）：把某会话全部未读标记为已读，不再触发回复
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/mute$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const marked = store.muteUnread(chatKey);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, marked });
      }
    },
    {
      // 部分清除：删除指定本地 id 的消息
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/delete-messages$/,
      handler: async ({ req, res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter((n) => Number.isFinite(n)) : [];
        if (!ids.length) return json(res, 400, { ok: false, error: '缺少要删除的消息 id 列表（ids）' });
        const removed = store.removeByLocalIds(chatKey, ids);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      method: 'POST', pattern: '/api/pause',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req);
        const wasPaused = orchestrator.paused;
        orchestrator.setPaused(!!body.paused);
        updateConfig({ server: { startPaused: !!body.paused } });
        if (wasPaused && !orchestrator.paused && !body.skipBacklog) orchestrator.drainBacklogAfterResume();
        return json(res, 200, { ok: true, paused: orchestrator.paused });
      }
    },
    {
      method: 'DELETE', pattern: '/api/pause',
      handler: async ({ res, json }) => {
        orchestrator.setPaused(false);
        const marked = {};
        for (const chatKey of store.listChats()) {
          const n = store.drainUnread(chatKey).length;
          if (n > 0) marked[chatKey] = n;
        }
        emit('chat-update', '*');
        updateConfig({ server: { startPaused: false } });
        return json(res, 200, { ok: true, paused: false, marked });
      }
    },

    // ── 日志系统 ─────────────────────────────────────────────────────
    {
      // 最近的日志（UI 日志页签首次加载）
      method: 'GET', pattern: '/api/logs',
      handler: async ({ res, json, url }) => {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        return json(res, 200, { logs: logger.recent(limit), level: logger.getLevel() });
      }
    },
    {
      // 调整最低落盘级别（debug/info/warn/error）
      method: 'POST', pattern: '/api/logs/level',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const level = String(body.level || 'info');
        logger.setLevel(level);
        return json(res, 200, { ok: true, level: logger.getLevel() });
      }
    },

    // ── 验证码请求转发（2026-09-26）────────────────────────────────
    // 部分用户机器上 Chromium 渲染层对 *.aliyuncs.com / *.alicdn.com 的请求被
    // 本机安全软件按进程+域名压制（同机 Node 层、系统 curl 均正常），SDK 走不通。
    // 由主进程 Node 层（undici，网络栈独立且实测可达）代为转发。
    // 安全边界（防 SSRF）：目标仅允许 https + aliyuncs/alicdn 两族域名后缀；
    // 不跟随重定向；body 上限 8MB；响应上限 16MB；超时 15s。
    {
      method: '*', pattern: /^\/api\/captcha-forward\/?$/,
      handler: async ({ req, res, json, url }) => {
        if (deps.standard) return json(res, 404, { error: '此安装未启用社区验证码。' });
        const target = String((url && url.searchParams.get('u')) || '');
        let parsed;
        try { parsed = new URL(target); } catch {
          return json(res, 400, { ok: false, error: '缺少或非法的 u 参数' });
        }
        if (parsed.protocol !== 'https:' ||
            !/^[a-zA-Z0-9.-]+\.(aliyuncs\.com|alicdn\.com)$/.test(parsed.hostname)) {
          return json(res, 403, { ok: false, error: `目标不在转发白名单（仅 https 的 aliyuncs/alicdn 域）：${parsed.hostname}` });
        }
        // 读原始 body（POST 等需要；上限 8MB）
        const chunks = [];
        let size = 0;
        try {
          await new Promise((resolve, reject) => {
            req.on('data', (c) => {
              size += c.length;
              if (size > 8 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
              chunks.push(c);
            });
            req.on('end', resolve);
            req.on('error', reject);
          });
        } catch { /* 读失败按空 body 处理 */ }
        const reqBody = Buffer.concat(chunks);

        // 复制请求头（剥掉 hop-by-hop 与本机信息头）
        const fwdHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          const kl = k.toLowerCase();
          if (['host', 'cookie', 'connection', 'content-length', 'origin', 'referer',
               'accept-encoding', 'transfer-encoding', 'upgrade', 'expect'].includes(kl)) continue;
          fwdHeaders[k] = v;
        }
        if (reqBody.length && !fwdHeaders['content-type']) fwdHeaders['content-type'] = 'application/octet-stream';

        try {
          const up = await fetch(parsed.href, {
            method: req.method,
            headers: fwdHeaders,
            body: (req.method === 'GET' || req.method === 'HEAD' || reqBody.length === 0) ? undefined : reqBody,
            redirect: 'manual',
            signal: AbortSignal.timeout(15000),
          });
          const buf = Buffer.from(await up.arrayBuffer());
          if (buf.length > 16 * 1024 * 1024) {
            return json(res, 502, { ok: false, error: '转发响应过大（>16MB）' });
          }
          const resHeaders = {};
          up.headers.forEach((v, k) => {
            const kl = k.toLowerCase();
            if (['transfer-encoding', 'content-encoding', 'content-length', 'connection', 'keep-alive'].includes(kl)) return;
            resHeaders[k] = v;
          });
          resHeaders['access-control-allow-origin'] = '*';   // 同源请求用不到，留作兜底
          res.writeHead(up.status, resHeaders);
          res.end(buf);
        } catch (e) {
          return json(res, 502, { ok: false, error: `转发失败：${String(e?.cause?.code || e?.message || e).slice(0, 120)}` });
        }
        return undefined;   // 已自行写响应
      }
    },
  ];
}
