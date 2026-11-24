// QQ 连接排查：把「连不上」拆成能对症的几种原因。
// 判定只依赖核心 /manage/processes 的进程清单 + /health 的后端快照，再加上本机文件残留扫描。
import fs from 'node:fs';
import path from 'node:path';

export const SUPPORTED_QQ_VERSIONS = ['9.9.36-53644', '9.9.37-54395'];

export function readQQProcessSnapshot(body) {
  if (!Array.isArray(body?.processes) || body.processes.some(row =>
    !row || typeof row !== 'object' || !Number.isSafeInteger(Number(row.pid)) || Number(row.pid) <= 0 ||
    (row.foreignModules != null && !(Array.isArray(row.foreignModules) && row.foreignModules.every(name => typeof name === 'string'))))) {
    throw new Error('核心返回的 QQ 进程清单格式无效。');
  }
  return { processes: body.processes, connection: body.connection ?? null };
}

// 其它框架在硬盘上常见的落点，只做「存在即提示」，不删除任何文件。
const FRAMEWORK_DIRS = [
  ['LiteLoader', 'resources/app/app_launcher/LiteLoaderQQNT'],
  ['LiteLoader', 'resources/app/app_launcher/LiteLoader'],
  ['NapCat', 'NapCat'],
  ['NapCat', 'napcat'],
  ['LLOneBot', 'LLOneBot'],
  ['LLOneBot', 'llonebot'],
  ['SnowLuma', 'SnowLuma'],
  ['QSign', 'qsign']
];

export function scanFrameworkDirs(qqRoots = []) {
  const found = [];
  for (const root of qqRoots) {
    for (const [name, rel] of FRAMEWORK_DIRS) {
      const full = path.join(root, rel);
      try {
        if (fs.existsSync(full)) found.push({ name, path: full });
      } catch { /* 读不到就当没有，扫描不能反过来挡住连接 */ }
    }
  }
  return found;
}

export function qqInstallRoots(processRows = []) {
  const roots = new Set();
  for (const row of processRows) {
    if (typeof row?.path === 'string' && /[\\/]QQ\.exe$/i.test(row.path)) roots.add(path.dirname(row.path));
  }
  return [...roots];
}

function pickCandidate(processRows) {
  const clean = processRows.filter((row) => row?.supported && !row.alcorHostLoaded && !(row.foreignModules?.length));
  return clean.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))[0] || null;
}

// 未登记的构建：只要确实是 QQ.exe、没有外来模块、宿主没在里面，就允许用户在知情后试一次。
// 99% 的兼容性靠的是「能试 + 失败可恢复」，而不是把识别名单无限拉长。
export function pickRelaxedCandidate(processRows) {
  const clean = processRows.filter((row) => row && !row.supported
    && (row.reason === 'UNSUPPORTED_BUILD' || row.reason === 'FAMILY_UNVERIFIED')
    && !row.alcorHostLoaded && !(row.foreignModules?.length));
  return clean.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))[0] || null;
}

