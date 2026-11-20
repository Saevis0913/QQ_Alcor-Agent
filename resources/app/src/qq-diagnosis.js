// QQ 连接排查：把「连不上」拆成能对症的几种原因。
// 判定只依赖核心 /manage/processes 的进程清单 + /health 的后端快照，再加上本机文件残留扫描。
import fs from 'node:fs';
import path from 'node:path';

export const SUPPORTED_QQ_VERSIONS = ['9.9.36-53644', '9.9.37-54395'];

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
  const clean = processRows.filter((row) => row && !row.supported && row.reason === 'UNSUPPORTED_BUILD'
    && !row.alcorHostLoaded && !(row.foreignModules?.length));
  return clean.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))[0] || null;
}

// 注入阶段的失败码：core 现在把加载器的 stage 翻成这些码，再也不用「HOST_START_INCOMPLETE」一把梭。
const FAILURE_TEXT = {
  HOST_TARGET_DENIED: ['注入被系统拒绝', '加载器没能拿到 QQ 进程的操作权：常见原因是 QQ 以管理员身份运行而 Alcor 不是、或两侧不在同一个 Windows 会话里。',
    '把 QQ 和 Alcor 用同一种权限打开（都以管理员运行，或都不提权），然后重启 QQ 再连。'],
  HOST_LOAD_BLOCKED: ['宿主 DLL 在 QQ 里加载失败', '安全软件、内存完整性（HVCI）或应用控制策略拦下了 alcor-host.dll 的加载；也见于 32 位 QQ。',
    '在安全软件里给 Alcor 安装目录加白名单；关闭「内核隔离·内存完整性」后重启；确认 QQ 是 64 位版本。'],
  HOST_ENTRY_FAILED: ['宿主加载了但没起来', 'DLL 已进入 QQ 进程，入口初始化失败；常见于 QQ 被兼容性模式/注入类插件改动过的环境。',
    '关掉 QQ 的兼容性模式与第三方美化/注入工具，重启 QQ 后再连；仍失败请把判定码与 data/logs 当日日志一起反馈。'],
  HOST_ARTIFACT_INVALID: ['随包宿主文件损坏或被替换', '加载器读到的 alcor-host.dll 与随包版本不一致，可能是安装不完整或被杀软改写。',
    '用安装包覆盖安装一次（覆盖安装不会动 data 目录），再重试连接。'],
  HOST_LOADER_MISSING: ['注入器不见了', 'resources/alcor/artifacts/native/qq-host-loader.exe 缺失，安装不完整或被杀软隔离。',
    '用安装包覆盖安装；在杀软隔离区恢复 qq-host-loader.exe 并加白名单。'],
  HOST_LOADER_TIMEOUT: ['注入器超时', '加载器 55 秒内没有返回，通常是 QQ 进程卡住或安全软件在逐个拦截系统调用。',
    '重启 QQ 后重试；反复出现就把 Alcor 安装目录加入杀软白名单。'],
  HOST_LOADER_FAILED: ['注入器无法运行', 'qq-host-loader.exe 起不来：缺少 VC++ 运行库、被杀软/应用控制策略拦住都是这一类。',
    '安装 Microsoft Visual C++ 运行库（x64），把安装目录加白名单后重试。'],
  HOST_THREAD_PENDING: ['注入线程没有收尾', '宿主已经写入目标进程，但远程线程没有按预期结束；QQ 可能停在半初始化状态。',
    '完全退出 QQ（任务栏退出，不是关窗口）后重新登录，再点连接。'],
  HOST_REFERENCE_STUCK: ['加载器引用没有释放', '注入完成后加载器没能释放对目标进程的引用，通常是 QQ 进程被挂起或调试器占用。',
    '关掉调试/注入类工具，完全退出 QQ 重开后再连。'],
  HOST_START_INCOMPLETE: ['宿主没有完成启动', '加载器返回了非零状态但没给出具体阶段（旧版加载器或异常退出）。',
    '重启 QQ 重试；仍失败请用排查程序导出判定码与日志。']
};

export function describeQQFailure(lastFailure) {
  const code = typeof lastFailure?.code === 'string' ? lastFailure.code : null;
  const entry = code ? FAILURE_TEXT[code] : null;
  if (!entry) return null;
  const stage = lastFailure?.stage ? `（阶段：${lastFailure.stage}）` : '';
  const status = Number.isFinite(lastFailure?.status) ? `（status=${lastFailure.status}）` : '';
  return { code, title: entry[0], detail: entry[1] + stage + status, hint: entry[2] };
}

