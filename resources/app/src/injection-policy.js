import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 只读的系统/进程防护探测。所有结论都来自本机真实值，不做猜测；
// 拿不到某项就返回 null，让上层显示「未知」而不是默认「已开启」。
const PS_SCRIPT = String.raw`$ErrorActionPreference='SilentlyContinue'
function Reg($p,$n){ (Get-ItemProperty -Path $p -Name $n -ErrorAction SilentlyContinue).$n }
$self=[Security.Principal.WindowsIdentity]::GetCurrent()
$selfAdmin=(New-Object Security.Principal.WindowsPrincipal($self)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$mp=Get-MpComputerStatus -ErrorAction SilentlyContinue
$pref=Get-MpPreference -ErrorAction SilentlyContinue
$av=@()
Get-CimInstance -Namespace root\SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction SilentlyContinue | ForEach-Object { $exe=[string]$_.pathToSignedProductExe; $isPath=($exe -match '^[A-Za-z]:\\' -or $exe -match '^\\\\'); $av += [ordered]@{ name=$_.displayName; state=$_.productState; exe=$exe; present=$(if($isPath){[bool](Test-Path -LiteralPath $exe)}else{$null}) } }
$dg=(Get-CimInstance -Namespace root\Microsoft\Windows\DeviceGuard -ClassName Win32_DeviceGuard -ErrorAction SilentlyContinue)
$out=[ordered]@{
  self=[ordered]@{ user=$self.Name; sessionId=(Get-Process -Id $PID).SessionId; elevated=[bool]$selfAdmin }
  machine=[ordered]@{
    hvci=Reg 'HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity' 'Enabled'
    sac=Reg 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' 'VerifiedAndReputablePolicyState'
    deviceGuardRunning=@($dg.SecurityServicesRunning)
    defender=[ordered]@{ realtime=$mp.RealTimeProtectionEnabled; antivirus=$mp.AntivirusEnabled; runningMode=$mp.AMRunningMode; tamper=$mp.IsTamperProtected }
    exclusions=@($pref.ExclusionPath)
    asrIds=@($pref.AttackSurfaceReductionRules_Ids); asrActions=@($pref.AttackSurfaceReductionRules_Actions)
    antivirus=$av
  }
  process=$null
  events=[ordered]@{ codeIntegrity=@(); defender=@() }
}
$target=[int]$env:ALCOR_POLICY_PID
if($target -gt 0){
  $p=Get-Process -Id $target -ErrorAction SilentlyContinue
  if($p){
    $proc=[ordered]@{ pid=$p.Id; sessionId=$p.SessionId; name=$p.ProcessName; path=$p.Path; owner=$null; mitigations=[ordered]@{} }
    $o=Get-CimInstance Win32_Process -Filter "ProcessId=$target" -ErrorAction SilentlyContinue | Invoke-CimMethod -MethodName GetOwner -ErrorAction SilentlyContinue
    if($o){ $proc.owner=(($o.Domain + '\' + $o.User) -replace '^\\','') }
    $m=Get-ProcessMitigation -Id $target -ErrorAction SilentlyContinue
    if($m){
      $proc.mitigations=[ordered]@{
        blockDynamicCode=$m.DynamicCode.BlockDynamicCode
        microsoftSignedOnly=$m.BinarySignature.MicrosoftSignedOnly
        auditMicrosoftSignedOnly=$m.BinarySignature.AuditMicrosoftSignedOnly
        blockRemoteImageLoads=$m.ImageLoad.BlockRemoteImageLoads
        blockLowLabelImageLoads=$m.ImageLoad.BlockLowLabelImageLoads
        disallowChildProcess=$m.ChildProcess.DisallowChildProcessCreation
        dep=$m.DEP.Enable
        cfg=$m.ControlFlowGuard.Enable
      }
    }
    $out.process=$proc
  }
}
$ci=@()
try {
  Get-WinEvent -LogName 'Microsoft-Windows-CodeIntegrity/Operational' -MaxEvents 400 -ErrorAction SilentlyContinue | Where-Object { $_.Id -eq 3076 -or $_.Id -eq 3077 -or $_.Id -eq 3089 } | Select-Object -First 40 | ForEach-Object {
    $ci += [ordered]@{ time=$_.TimeCreated.ToUniversalTime().ToString('o'); id=[int]$_.Id; message=(([string]$_.Message) -replace '\s+',' ') }
  }
} catch { }
$wd=@()
try {
  Get-WinEvent -LogName 'Microsoft-Windows-Windows Defender/Operational' -MaxEvents 400 -ErrorAction SilentlyContinue | Where-Object { $_.Id -eq 1116 -or $_.Id -eq 1117 } | Select-Object -First 40 | ForEach-Object {
    $wd += [ordered]@{ time=$_.TimeCreated.ToUniversalTime().ToString('o'); id=[int]$_.Id; message=(([string]$_.Message) -replace '\s+',' ') }
  }
} catch { }
$out.events=[ordered]@{ codeIntegrity=$ci; defender=$wd }
$out | ConvertTo-Json -Depth 6 -Compress
`;