// 注入阶段的失败码：core 现在把加载器的 stage 翻成这些码，再也不用「HOST_START_INCOMPLETE」一把梭。
const FAILURE_TEXT = {
  HOST_TARGET_DENIED: ['系统拒绝了本次进程访问', '核心收到进程访问被拒绝的结果。具体原因需结合系统记录确认。',
    '导出排查报告，按失败时间核对 Windows 事件。已有获授权的本机 OneBot 服务时，可改用该服务接入。'],
  HOST_ALREADY_PRESENT: ['Alcor 宿主已驻留', '核心报告目标进程中已有 Alcor 宿主。',
    '重新扫描以确认宿主和消息通道的状态，仍未就绪时导出排查报告。'],
  HOST_LOAD_BLOCKED: ['宿主 DLL 加载阶段失败', '核心报告宿主加载失败。具体原因需要结合原始状态和 Windows 事件确认。',
    '先把 Alcor 安装目录加入安全软件排除项、确认内存完整性（HVCI）与智能应用控制没有拦这个 DLL，再重启 QQ 重试；仍失败导出报告，按失败时间和文件名核对 Windows 事件。'],
  HOST_ENTRY_FAILED: ['宿主初始化失败', '核心报告宿主初始化失败。',
    '导出本次报告，保留阶段、状态码和发生时间。已有获授权的本机 OneBot 服务时，可改用该服务接入。'],
  HOST_ARTIFACT_INVALID: ['随包宿主文件损坏或被替换', '加载器读到的 alcor-host.dll 与随包版本不一致，可能是安装不完整或被杀软改写。',
    '用安装包覆盖安装一次（覆盖安装不会动 data 目录），再重试连接。'],
  HOST_LOADER_MISSING: ['注入器不见了', 'resources/alcor/artifacts/native/qq-host-loader.exe 缺失，安装不完整或被杀软隔离。',
    '核对安装包来源和安全保护历史，再用可信发布包修复安装。'],
  HOST_LOADER_TIMEOUT: ['加载器超时', '核心等待加载器响应时超时。',
    '导出本次排查报告，核对超时时间附近的 Windows 事件。'],
  HOST_LOADER_FAILED: ['加载器执行失败', '核心未取得加载器的有效结果。',
    '先确认 resources/alcor/artifacts/native/qq-host-loader.exe 存在并能运行；缺失时用安装包覆盖安装一次，仍失败时装 VC++ 2015-2022 x64 运行库后重启 QQ 再试。'],
  HOST_THREAD_PENDING: ['注入线程没有收尾', '宿主已经写入目标进程，但远程线程没有按预期结束；QQ 可能停在半初始化状态。',
    '完全退出 QQ（任务栏退出，不是关窗口）后重新登录，再点连接。'],
  HOST_REFERENCE_STUCK: ['加载器引用没有释放', '注入完成后加载器没能释放对目标进程的引用，通常是 QQ 进程被挂起或调试器占用。',
    '关掉调试/注入类工具，完全退出 QQ 重开后再连。'],
  HOST_START_INCOMPLETE: ['宿主没有完成启动', '加载器返回了非零状态但没给出具体阶段（旧版加载器或异常退出）。',
    '重启 QQ 重试；仍失败请用排查程序导出判定码与日志。'],
  PROFILE_SCANNER_MISSING: ['现场适配组件缺失', 'resources/alcor/tools/qq-profile-scan.mjs 不在包里，无法为未登记的 QQ 版本推导 profile。',
    '用安装包覆盖安装一次（覆盖安装不会动 data 目录），再重试连接。'],
  PROFILE_SCAN_FAILED: ['现场推导 profile 失败', '离线扫描器没能从这个版本的 wrapper.node 复原出全部 RVA（构建差异超出已知锚点），没有写入任何补丁。',
    '装回受支持的 QQ 版本（9.9.36-53644 / 9.9.37-54395），或把判定码与 data/logs 当日日志一起反馈以适配该版本。'],
  QQ_LOGIN_NOT_CONFIRMED: ['核心未确认 QQ 登录账号', '核心在本次连接中未能确认登录身份。',
    '核对 QQ 窗口里的登录状态，导出同一会话的身份结果、心跳和时间。'],
  IDENTITY_SERVICE_NULL: ['核心未能通过会话服务读取账号', '核心报告读取身份时会话服务不可用。',
    '核对当前账号状态并保存本次诊断。账号识别和消息收发需要分别验收。'],
  IDENTITY_ACCOUNT_ZERO: ['账号为空：登录还没有完成', '宿主调到了取账号接口，但拿回来的账号是 0。常见于只停在登录框、登录被中断、或换了账号还没重启 QQ。',
    '在这个 QQ 窗口里把登录走完（不是只打开登录框），再点「连接 QQ」。'],
  IDENTITY_CALL_FAILED: ['取账号的调用没有返回结果', '宿主调用 QQ 的取账号接口时既没拿到成功，也没拿到「服务为空」这种明确结果，属于调用本身失败。',
    '完全退出 QQ 后重新登录再连；仍失败导出排查报告，附判定码与时间。'],
  // 旧版核心只报这一个码，保留别名免得历史失败记录变成「未知失败」。
  IDENTITY_UNREADABLE: ['核心未能读取账号', '旧版核心报告账号读取失败。',
    '核对当前账号状态并保存本次诊断。'],
  IDENTITY_SERVICE_UNBOUND: ['注入成功，但 QQ 没有交出消息服务', '宿主已在 QQ 内运行并读到了账号，但这次注入没拿到 QQ 的消息服务对象：账号能确认，消息收发不会生效。',
    '先重启 QQ 再连一次；仍然如此就改用 OneBot 进程外接入。这不是杀软、也不是内存完整性拦的。'],
  SERVICE_NEVER_CREATED: ['QQ 从启动起就没有消息服务对象', '账号读得到，但按 profile 的 vtable 扫描整个可读内存 0 命中：这台机器的 QQ 没有创建消息服务对象，属于启动阶段就没走到那一步。',
    '换一个 QQ 安装（官方安装包、本地盘、干净目录）重新登录后用同一份证据复测；仍为 0 命中就改用 OneBot 进程外接入。'],
  PROFILE_SCAN_LOW_CONFIDENCE: ['这版 QQ 的结构和已知锚点对不上', '扫描器发现自己复原的偏移互相矛盾（落点不在代码段、或多字段指向同一处），判定为低置信度，没有写入任何补丁、也没有碰 QQ。',
    '先按受支持版本使用；把判定码与 QQ 版本号反馈后加进适配矩阵，不靠猜偏移硬打补丁。'],
  PROFILE_SCAN_MISMATCH: ['QQ 文件在扫描前后不一致', '扫描到的 wrapper.node 与进程清单里的哈希对不上，多半是 QQ 正在自动更新。',
    '等 QQ 更新完成、完全退出 QQ（任务栏退出）重新登录后，再点「重新扫描」。'],
  PROFILE_WRAPPER_NOT_FOUND: ['找不到 QQ 的 wrapper.node', '按 QQ.exe 的位置推导 resources/app/wrapper.node 时文件不存在，QQ 安装可能不完整。',
    '用 QQ 官方安装包修复安装，完全退出 QQ 重新登录后再试。'],
  PROFILE_VERSION_UNSUPPORTED: ['QQ 版本号无法登记', '现场推导拿到的版本标识不符合 profile 表位格式（超长或含非法字符），已放弃生成补丁包。',
    '把判定码与 QQ 版本号一起反馈；可先用受支持的 QQ 版本。'],
  PROFILE_PATCH_FAILED: ['生成配对补丁包失败', '把新 profile 写入 loader/DLL 表位时发现结构与预期不符，已放弃写入、未改动随包文件。',
    '把判定码与 data/logs 当日日志一起反馈；可先用受支持的 QQ 版本。'],
  PROFILE_VERIFY_FAILED: ['补丁包自检未通过', '生成的 loader/DLL 配对包在回读校验时不一致，已整体丢弃、未用于注入。',
    '重试一次连接；反复出现请把判定码与日志反馈。'],
  PROFILE_PACK_FAILED: ['补丁包写入失败', '生成补丁包目录时发生 I/O 错误（权限不足、杀软拦截或磁盘问题），半成品已清理。',
    '核对错误发生时的安装目录访问状态、可用磁盘空间和 Windows 事件。']
};