export function diagnoseQQ({ running = false, backendReady = false, processes = [], connection = null, frameworkDirs = [], compat = null, lastFailure = null } = {}) {
  const rows = Array.isArray(processes) ? processes : [];
  const connected = connection?.connected === true || backendReady === true;
  const warnings = [];
  if (compat?.flags?.hvci) warnings.push('内存完整性（HVCI）已开启');
  if (compat?.flags?.smartAppControl) warnings.push('智能应用控制已开启');
  if (compat?.flags?.elevatedQQ?.length) warnings.push('QQ 以管理员身份运行');
  if (compat?.flags?.archMismatch?.length) warnings.push('QQ 不是 64 位');
  if (compat?.flags?.loaderBroken) warnings.push('注入器无法运行');
  if (compat?.flags?.hostArtifactMissing) warnings.push('宿主 DLL 缺失');
  // warnings 放进 base：已连接/未就绪这些早退结论也要带着环境提示，不能只在失败分支里出现。
  const base = { processes: rows, connection, frameworkDirs, supportedVersions: SUPPORTED_QQ_VERSIONS, compat, lastFailure, warnings };

  if (!running) {
    return { ...base, code: 'CORE_OFFLINE', title: 'Alcor 核心没有运行',
      detail: 'QQ 连接由随包的 Alcor 核心负责，核心没起来就谈不上连接 QQ。',
      hint: '先在设置 → 连接与桌面里启动 Alcor 核心，或用程序自带的启动入口重开一次。' };
  }
  if (connected) {
    const account = connection?.accountLastFour ? `尾号 ${connection.accountLastFour}` : '';
    // /manage/processes 里的连接快照对 receiveReady 恒为 false，是否真正就绪以核心 /get_status 为准。
    if (backendReady) {
      return { ...base, code: 'ALREADY_CONNECTED', title: `已连接 QQ ${account}`.trim(),
        detail: '账号在线，消息收发通道正常。', hint: '' };
    }
    return { ...base, code: 'RECEIVE_NOT_READY', title: `QQ 宿主已连上 ${account}`.trim(),
      detail: '宿主已连上控制台，正在确认账号在线与消息通道（通常半分钟内完成）。',
      hint: '先在 QQ 里确认已登录、等 30 秒再点「重新扫描」；一直不恢复就重启 QQ 再连。' };
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
      hint: '用安装包覆盖安装一次（覆盖安装不会动 data 目录）；如果杀软隔离过文件，先从隔离区恢复再给 Alcor 目录加白名单。' };
  }
  if (compat?.flags?.foreignSession?.length) {
    return { ...base, warnings, code: 'SESSION_MISMATCH', title: 'QQ 不在同一个 Windows 会话里',
      detail: `QQ 进程的会话号与 Alcor 不同（QQ：${compat.flags.foreignSession.join('、')}）。跨会话不能用这种方式注入。`,
      hint: '在同一个登录会话里打开 QQ 与 Alcor（不要一个走远程桌面、一个走本机控制台），或改用同一用户重新登录两边。' };
  }
  if (compat?.flags?.elevatedQQ?.length && compat?.self?.elevated === false) {
    return { ...base, warnings, code: 'ELEVATION_MISMATCH', title: 'QQ 提权运行，而 Alcor 没有',
      detail: `QQ 进程（${compat.flags.elevatedQQ.join('、')}）以管理员身份运行，Alcor 以普通权限运行；低权限进程无法把 DLL 注入到高权限进程里。`,
      hint: '两种都行：把 QQ 以普通权限重开（推荐），或让 Alcor 也以管理员身份运行——关键是两边权限一致。' };
  }
  if (compat?.flags?.archMismatch?.length) {
    const detail = compat.flags.archMismatch.map((item) => `PID ${item.pid}：${item.arch}`).join('；');
    return { ...base, warnings, code: 'ARCH_MISMATCH', title: 'QQ 不是 64 位版本',
      detail: `原生接入只支持 64 位 QQ，检测到：${detail}。`,
      hint: '换装官方 64 位 QQ（安装包默认就是 x64），再重新扫描。' };
  }

  const unreadable = rows.filter((row) => row?.reason === 'PROCESS_INSPECTION_UNAVAILABLE');
  const supported = rows.filter((row) => row?.supported);
  const foreignRow = rows.find((row) => row.foreignModules?.length);
  const hostLoaded = rows.find((row) => row.alcorHostLoaded);
  const candidate = pickCandidate(rows);

  if (!supported.length) {
    const versions = [...new Set(rows.map((row) => row.version || '未知版本'))].join('、');
    const relaxed = pickRelaxedCandidate(rows);
    if (relaxed) {
      return { ...base, code: 'QQ_BUILD_UNLISTED', title: `QQ 版本 ${versions} 未登记，可以试一次`,
        detail: `这一版 QQ（PID ${relaxed.pid}）的 wrapper.node 不在随包名单里（已适配 ${SUPPORTED_QQ_VERSIONS.join(' / ')}），所以没有「已验证」保证。`,
        hint: '点「仍然尝试注入」会用兼容模式试一次：注入失败会自动重启 QQ 恢复原状，不会把 QQ 弄坏。',
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
  if (foreignRow) {
    return { ...base, code: 'FOREIGN_MODULES', title: `QQ 里驻留着其它框架的模块：${foreignRow.foreignModules.join('、')}`,
      detail: '这些模块占用的正是原生接入要读的服务对象，两者同时存在时只能有一个拿到。',
      hint: '退出那个框架、完全关掉 QQ 再登录，然后回来重连；不用卸载它，只要它别同时挂在 QQ 上。' };
  }
  if (!candidate) {
    return { ...base, code: 'PROCESS_UNREADABLE', title: 'QQ 进程读不到账号模块',
      detail: '进程在，但读不到 wrapper.node；多半是权限不足或 QQ 还在启动中。',
      hint: '等 QQ 启动完成、以同一用户身份重试；仍不行就用管理员权限运行一次排查程序。' };
  }
  const failure = describeQQFailure(lastFailure);
  if (failure) {
    return { ...base, warnings, code: 'INJECTION_BLOCKED', title: failure.title,
      detail: failure.detail, hint: failure.hint, candidate, failure };
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
  line(`核心状态：${result.running ? '运行中' : '未运行'}｜后端就绪：${result.backendReady ? '是' : '否'}`);
  if (result.connection) line(`会话：connected=${result.connection.connected === true} pid=${result.connection.pid ?? '-'} 尾号=${result.connection.accountLastFour ?? '-'}`);
  line(`支持版本：${result.supportedVersions.join(' / ')}`);
  const compat = result.compat;
  if (compat) {
    const self = compat.self ? `会话 ${compat.self.sessionId}${compat.self.elevated ? ' · 管理员' : ' · 普通权限'}` : '未知';
    line(`运行环境：${compat.os?.version || '未知系统'}${compat.os?.arch ? ' · ' + compat.os.arch : ''}｜Alcor ${self}`);
    const loader = compat.loader || {};
    line(`注入器：${loader.ran ? '可运行（stage=' + (loader.stage || '?') + '）' : '不可用（' + (loader.reason || '未知') + '）'}｜宿主 DLL：${compat.hostDll?.ok ? compat.hostDll.bytes + ' B' : '缺失'}`);
    if (compat.qq?.length) line(`QQ 进程环境：${compat.qq.map((item) => 'PID ' + item.pid + ' · ' + (item.arch || '未知架构') + (item.store ? ' · 商店版' : '')).join('；')}`);
    const sec = compat.security || {};
    const secText = [sec.hvci === 1 ? '内存完整性开' : '内存完整性关', sec.smartAppControl === 1 ? '智能应用控制强制' : sec.smartAppControl === 2 ? '智能应用控制评估' : '智能应用控制关'];
    if (sec.defender) secText.push(`Defender 实时${sec.defender.realtime ? '开' : '关'}`);
    line(`安全策略：${secText.join(' / ')}`);
    if (coreCompatWarnings(compat).length) line(`注意：${coreCompatWarnings(compat).join('、')}`);
  }
  if (result.failure) line(`上次失败：${result.failure.code}${result.failure.detail ? ' · ' + result.failure.detail : ''}`);
  line('');
  if (!result.processes?.length) line('QQ 进程：无');
  for (const row of result.processes || []) {
    line(`QQ 进程 PID ${row.pid}：${row.version || '未知版本'} ${row.supported ? '（受支持' + (row.verification === 'static' ? '·静态适配' : '·已实网验证') + '）' : '（未适配）'}`);
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
  line(`（${result.title}）`);
}