const FINDING_TEXT = {
  POLICY_HVCI_ON: { level: 'info', title: '内存完整性（HVCI）已开启', detail: 'HVCI 拦的是内核驱动，不影响用户态 LoadLibrary 注入；若确实出现 0xC0000428 再按事件日志排查。' },
  POLICY_SAC_ENFORCING: { level: 'block', title: '智能应用控制处于「强制」', detail: '未签名的程序和模块可能被直接拦下，注入多数会失败。', remedy: 'Windows 安全中心 → 应用和浏览器控制 → 智能应用控制（关闭后需要重装系统才能再开）' },
  POLICY_SAC_EVALUATION: { level: 'warn', title: '智能应用控制处于「评估」', detail: '当前只记录不拦截，但策略切到强制后注入会失败。' },
  POLICY_DEFENDER_REALTIME: { level: 'warn', title: 'Defender 实时保护开着，且未排除安装目录', detail: '未签名的宿主 DLL/注入器容易被当成可疑文件隔离，表现为注入成功但宿主没进去。', remedy: '点「为 Alcor 加 Defender 排除项」一键添加（需要管理员确认）' },
  POLICY_ASR_RANSOMWARE: { level: 'warn', title: 'Defender 的「阻止可疑程序」类 ASR 规则已开启', detail: 'ASR 会拦注入器这类行为，日志在「Defender 保护历史」里。', remedy: '安全中心 → 病毒和威胁防护 → 管理设置 → 攻击面减少，检查对应规则' },
  POLICY_QQ_CIG: { level: 'warn', title: 'QQ 只允许微软签名的模块（CIG）', detail: '理论上未签名的宿主 DLL 会被拒；本机若已实测注入成功，这条会自动降级为提示。' },
  POLICY_QQ_CIG_CONFIRMED_BLOCK: { level: 'block', title: 'QQ 拒绝未签名模块（CIG 实测生效）', detail: '本机上次注入停在加载阶段，Code Integrity 事件 3077/3089 里能看到被拒的 DLL。', remedy: '改用 OneBot 接入，或给宿主模块做签名后重试' },
  POLICY_QQ_ACG: { level: 'block', title: 'QQ 禁止动态代码（ACG）', detail: '这类进程无法用 CreateRemoteThread + LoadLibrary 注入。', remedy: '改用 OneBot 接入' },
  POLICY_QQ_BLOCK_REMOTE_IMAGE: { level: 'warn', title: 'QQ 拒绝从网络路径加载模块', detail: '中转目录不能放在 \\\\服务器\\共享 这类路径上。' },
  POLICY_QQ_BLOCK_LOW_LABEL: { level: 'warn', title: 'QQ 拒绝从低完整性位置加载模块', detail: '临时目录（%TEMP%）在部分机器上是低完整性，宿主会被拒；应使用 ProgramData 中转。' },
  POLICY_ELEVATION_MISMATCH: { level: 'block', title: '权限不一致', detail: 'QQ 以管理员运行而 Alcor 不是（或相反），注入会被拒绝。', remedy: '点「以管理员重启」后再试' },
  POLICY_SESSION_MISMATCH: { level: 'block', title: '会话不一致', detail: 'QQ 与 Alcor 不在同一个 Windows 会话（例如远程桌面与本地桌面），无法跨会话注入。', remedy: '在 QQ 所在的同一个会话里运行 Alcor' },
  POLICY_USER_MISMATCH: { level: 'block', title: '账号不一致', detail: 'QQ 与 Alcor 由不同 Windows 用户运行，令牌不允许跨用户注入。', remedy: '用启动 QQ 的那个 Windows 账号运行 Alcor' },
  POLICY_STAGING_TEMP_ONLY: { level: 'warn', title: '只有临时目录可写', detail: 'ProgramData 不可写时宿主会放到 %TEMP%，部分机器上会因低完整性被 QQ 拒绝。', remedy: '以管理员运行一次 Alcor，让它能写 ProgramData' },
  POLICY_CODE_INTEGRITY_BLOCK: { level: 'block', title: '系统代码完整性拒绝了 Alcor 的模块', detail: 'CodeIntegrity 事件 3077 指向 Alcor 的宿主文件，这是已确认的拦截，不是猜测。', remedy: '改用 OneBot 接入，或由管理员按软件准入流程放行该文件' },
  POLICY_CODE_INTEGRITY_AUDIT: { level: 'info', title: '代码完整性只有审计记录', detail: '事件 3076 表示策略本会拦截但当前只审计；等策略切到强制后注入才会真的失败。' },
  POLICY_AV_QUARANTINE: { level: 'block', title: '安全软件处置过 Alcor 的组件', detail: 'Defender 事件 1116/1117 里出现 Alcor 的文件名，说明检测或处置命中过它。', remedy: '核对文件 SHA-256 与发布包一致后，把安装目录加入排除项再修复安装' },
  POLICY_ARTIFACT_HASH_MISMATCH: { level: 'block', title: '本机宿主组件与发布包不一致', detail: '注入器或宿主 DLL 的 SHA-256 对不上，可能被替换、截断或隔离后留有残件。', remedy: '用同一版本安装包覆盖安装一次，再重试连接' },
  POLICY_EVIDENCE_UNCONFIRMED: { level: 'info', title: '防护策略只是环境提示，尚未确认是它拦住了注入', detail: '当前没有任何与 Alcor 文件对应的系统处置记录。反馈问题时请一起提供：失败时间、界面上的判定码与阶段、同时间的 CodeIntegrity 3077 或 Defender 1116/1117 记录。' },
  POLICY_AV_STALE_REGISTRATION: { level: 'info', title: '系统里有已卸载杀毒软件的残留登记', detail: '安全中心的产品列表会保留卸载后的条目，状态字段也不更新。只有登记路径仍然存在的产品才算当前安装。' },
  POLICY_ONEBOT_FALLBACK: { level: 'info', title: '注入被拦时可改用 OneBot', detail: 'Alcor 支持标准 OneBot 接入，不依赖进程注入；原生注入失败时不会无路可走。' }
};