export function describeQQFailure(lastFailure) {
  const code = typeof lastFailure?.code === 'string' ? lastFailure.code.trim() : '';
  if (!code) return null;
  const entry = Object.hasOwn(FAILURE_TEXT, code) ? FAILURE_TEXT[code] : [
    'QQ 上次连接失败', '核心返回了连接错误。', '导出排查报告并反馈原始判定码。'
  ];
  const stage = lastFailure?.stage ? `（阶段：${lastFailure.stage}）` : '';
  const status = Number.isFinite(lastFailure?.status) ? `（status=${lastFailure.status}）` : '';
  const at = typeof lastFailure.at === 'string' ? lastFailure.at : null;
  return { code, title: entry[0], detail: entry[1] + stage + status, hint: entry[2], at };
}

export function diagnoseQQ({
  running = false, backendReady = false, processes = [], connection = null,
  frameworkDirs = [], compat = null, lastFailure = connection?.lastFailure ?? null, processScanError = '',
  coreCode = '', backendType = 'native', directOneBot = false, statusError = '', statusOnline = null
} = {}) {
  const rows = Array.isArray(processes) ? processes : [];
  const connected = connection?.connected === true || backendReady === true;
  const warnings = [];
  if (compat?.flags?.hvci) warnings.push('内存完整性（HVCI）已开启');
  if (compat?.flags?.smartAppControl) warnings.push('智能应用控制已开启');
  if (compat?.flags?.elevatedQQ?.length) warnings.push('QQ 以管理员身份运行');
  if (compat?.flags?.archMismatch?.length) warnings.push('QQ 不是 64 位');
  if (compat?.flags?.foreignSession?.length) warnings.push('另有 QQ 进程在其它 Windows 会话');
  if (compat?.flags?.loaderBroken) warnings.push('注入器无法运行');
  if (compat?.flags?.hostArtifactMissing) warnings.push('宿主 DLL 缺失');
  // warnings 放进 base：已连接/未就绪这些早退结论也要带着环境提示，不能只在失败分支里出现。
  const failure = describeQQFailure(lastFailure);
  const base = { running, backendReady, backendType, directOneBot, processes: rows, connection, frameworkDirs,
    supportedVersions: SUPPORTED_QQ_VERSIONS, compat, lastFailure, failure, warnings, processScanError };

  if (!running && !directOneBot) {
    const messages = {
      ALCOR_CONFIG_INVALID: ['核心配置无法读取或校验失败', '核对当前实例所选的配置文件及其引用的 OneBot 配置。'],
      ALCOR_AUTH_FAILED: ['核心健康检查被拒绝', '核对核心监听地址和令牌，确认与当前实例的配置一致。'],
      ALCOR_IDENTITY_MISMATCH: ['端口响应与 Alcor 核心不匹配', '核对当前实例的监听端口和配置文件。'],
      ALCOR_UNAVAILABLE: ['核心健康检查未完成', '查看核心启动日志，确认服务是否在监听，再重新检测。']
    };
    if (Object.hasOwn(messages, coreCode)) {
      const [title, hint] = messages[coreCode];
      return { ...base, code: coreCode, title, detail: '', hint };
    }
    return { ...base, code: 'CORE_OFFLINE', title: 'Alcor 核心没有运行',
      detail: 'QQ 连接由随包的 Alcor 核心负责，核心没起来就谈不上连接 QQ。',
      hint: '先在设置 → 连接与桌面里启动 Alcor 核心，或用程序自带的启动入口重开一次。' };
  }
  if (backendType === 'onebot') {
    if (coreCode === 'ONEBOT_CONFIG_INVALID') return { ...base, code: coreCode, title: 'OneBot 连接配置无效',
      detail: '', hint: '在 Agent 的 OneBot 连接页核对本机 HTTP 和 WebSocket 地址，保存后重新检测。' };
    if (coreCode === 'ONEBOT_PROBE_UNAVAILABLE') return { ...base, code: coreCode, title: 'OneBot 排查组件不可用',
      detail: '', hint: '核对 Agent 安装文件，并在 OneBot 连接页查看状态。' };
    if (backendReady) return { ...base, code: 'ALREADY_CONNECTED', title: 'OneBot 已连接，账号在线', detail: '账号状态查询成功，事件通道已连接。', hint: '' };
    const wsAuth = connection?.ws === 'auth_failed' || statusError === 'UPSTREAM_WS_AUTH_FAILED';
    if (wsAuth || /^UPSTREAM_HTTP_(401|403)$/.test(statusError) || (!statusError && statusOnline === null && connection?.http === 'auth_failed')) {
      return { ...base, code: 'ONEBOT_AUTH_FAILED', title: 'OneBot ' + (wsAuth ? 'WebSocket' : 'HTTP') + ' 鉴权被拒',
        detail: statusError, hint: '核对对应通道的地址和令牌，保存到当前使用的配置后重新连接。' };
    }
    if (connection?.ws !== 'open' || connection.receiveReady === false) return { ...base, code: 'ONEBOT_EVENTS_UNAVAILABLE',
      title: 'OneBot 事件通道未连接', detail: statusError, hint: '确认本机 OneBot 服务已启动，核对 WebSocket 监听地址和路径。' };
    if (statusOnline === false) return { ...base, code: 'ONEBOT_ACCOUNT_OFFLINE', title: 'OneBot 报告账号离线',
      detail: '状态接口已响应，事件通道已连接。', hint: '在提供 OneBot 服务的应用中确认账号状态，然后重新检测。' };
    return { ...base, code: 'ONEBOT_STATUS_UNAVAILABLE', title: 'OneBot 账号状态尚未确认',
      detail: statusError, hint: '检查 OneBot 服务的状态查询接口、地址和服务日志。' };
  }
  if (connected) {
    // 连上了但消息服务没绑定：账号是真的，收发是假的——这种状态必须单独说出来，不能被「已连接」盖住。
    if (connection?.serviceBound === false) {
      const adopt = connection?.serviceAdopt || {};
      if (adopt.lastCode === 'SERVICE_OBJECT_MISSING') {
        // 扫过内存也没有可接管的 service 对象：这台机器的 QQ 根本没建过消息服务，重连解决不了。
        const row = (rows || []).find((item) => item.pid === connection?.pid);
        const startedMs = row?.startedAt ? Date.parse(row.startedAt) : NaN;
        const ageMinutes = Number.isFinite(startedMs) ? Math.max(0, Math.round((Date.now() - startedMs) / 60000)) : null;
        const scanned = adopt.attempts ?? 0;
        const scanNote = '扫描 ' + scanned + ' 次、命中 ' + (adopt.found ?? 0) + ' 次' + (adopt.lastMillis ? '，每次约 ' + adopt.lastMillis + ' ms' : '');
        // 第二遍扫描（间隔 45 秒）仍然是 0 命中，就说明对象不是「丢了」而是「从没建过」，这是另一类故障。
        if (adopt.neverCreatedAt || scanned >= 2) {
          return { ...base, code: 'SERVICE_NEVER_CREATED', title: 'QQ 启动后没有创建消息服务对象',
            detail: (ageMinutes === null ? 'QQ 启动后' : `QQ 启动至今 ${ageMinutes} 分钟`) + '一直没有消息服务对象：账号读得到，服务对象扫不到（' + scanNote + '）。重连、重启 Alcor 都不会改变这一点。',
            hint: '三条处置：① 点「重启 QQ 后重试」，完全退出 QQ 重新登录，登录后先在 QQ 里自己收发一条消息，再回来连接；② 跑一次「采集证据」，把 zip 发回作者（里面有服务对象扫描与 TLS 结果）；③ 现在就用「改用 OneBot 接入」把收发跑起来。' };
        }
        return { ...base, code: 'IDENTITY_SERVICE_UNBOUND', title: 'QQ 已连上，但消息收发还不能用',
          detail: `注入成功、账号也读到了，但 QQ 进程里暂时没有可接管的消息服务对象（serviceBound=false，${scanNote}）。`,
          hint: 'Alcor 每 45 秒会再扫一次；仍然一样就点本卡片上的「改用 OneBot 接入」，让 Alcor 走本机 OneBot 服务收发。' };
      }
      return { ...base, code: 'IDENTITY_SERVICE_UNBOUND', title: 'QQ 已连上，但消息收发还不能用',
        detail: '宿主已经在 QQ 进程里、账号也读到了，但这次注入没有拿到 QQ 的消息服务对象（serviceBound=false）：能确认登录，收发消息不会生效。',
        hint: 'Alcor 正在自动找回消息服务（每 45 秒重试一次，共 8 次）；仍然一样就点本卡片上的「改用 OneBot 接入」，让 Alcor 走本机 OneBot 服务收发。' };
    }
    const account = connection?.accountLastFour ? `尾号 ${connection.accountLastFour}` : '';
    // /manage/processes 里的连接快照对 receiveReady 恒为 false，是否真正就绪以核心 /get_status 为准。
    // 账号来自只读内存时要把这件事说出来：它不是宿主那条线程局部路径给的，排障时两回事。
    const memoryNote = connection?.identitySource === 'memory'
      ? '本次账号由只读内存识别。' : '';
    if (backendReady) {
      return { ...base, code: 'ALREADY_CONNECTED', title: `已连接 QQ ${account}`.trim(),
        detail: '核心报告账号在线，事件通道已连接。' + memoryNote, hint: '' };
    }
    const title = connection?.serviceBound === false ? 'QQ 消息服务绑定待确认' : 'QQ 宿主已连接，消息通道待确认';
    // 入站到过但没发布，要把「到了什么」写出来：自发的回执（528/732）与真没解出来的私聊，处理方式完全不同。
    const progress = connection?.receiveProgress;
    const inputNote = progress?.inputs > 0
      ? `已收到 ${progress.inputs} 条入站数据，发布 ${progress.messagesPublished ?? 0} 条；最近一条未发布类型 ${progress.lastUnrecognized?.type ?? '未知'}。`
      : '';
    return { ...base, code: 'RECEIVE_NOT_READY', title: [title, account].filter(Boolean).join(' · '),
      detail: memoryNote + (connection?.serviceBound === false ? '建立连接时未确认消息服务绑定。' : '') + inputNote + '当前会话的消息收发尚未确认。',
      hint: '保存本次状态。在授权测试会话中分别核对入站事件和出站回执。发送结果未知时先核对接收端。' };
  }
  if (processScanError) {
    return { ...base, code: 'PROCESS_SCAN_FAILED', title: '读取 QQ 进程清单失败',
      detail: processScanError, hint: '重新扫描。持续失败时导出排查报告。' };
  }
  if (!rows.length) {
    return { ...base, code: 'NO_QQ_RUNNING', title: '没有检测到正在运行的 QQ',
      detail: '原生接入需要先登录官方 QQ 客户端，扫描时会连 QQ 一起看。',
      hint: '打开并登录 QQ（官方版），回到这里点「重新扫描」。' };
  }

  if (compat?.flags?.hostArtifactMissing || compat?.flags?.loaderBroken) {
    const loaderText = compat?.loader?.reason ? '原因：' + compat.loader.reason : '加载器不可用';
    return { ...base, warnings, code: 'HOST_RUNTIME_BROKEN', title: '随包的注入组件不完整',
      detail: `${loaderText}；宿主 DLL：${compat?.hostDll?.ok ? '正常' : '缺失或被改写'}。这两样缺一个都注入不了。`,
      hint: '核对发布包完整性和 Windows 事件。确认组件缺失时，用可信发布包修复安装。' };
  }
  // 其它会话 / 32 位进程只是「这一份不能注入」，不该一票否决本会话里可用的候选：
  // 只有连可用候选都没有时，才把它们当成整次连接的结论。
  const foreignPids = new Set((compat?.flags?.foreignSession || []).map((pid) => Number(pid)));
  // archMismatch 既接受 [{pid, arch}] 也接受裸 PID（排查工具与旧调用方两种写法都要认）。
  const archPids = new Set((compat?.flags?.archMismatch || []).map((item) => Number(item && typeof item === 'object' ? item.pid : item)));
  const eligibleRows = rows.filter((row) => !foreignPids.has(Number(row.pid)) && !archPids.has(Number(row.pid)));
  const usableCandidate = pickCandidate(eligibleRows) || pickRelaxedCandidate(eligibleRows);
  if (compat?.flags?.foreignSession?.length && !usableCandidate) {
    return { ...base, warnings, code: 'SESSION_MISMATCH', title: '检测到 QQ 进程处于其他 Windows 会话',
      detail: `QQ 进程的会话号与 Alcor 不同（QQ：${compat.flags.foreignSession.join('、')}）。跨会话不能用这种方式注入。`,
      hint: '在同一个登录会话里打开 QQ 与 Alcor（不要一个走远程桌面、一个走本机控制台），或改用同一用户重新登录两边。' };
  }
  if (compat?.flags?.elevatedQQ?.length && compat?.self?.elevated === false) {
    return { ...base, warnings, code: 'ELEVATION_MISMATCH', title: 'QQ 提权运行，而 Alcor 没有',
      detail: `QQ 进程（${compat.flags.elevatedQQ.join('、')}）以管理员身份运行，Alcor 以普通权限运行；低权限进程无法把 DLL 注入到高权限进程里。`,
      hint: '两种都行：把 QQ 以普通权限重开（推荐），或让 Alcor 也以管理员身份运行——关键是两边权限一致。' };
  }
  if (compat?.flags?.archMismatch?.length && !usableCandidate) {
    const detail = compat.flags.archMismatch.map((item) => `PID ${item.pid}：${item.arch}`).join('；');
    return { ...base, warnings, code: 'ARCH_MISMATCH', title: '检测到架构不匹配的 QQ 进程',
      detail: `原生接入只支持 64 位 QQ，检测到：${detail}。`,
      hint: '换装官方 64 位 QQ（安装包默认就是 x64），再重新扫描。' };
  }

  // 候选只在「本会话、64 位」的行里挑：别的会话或 32 位 QQ 与本次注入无关。
  const unreadable = eligibleRows.filter((row) => row?.reason === 'PROCESS_INSPECTION_UNAVAILABLE');
  const supported = eligibleRows.filter((row) => row?.supported);
  const foreignRow = eligibleRows.find((row) => row.foreignModules?.length);
  const hostLoaded = eligibleRows.find((row) => row.alcorHostLoaded);
  const candidate = pickCandidate(eligibleRows);

  // 只有能对应到当前进程的身份错误才优先于“宿主已驻留”。
  const failurePid = Number(lastFailure?.pid);
  const identityCodes = ['QQ_LOGIN_NOT_CONFIRMED', 'IDENTITY_SERVICE_NULL', 'IDENTITY_UNREADABLE', 'IDENTITY_ACCOUNT_ZERO', 'IDENTITY_CALL_FAILED', 'IDENTITY_SERVICE_UNBOUND'];
  const currentIdentityFailure = identityCodes.includes(failure?.code) && (failurePid > 0
    ? eligibleRows.some(row => Number(row.pid) === failurePid)
    : !lastFailure?.pid && rows.length === 1 && eligibleRows.length === 1);
  if (currentIdentityFailure) {
    return { ...base, code: failure.code, title: failure.title, detail: failure.detail, hint: failure.hint };
  }

  if (foreignRow) {
    return { ...base, code: 'FOREIGN_MODULES', title: `QQ 里驻留着其它框架的模块：${foreignRow.foreignModules.join('、')}`,
      detail: '这些模块占用的正是原生接入要读的服务对象，两者同时存在时只能有一个拿到。',
      hint: '退出那个框架、完全关掉 QQ 再登录，然后回来重连；不用卸载它，只要它别同时挂在 QQ 上。' };
  }
  if (!supported.length && unreadable.length < eligibleRows.length) {
    const versions = [...new Set(rows.map((row) => row.version || '未知版本'))].join('、');
    const relaxed = pickRelaxedCandidate(eligibleRows);
    if (relaxed) {
      const family = relaxed.verification === 'family';
      return { ...base, code: 'QQ_BUILD_UNLISTED',
        title: family ? `QQ ${relaxed.version || versions} 同系列未逐字节验证，可以试一次` : `QQ 版本 ${versions} 未登记，可以试一次`,
        detail: family
          ? `这一版 QQ（PID ${relaxed.pid}）属于 ${relaxed.family || relaxed.version} 这一代，随包只对 ${SUPPORTED_QQ_VERSIONS.join(' / ')} 做过逐字节验证，所以没有「已验证」保证。`
          : `这一版 QQ（PID ${relaxed.pid}）的 wrapper.node 不在随包名单里（已适配 ${SUPPORTED_QQ_VERSIONS.join(' / ')}），所以没有「已验证」保证。`,
        hint: '点「仍然尝试注入」会先为这个构建现场推导 profile、生成成对的 loader/DLL 补丁包再注入；注入失败时 QQ 可能停在半注入状态，请点「重启 QQ」按钮恢复后再试，不会把 QQ 弄坏。',
        candidate: relaxed, relaxed: true, unreadable: unreadable.length };
    }
    return { ...base, code: 'UNSUPPORTED_BUILD', title: `QQ 版本 ${versions} 尚未适配`,
      detail: `原生接入按 QQ 的 wrapper.node 精确识别，目前随包支持 ${SUPPORTED_QQ_VERSIONS.join(' / ')}；也没有找到可直接尝试的 QQ.exe 进程。`,
      hint: '装回受支持的 QQ 版本，或以普通权限启动 QQ 后再扫描。',
      candidate: null, unreadable: unreadable.length };
  }
  if (hostLoaded) {
    return { ...base, code: 'HOST_PRESENT', title: 'Alcor 宿主还在 QQ 里，正在等它接回来',
      detail: '上一次连接留下的宿主还在 QQ 进程内（它只随 QQ 退出而消失）。它通常会在半分钟内自己连回控制台，这段时间不用动它。',
      hint: '先等 30 秒再点「重新扫描」；一直不恢复（或想立刻重连）再完全退出 QQ 重新登录，或用「重启 QQ」按钮。' };
  }
  if (!candidate) {
    return { ...base, code: 'PROCESS_UNREADABLE', title: 'QQ 进程读不到账号模块',
      detail: '进程在，但读不到 wrapper.node；多半是权限不足或 QQ 还在启动中。',
      hint: '等 QQ 启动完成、以同一用户身份重试；仍不行就用管理员权限运行一次排查程序。' };
  }
  // 失败记录里的 PID 已经不在了，说明那是上一次 QQ 进程的事，不能继续压住「已就绪」。
  const failureStale = Number.isSafeInteger(failurePid) && failurePid > 0 && !rows.some((row) => Number(row.pid) === failurePid);
  if (failure && failureStale) warnings.push('上次失败发生在已退出的 QQ 进程（PID ' + failurePid + '），本次判定忽略');
  if (failure && !failureStale) {
    const stage = String(failure.stage || '');
    const failCode = String(failure.code || '');
    // 只有加载器真的走到注入阶段，才叫「注入被拦」。
    const injected = /^(load_library|target_identity|artifact_identity|module_already_loaded|entry|startup)$/.test(stage)
      || /^HOST_(LOAD|TARGET|ARTIFACT|ALREADY|START|THREAD|REFERENCE|ENTRY|RUNTIME)/.test(failCode);
    if (lastFailure.stage === 'identity' || identityCodes.includes(failCode)) {
      const code = identityCodes.includes(failCode) ? failCode : 'QQ_LOGIN_NOT_CONFIRMED';
      const [title, detail, hint] = FAILURE_TEXT[code];
      return { ...base, code, title, detail, hint };
    }
    // 只有「参数解析 / 探测」这类明确没进入注入流程的阶段才排除；未知阶段仍按原逻辑保守处理。
    const nonInjectionStage = /^(arguments|inspected|probe|inspect)$/.test(stage);
    if (!injected && nonInjectionStage) {
      // 排查器只跑 --arguments 时也会写一条失败记录，那不能当成「注入被拦」。
      warnings.push('上次失败不在注入阶段（' + (stage || failCode || '未知') + '），本次判定不据此报「注入被拦」');
    } else {
      return { ...base, code: 'INJECTION_BLOCKED', title: failure.title,
        detail: failure.detail, hint: failure.hint, candidate };
    }
  }
  return { ...base, warnings, code: 'READY_TO_CONNECT', title: `找到可连接的 QQ（${candidate.version || '未知版本'}，PID ${candidate.pid}）`,
    detail: candidate.verification === 'live' ? '这个构建已通过真实收发验证。' : '这个构建已完成静态适配，连接后确认账号与收发。',
    hint: '点「连接 QQ」，连上后 QQ 状态会变成账号在线。', candidate };
}

