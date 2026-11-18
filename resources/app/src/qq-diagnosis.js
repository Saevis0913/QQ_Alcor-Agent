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

export function diagnoseQQ({ running = false, backendReady = false, processes = [], connection = null, frameworkDirs = [] } = {}) {
  const rows = Array.isArray(processes) ? processes : [];
  const connected = connection?.connected === true || backendReady === true;
  const base = { processes: rows, connection, frameworkDirs, supportedVersions: SUPPORTED_QQ_VERSIONS };

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
      detail: '宿主已连接，但账号在线或消息通道还没确认。',
      hint: '在 QQ 里确认已登录，然后点「重新扫描」；一直不恢复就重启 QQ 再连。' };
  }
  if (!rows.length) {
    return { ...base, code: 'NO_QQ_RUNNING', title: '没有检测到正在运行的 QQ',
      detail: '原生接入需要先登录官方 QQ 客户端，扫描时会连 QQ 一起看。',
      hint: '打开并登录 QQ（官方版），回到这里点「重新扫描」。' };
  }

  const unreadable = rows.filter((row) => row?.reason === 'PROCESS_INSPECTION_UNAVAILABLE');
  const supported = rows.filter((row) => row?.supported);
  const foreignRow = rows.find((row) => row.foreignModules?.length);
  const hostLoaded = rows.find((row) => row.alcorHostLoaded);
  const candidate = pickCandidate(rows);

  if (!supported.length) {
    const versions = [...new Set(rows.map((row) => row.version || '未知版本'))].join('、');
    return { ...base, code: 'UNSUPPORTED_BUILD', title: `QQ 版本 ${versions} 尚未适配`,
      detail: `原生接入按 QQ 的 wrapper.node 精确识别，目前随包支持 ${SUPPORTED_QQ_VERSIONS.join(' / ')}。版本不对时不会强行注入，以免把 QQ 弄坏。`,
      hint: '两条路：装回受支持的 QQ 版本；或等这一版适配后再连。适配记录写在资源目录的 QQ 兼容说明里。',
      candidate: null, unreadable: unreadable.length };
  }
  if (hostLoaded) {
    return { ...base, code: 'HOST_PRESENT', title: 'Alcor 宿主已经驻留在 QQ 里',
      detail: '上一次连接留下的宿主还没卸载，重复注入会被拒绝；它只会在 QQ 退出时一起消失。',
      hint: '完全退出 QQ（任务栏也退），重新登录后点「重新扫描」；必要时用「重启 QQ」按钮。' };
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
  return { ...base, code: 'READY_TO_CONNECT', title: `找到可连接的 QQ（${candidate.version || '未知版本'}，PID ${candidate.pid}）`,
    detail: candidate.verification === 'live' ? '这个构建已通过真实收发验证。' : '这个构建已完成静态适配，连接后确认账号与收发。',
    hint: '点「连接 QQ」，连上后 QQ 状态会变成账号在线。', candidate };
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