const ASR_RANSOMWARE = 'c1db55ab-c21a-4637-bb3f-a12568109d35';

function normalizeBroken(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}
function toList(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  return [value];
}
function isAscii(value) { return /^[\x20-\x7e]+$/.test(String(value || '')); }
function asFlag(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim().toUpperCase();
  if (text === 'ON' || text === 'TRUE' || text === '1') return true;
  if (text === 'OFF' || text === 'FALSE' || text === '0') return false;
  return null;
}

/* Security Center 的产品登记在卸载后不会立刻消失（实测用户机上留着一条已卸载产品的登记），
   productState 也只描述历史状态。present=false 说明登记的路径已经不存在，只能当历史记录看。 */
function readAntivirusRow(row) {
  const item = normalizeBroken(row);
  const exe = String(item.exe || '');
  const state = Number(item.state);
  const stateKnown = Number.isFinite(state);
  const present = typeof item.present === 'boolean' ? item.present : null;
  const running = stateKnown ? ((state >> 8) & 0xff) === 0x10 : null;
  return { name: String(item.name || ''), state: stateKnown ? state : null, exe, present,
    active: present === true && running === true, stale: present === false };
}

export function parsePolicyReport(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: 'POLICY_PROBE_EMPTY' };
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, error: 'POLICY_PROBE_INVALID' }; }
  const machine = normalizeBroken(data.machine);
  const defender = normalizeBroken(machine.defender);
  const proc = data.process ? normalizeBroken(data.process) : null;
  const mitigations = proc ? normalizeBroken(proc.mitigations) : {};
  return {
    ok: true,
    self: normalizeBroken(data.self),
    machine: {
      hvci: machine.hvci === undefined ? null : Number(machine.hvci) === 1,
      sac: machine.sac === undefined ? null : Number(machine.sac),
      deviceGuardRunning: toList(machine.deviceGuardRunning).map(Number),
      defender: {
        realtime: defender.realtime === undefined ? null : String(defender.realtime).toLowerCase() === 'true',
        antivirus: defender.antivirus === undefined ? null : String(defender.antivirus).toLowerCase() === 'true',
        runningMode: String(defender.runningMode || ''),
        tamper: defender.tamper === undefined ? null : String(defender.tamper).toLowerCase() === 'true'
      },
      exclusions: toList(machine.exclusions).map(String),
      asrIds: toList(machine.asrIds).map(String),
      asrActions: toList(machine.asrActions).map(Number),
      antivirus: toList(machine.antivirus).map(readAntivirusRow)
    },
    process: proc ? {
      pid: Number(proc.pid) || 0,
      sessionId: proc.sessionId === undefined ? null : Number(proc.sessionId),
      name: String(proc.name || ''),
      path: String(proc.path || ''),
      owner: proc.owner ? String(proc.owner) : '',
      mitigations: {
        blockDynamicCode: asFlag(mitigations.blockDynamicCode),
        microsoftSignedOnly: asFlag(mitigations.microsoftSignedOnly),
        auditMicrosoftSignedOnly: asFlag(mitigations.auditMicrosoftSignedOnly),
        blockRemoteImageLoads: asFlag(mitigations.blockRemoteImageLoads),
        blockLowLabelImageLoads: asFlag(mitigations.blockLowLabelImageLoads),
        disallowChildProcess: asFlag(mitigations.disallowChildProcess),
        dep: asFlag(mitigations.dep)
      }
    } : null,
    events: {
      codeIntegrity: toList(data.events?.codeIntegrity).map((row) => ({ time: String(row?.time || ''), id: Number(row?.id) || 0, message: String(row?.message || '').slice(0, 600) })),
      defender: toList(data.events?.defender).map((row) => ({ time: String(row?.time || ''), id: Number(row?.id) || 0, message: String(row?.message || '').slice(0, 600) }))
    }
  };
}