function coreCompatWarnings(compat) {
  const out = [];
  if (compat.flags?.hvci) out.push('内存完整性已开启');
  if (compat.flags?.smartAppControl) out.push('智能应用控制已开启');
  if (compat.flags?.elevatedQQ?.length) out.push('QQ 以管理员运行');
  if (compat.flags?.archMismatch?.length) out.push('QQ 非 64 位');
  return out;
}

export function formatReport(result) {
  const line = (text) => console.log(text);
  line('');
  line('Alcor Agent · QQ 连接排查');
  line('='.repeat(38));
  line(`结论：${result.title}`);
  if (result.detail) line(`原因：${result.detail}`);
  if (result.hint) line(`处理：${result.hint}`);
  line('');
  if (!result.directOneBot) line(`核心状态：${result.running ? '运行中' : result.code === 'CORE_OFFLINE' ? '未运行' : '未确认'}｜后端就绪：${result.backendReady ? '是' : '否'}`);
  if (result.backendType === 'onebot') {
    line(`OneBot 事件通道：${result.connection?.ws ?? '未知'}`);
  } else if (result.running) {
    if (result.connection) line(`会话：connected=${result.connection.connected === true} pid=${result.connection.pid ?? '-'} 尾号=${result.connection.accountLastFour ?? '-'}`);
    if (Number.isSafeInteger(result.connection?.events)) {
      const stamp = result.connection.lastReceivedAt;
      line(`后端入站事件：${result.connection.events}｜最近一次：${stamp ?? (stamp === null ? '尚无记录' : '未知')}`);
    }
    line(`支持版本：${result.supportedVersions.join(' / ')}`);
  }
  const compat = result.compat;
  if (compat) {
    const self = compat.self ? `会话 ${compat.self.sessionId}${compat.self.elevated ? ' · 管理员' : ' · 普通权限'}` : '未知';
    line(`运行环境：${compat.os?.version || '未知系统'}${compat.os?.arch ? ' · ' + compat.os.arch : ''}｜Alcor ${self}`);
    const loader = compat.loader || {};
    line(`注入器：${loader.ran ? '可运行（stage=' + (loader.stage || '?') + '）' : '不可用（' + (loader.reason || '未知') + '）'}｜宿主 DLL：${compat.hostDll?.ok ? compat.hostDll.bytes + ' B' : '缺失'}`);
    if (compat.qq?.length) line(`QQ 进程环境：${compat.qq.map((item) => 'PID ' + item.pid + ' · ' + (item.arch || '未知架构') + (item.store ? ' · 商店版' : '')).join('；')}`);
    const sec = compat.security || {};
    const secText = [
      ['内存完整性关', '内存完整性开'][sec.hvci] ?? '内存完整性未知',
      ['智能应用控制关', '智能应用控制强制', '智能应用控制评估'][sec.smartAppControl] ?? '智能应用控制未知'
    ];
    const realtime = sec.defender?.realtime;
    if (typeof realtime === 'boolean') secText.push(`Defender 实时${realtime ? '开' : '关'}`);
    line(`安全策略：${secText.join(' / ')}`);
    if (coreCompatWarnings(compat).length) line(`注意：${coreCompatWarnings(compat).join('、')}`);
  }
  if (result.failure) {
    const { code, detail, at } = result.failure;
    line(`上次失败：${[code, detail, at].filter(Boolean).join(' · ')}`);
  }
  line('');
  if (result.processScanError) line(`QQ 进程清单读取失败 · ${result.processScanError}`);
  else if (result.running && result.backendType === 'native' && !result.processes?.length) line('QQ 进程：无');
  for (const row of result.processes || []) {
    const build = row.reason === 'PROCESS_INSPECTION_UNAVAILABLE' ? '（无法读取版本）'
      : row.supported ? '（受支持' + (row.verification === 'static' ? '·静态适配' : '·已实网验证') + '）' : '（未适配）';
    line(`QQ 进程 PID ${row.pid}：${row.version || '未知版本'} ${build}`);
    if (row.foreignModules?.length) line(`  外来模块：${row.foreignModules.join('、')}`);
    if (row.alcorHostLoaded) line('  Alcor 宿主：已驻留');
    if (row.reason) line(`  判定：${row.reason}`);
  }
  if (result.frameworkDirs?.length) {
    line('');
    for (const dir of result.frameworkDirs) line(`硬盘残留：${dir.name} → ${dir.path}`);
  }
  line('');
  line('--------------------------------------');
  line(`判定码：${result.code}`);
}