export function evaluatePolicy(report, options = {}) {
  const stagingPath = String(options.stagingPath || '');
  const memory = normalizeBroken(options.memory);
  const findings = [];
  const push = (code, extra) => {
    const base = FINDING_TEXT[code];
    if (!base) return;
    findings.push({ code, level: base.level, title: base.title, detail: base.detail, remedy: base.remedy || '', ...(extra || {}) });
  };
  if (!report || !report.ok) {
    return { ok: false, error: report?.error || 'POLICY_PROBE_FAILED', findings: [], blocked: false, summary: '' };
  }
  const machine = report.machine || {};
  const proc = report.process || null;
  const self = report.self || {};
  const mitigations = proc?.mitigations || {};

  if (machine.hvci === true || machine.deviceGuardRunning?.includes(2)) push('POLICY_HVCI_ON');
  if (machine.sac === 1) push('POLICY_SAC_ENFORCING');
  else if (machine.sac === 2) push('POLICY_SAC_EVALUATION');

  const staleAv = (machine.antivirus || []).filter((row) => row.stale);
  if (staleAv.length) push('POLICY_AV_STALE_REGISTRATION', { detail: '系统登记里这些产品已经不存在：' + staleAv.map((row) => row.name || '未知产品').join('、') + '。它们只是卸载后的残留条目，不代表当前装有该软件。' });

  const defenderOn = machine.defender?.realtime === true;
  if (defenderOn) {
    const norm = (value) => String(value || '').replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase();
    const roots = [String(options.installRoot || ''), String(options.packRoot || '')].filter(Boolean);
    const covered = roots.length > 0 && roots.every((root) => (machine.exclusions || []).some((item) => norm(item).startsWith(norm(root))));

    if (!covered) push('POLICY_DEFENDER_REALTIME', { canExclude: true });
  }
  const asrIndex = (machine.asrIds || []).findIndex((id) => String(id).toLowerCase() === ASR_RANSOMWARE);
  if (asrIndex >= 0 && Number((machine.asrActions || [])[asrIndex]) === 1) push('POLICY_ASR_RANSOMWARE');

  if (proc) {
    if (mitigations.blockDynamicCode === true) push('POLICY_QQ_ACG');
    if (mitigations.microsoftSignedOnly === true && mitigations.auditMicrosoftSignedOnly !== true) {
      const known = memory?.cig && memory.cig.lastOutcome === 'loaded';
      if (known) push('POLICY_QQ_CIG', { level: 'info', detail: '本机实测已成功注入过，说明这条策略在当前配置下没有拦住未签名模块；仅作提示。' });
      else if (memory?.cig && memory.cig.lastOutcome === 'blocked') push('POLICY_QQ_CIG_CONFIRMED_BLOCK');
      else push('POLICY_QQ_CIG');
    }
    if (mitigations.blockRemoteImageLoads === true) {
      if (/^\\\\/.test(stagingPath)) push('POLICY_QQ_BLOCK_REMOTE_IMAGE', { level: 'block', remedy: '把宿主中转目录改到本机磁盘（ProgramData）后重试' });
      else push('POLICY_QQ_BLOCK_REMOTE_IMAGE');
    }
    if (mitigations.blockLowLabelImageLoads === true) push('POLICY_QQ_BLOCK_LOW_LABEL');

    const selfUser = String(self.user || '').toLowerCase();
    const procOwner = String(proc.owner || '').toLowerCase();
    if (selfUser && procOwner && selfUser !== procOwner) push('POLICY_USER_MISMATCH');
    if (self.sessionId !== undefined && self.sessionId !== null && proc.sessionId !== null && Number(self.sessionId) !== Number(proc.sessionId)) {
      push('POLICY_SESSION_MISMATCH');
    }
    if (self.elevated === false) {
      // 非管理员时，QQ 若以管理员运行才会真的失败；给一条可执行的出路而不是直接判死。
      push('POLICY_ELEVATION_MISMATCH', {
        level: memory?.elevation?.lastOutcome === 'blocked' ? 'block' : 'warn',
        detail: '当前 Alcor 不是管理员。QQ 若以管理员启动，注入会被拒绝；提示里会给出「以管理员重启」。'
      });
    }
  }
  if (stagingPath && !isAscii(stagingPath)) {
    push('POLICY_STAGING_TEMP_ONLY', { detail: '宿主中转目录含非 ASCII 字符，部分机器上会加载失败；Alcor 会自动改到 ProgramData。' });
  }
  for (const item of correlateEvidence(report, options)) findings.push(item);
  push('POLICY_ONEBOT_FALLBACK');
  const blocked = findings.some((item) => item.level === 'block');
  const warned = findings.filter((item) => item.level === 'warn').length;
  const summary = findings.length === 0 ? '未发现防护或权限限制' : (blocked ? '存在会阻断注入的限制' : (warned ? '存在可能干扰的限制' : '仅有提示项'));
  return { ok: true, findings, blocked, summary };
}

const ARTIFACT_NAMES = ['alcor-host.dll', 'qq-host-loader.exe', 'alcor-runtime'];

function eventTime(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : NaN;
}
function mentionsArtifact(message) {
  const text = String(message || '').toLowerCase();
  return ARTIFACT_NAMES.filter((name) => text.includes(name));
}

/**
 * 把系统事件与 Alcor 的宿主文件对上：对得上才叫「已确认」，对不上就明确写「未确认」。
 * 只开关一个 HVCI 开关、或者只有一条 HOST_LOAD_BLOCKED，都不足以归因。
 */
export function correlateEvidence(report, options = {}) {
  const list = [];
  const add = (code, extra) => { const base = FINDING_TEXT[code]; if (base) list.push({ code, ...base, ...(extra || {}) }); };
  const events = report?.events || {};
  const lastAt = eventTime(options.lastFailure?.at);
  const windowMs = 30 * 60 * 1000;
  const inWindow = (time) => {
    const ms = eventTime(time);
    if (!Number.isFinite(ms)) return false;
    if (!Number.isFinite(lastAt)) return Date.now() - ms <= 24 * 60 * 60 * 1000;
    return Math.abs(ms - lastAt) <= windowMs;
  };
  let confirmed = false;
  for (const item of options.artifacts || []) {
    if (!item || !item.name || !item.sha256 || !item.expectedSha256) continue;
    if (String(item.sha256).toLowerCase() !== String(item.expectedSha256).toLowerCase()) {
      add('POLICY_ARTIFACT_HASH_MISMATCH', { detail: item.name + ' 的实际 SHA-256 与发布清单不一致。' });
      confirmed = true;
    }
  }
  for (const event of events.codeIntegrity || []) {
    const hits = mentionsArtifact(event.message);
    if (!hits.length || !inWindow(event.time)) continue;
    if (event.id === 3077) {
      confirmed = true;
      add('POLICY_CODE_INTEGRITY_BLOCK', { detail: '事件 3077（' + event.time + '）拒绝的模块：' + hits.join('、') });
    } else if (event.id === 3076) {
      add('POLICY_CODE_INTEGRITY_AUDIT', { detail: '事件 3076（' + event.time + '）：' + hits.join('、') });
    }
  }
  for (const event of events.defender || []) {
    const hits = mentionsArtifact(event.message);
    if (!hits.length || !inWindow(event.time)) continue;
    confirmed = true;
    add('POLICY_AV_QUARANTINE', { detail: 'Defender 事件 ' + event.id + '（' + event.time + '）命中：' + hits.join('、') });
  }
  if (!confirmed && options.lastFailure) {
    add('POLICY_EVIDENCE_UNCONFIRMED', { detail: '上次失败：' + String(options.lastFailure.code || '未知') + '（阶段 ' + String(options.lastFailure.stage || '未知') + '，' + String(options.lastFailure.at || '时间未知') + '）。' });
  }
  return list;
}

export function policyRemedies(report) {
  const list = [];
  if (!report || !report.ok) return list;
  const machine = report.machine || {};
  if (machine.defender?.realtime === true) list.push({ id: 'defender-exclusion', title: '为 Alcor 加 Defender 排除项', needsAdmin: true });
  if (report.self?.elevated === false) list.push({ id: 'relaunch-admin', title: '以管理员重启 Alcor', needsAdmin: false });
  list.push({ id: 'onebot', title: '改用 OneBot 接入（不依赖注入）', needsAdmin: false });
  return list;
}

let cache = { at: 0, pid: 0, report: null };
export async function collectPolicyReport({ pid = 0, dataDir = '', timeoutMs = 15000 } = {}) {
  const now = Date.now();
  if (cache.report && cache.pid === Number(pid) && now - cache.at < 60_000) return { ...cache.report, cached: true };
  const env = { ...process.env, ALCOR_POLICY_PID: String(Number(pid) || 0) };
  const text = await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT], {
      windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env
    }, (error, stdout) => resolve(error && !stdout ? '' : String(stdout || '')));
  });
  const report = parsePolicyReport(text);
  cache = { at: now, pid: Number(pid), report };
  return { ...report, cached: false };
}

export function readPolicyMemory(dataDir) {
  try {
    const file = path.join(dataDir, 'policy-memory.json');
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return {}; }
}

export function recordPolicyOutcome(dataDir, outcome = {}) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, 'policy-memory.json');
    const memory = readPolicyMemory(dataDir);
    const at = new Date().toISOString();
    if (outcome.cig) memory.cig = { lastOutcome: outcome.cig, at };
    if (outcome.elevation) memory.elevation = { lastOutcome: outcome.elevation, at };
    if (outcome.stage) memory.lastStage = { stage: String(outcome.stage), code: String(outcome.code || ''), at };
    fs.writeFileSync(file, JSON.stringify(memory, null, 2), 'utf8');
    return memory;
  } catch { return {}; }
}

/**
 * 把目录加进 Defender 排除项。会弹一次 UAC；脚本把结果写进 dataDir 下的结果文件，
 * 因为 Start-Process -Wait 拿不到子进程退出码。
 */
export async function addDefenderExclusion({ paths = [], dataDir, dryRun = false } = {}) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return { ok: true, added: [], skipped: true };
  const scriptPath = path.join(dataDir, 'policy-exclusion.ps1');
  const resultPath = path.join(dataDir, 'policy-exclusion.result.txt');
  const quote = (value) => "'" + String(value).split("'").join("''") + "'";
  const lines = [
    '$ErrorActionPreference = "Stop"',
    'try {',
    '  Add-MpPreference -ExclusionPath @(' + list.map(quote).join(',') + ') -ErrorAction Stop',
    '  Set-Content -LiteralPath ' + quote(resultPath) + ' -Value "OK" -Encoding UTF8',
    '} catch {',
    '  Set-Content -LiteralPath ' + quote(resultPath) + ' -Value ("FAIL " + $_.Exception.Message) -Encoding UTF8',
    '}'
  ];
  if (dryRun) return { ok: true, dryRun: true, scriptPath, script: lines.join('\n') };
  fs.writeFileSync(scriptPath, lines.join('\n'), 'utf8');
  try { fs.rmSync(resultPath, { force: true }); } catch { /* 没有旧结果就更好 */ }
  const launcher = 'Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '
    + [quote('-NoProfile'), quote('-ExecutionPolicy'), quote('Bypass'), quote('-File'), quote(scriptPath)].join(',');
  const outcome = await new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', launcher], { windowsHide: true });
    child.on('error', (error) => resolve({ ok: false, error: error.message }));
    child.on('exit', (code) => resolve({ ok: code === 0, code }));
  });
  let detail = '';
  try { detail = fs.readFileSync(resultPath, 'utf8').trim(); } catch { /* 没写出来就是没跑成 */ }
  if (outcome.ok && /^OK/.test(detail)) return { ok: true, added: list };
  return { ok: false, added: [], error: detail.replace(/^FAIL\s*/, '') || outcome.error || 'UAC 被取消，或安全软件策略不允许脚本修改排除项' };
}