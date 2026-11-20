// QQ 接入的「环境兼容」取证：版本与外来框架之外，真正会让注入失败的东西都在这里。
// 全部只读：读进程令牌、读注册表、读安装文件、跑一次加载器的空参数探针。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ -> app/ -> resources/
const alcorRoot = path.resolve(here, '../../alcor');
const loaderPath = path.join(alcorRoot, 'artifacts/native/qq-host-loader.exe');
const hostDllPath = path.join(alcorRoot, 'artifacts/native/alcor-host.dll');

const PE_MACHINE = new Map([
  [0x8664, 'x64'],
  [0x014c, 'x86'],
  [0xaa64, 'arm64'],
  [0x01c4, 'arm']
]);

/** 从 PE 头读架构：不执行文件，只读 4KB。 */
export function peArchitecture(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(4096);
      const read = fs.readSync(fd, head, 0, head.length, 0);
      if (read < 0x40 || head.toString('ascii', 0, 2) !== 'MZ') return null;
      const peOffset = head.readUInt32LE(0x3c);
      if (peOffset + 6 > read || head.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return null;
      return PE_MACHINE.get(head.readUInt16LE(peOffset + 4)) || null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

const script = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AlcorTok {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool GetTokenInformation(IntPtr token, int type, out int value, int length, out int needed);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool GetTokenInformation(IntPtr token, int type, IntPtr value, int length, out int needed);
  public static int Elevated(int pid) {
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) return -1;
    try {
      IntPtr t;
      if (!OpenProcessToken(p, 0x0008, out t)) return -2;
      try {
        int v, need;
        if (!GetTokenInformation(t, 20, out v, 4, out need)) return -3;
        return v;
      } finally { CloseHandle(t); }
    } finally { CloseHandle(p); }
  }
}
'@
function IntegrityOf([int]$ProcId) {
  try {
    $p = Get-Process -Id $ProcId -ErrorAction Stop
    $sid = $null
    try {
      $h = $p.Handle
      $sid = (New-Object Security.Principal.WindowsIdentity -ArgumentList $h).User.Value
    } catch { $sid = $null }
    [pscustomobject]@{ pid = $ProcId; sessionId = $p.SessionId; integrity = $sid }
  } catch { $null }
}
$self = [Diagnostics.Process]::GetCurrentProcess()
$rows = @(Get-Process QQ -ErrorAction SilentlyContinue | ForEach-Object {
  $elevated = -99
  try { $elevated = [AlcorTok]::Elevated($_.Id) } catch { $elevated = -98 }
  [pscustomobject]@{ pid = $_.Id; sessionId = $_.SessionId; elevated = $elevated }
})
function RegValue($path, $name) {
  try { return (Get-ItemProperty -Path $path -Name $name -ErrorAction Stop).$name } catch { return $null }
}
$hvci = RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity' 'Enabled'
$sac  = RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' 'VerifiedAndReputablePolicyState'
$lockdown = RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Config' 'VulnerableDriverBlocklistEnable'
$defender = $null
try {
  $mp = Get-MpComputerStatus -ErrorAction Stop
  $defender = [pscustomobject]@{ realtime = [bool]$mp.RealTimeProtectionEnabled; antivirus = [bool]$mp.AntivirusEnabled; amsi = [bool]$mp.AMServiceEnabled }
} catch { $defender = $null }
$out = [pscustomobject]@{
  os = [pscustomobject]@{ version = [Environment]::OSVersion.Version.ToString(); is64 = [Environment]::Is64BitOperatingSystem; arch = $env:PROCESSOR_ARCHITECTURE }
  self = [pscustomobject]@{ pid = $self.Id; sessionId = $self.SessionId; elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
  qq = @($rows)
  security = [pscustomobject]@{ hvci = $hvci; smartAppControl = $sac; driverBlocklist = $lockdown; defender = $defender }
}
ConvertTo-Json -InputObject $out -Depth 5 -Compress
`;

/** 环境取证：系统、会话、权限、安全策略。失败只丢字段，不阻断诊断。 */
export async function probeEnvironment({ timeoutMs = 12000 } = {}) {
  if (process.platform !== 'win32') return { supported: false, reason: 'NOT_WINDOWS' };
  try {
    const { stdout } = await run('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 131072 });
    const parsed = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    const qq = Array.isArray(parsed.qq) ? parsed.qq : parsed.qq ? [parsed.qq] : [];
    return { supported: true, os: parsed.os || null, self: parsed.self || null, qq, security: parsed.security || null };
  } catch (error) {
    return { supported: false, reason: error?.killed ? 'PROBE_TIMEOUT' : (error?.code ? String(error.code) : 'PROBE_FAILED') };
  }
}

/** 加载器本身能不能跑：空参数应当打印 stage=arguments 的 JSON。 */
export async function probeLoader({ timeoutMs = 8000 } = {}) {
  const facts = { path: loaderPath, exists: fs.existsSync(loaderPath), bytes: 0, ran: false, stage: null, code: null, reason: null };
  try { facts.bytes = fs.statSync(loaderPath).size; } catch { /* 文件不在下面统一报 */ }
  if (!facts.exists) { facts.reason = 'LOADER_MISSING'; return facts; }
  try {
    const { stdout } = await run(loaderPath, [], { windowsHide: true, timeout: timeoutMs, maxBuffer: 16384 });
    const parsed = JSON.parse(String(stdout || '').trim() || '{}');
    facts.ran = true;
    facts.stage = parsed.stage || null;
    facts.code = typeof parsed.status === 'number' ? parsed.status : null;
    facts.reason = facts.stage === 'arguments' ? null : 'LOADER_UNEXPECTED_OUTPUT';
  } catch (error) {
    // 参数不全时加载器会打印 stage=arguments 的 JSON 再以退出码 1 结束——这恰好证明它自己能跑。
    const stdout = String(error?.stdout || '').trim();
    if (stdout.startsWith('{')) {
      try {
        const parsed = JSON.parse(stdout);
        facts.ran = true;
        facts.stage = parsed.stage || null;
        facts.code = typeof parsed.status === 'number' ? parsed.status : null;
        facts.reason = facts.stage === 'arguments' ? null : 'LOADER_UNEXPECTED_OUTPUT';
        return facts;
      } catch { /* 落到下面的通用失败处理 */ }
    }
    facts.reason = error?.code === 'ENOENT' ? 'LOADER_MISSING'
      : error?.killed ? 'LOADER_TIMEOUT'
        : (typeof error?.code === 'number' ? `LOADER_EXIT_${error.code}` : 'LOADER_SPAWN_FAILED');
    facts.code = typeof error?.code === 'number' ? error.code : null;
  }
  return facts;
}

/** 宿主 DLL 是否完好（大小 + 是否被杀软挪走/清零）。 */
export function probeHostArtifact() {
  const facts = { path: hostDllPath, exists: fs.existsSync(hostDllPath), bytes: 0 };
  try { facts.bytes = fs.statSync(hostDllPath).size; } catch { /* 保持 0 */ }
  facts.ok = facts.exists && facts.bytes > 64 * 1024;
  return facts;
}

/** 一次把「兼容性」需要的本机事实取全。processRows 来自核心的 /manage/processes。 */
export async function probeQQCompat({ processRows = [], env = null, loader = null, hostDll = null } = {}) {
  const rows = Array.isArray(processRows) ? processRows : [];
  const environment = env || await probeEnvironment();
  const loaderFacts = loader || await probeLoader();
  const hostFacts = hostDll || probeHostArtifact();

  const qqProcs = rows
    .filter((row) => typeof row?.path === 'string' && /[\\/]QQ\.exe$/i.test(row.path))
    .map((row) => {
      const arch = peArchitecture(row.path);
      const store = /[\\/]WindowsApps[\\/]/i.test(row.path);
      return { pid: row.pid, path: row.path, arch, store, version: row.version || null, supported: row.supported === true };
    });

  const self = environment?.self || null;
  const qqSecurity = Array.isArray(environment?.qq) ? environment.qq : [];
  const elevatedQq = qqSecurity.filter((item) => item?.elevated === 1);
  const foreignSession = qqSecurity.filter((item) => self && item?.sessionId != null && item.sessionId !== self.sessionId);
  const archMismatch = qqProcs.filter((item) => item.arch && item.arch !== 'x64');

  const security = environment?.security || null;
  const hvci = security?.hvci === 1;
  const sac = security?.smartAppControl === 1 || security?.smartAppControl === 2;

  const blockers = [];
  if (!environment?.supported) blockers.push('ENV_PROBE_UNAVAILABLE');
  if (elevatedQq.length && self?.elevated === false) blockers.push('ELEVATION_MISMATCH');
  if (foreignSession.length) blockers.push('SESSION_MISMATCH');
  if (archMismatch.length) blockers.push('ARCH_MISMATCH');
  if (hvci || sac) blockers.push('SECURITY_POLICY');
  if (!loaderFacts.ran && loaderFacts.reason) blockers.push(loaderFacts.reason);
  if (!hostFacts.ok) blockers.push('HOST_ARTIFACT_MISSING');

  return {
    supported: environment?.supported === true,
    os: environment?.os || null,
    self,
    qq: qqProcs,
    security,
    loader: loaderFacts,
    hostDll: hostFacts,
    blockers,
    flags: {
      elevatedQQ: elevatedQq.map((item) => item.pid),
      foreignSession: foreignSession.map((item) => item.pid),
      archMismatch: archMismatch.map((item) => ({ pid: item.pid, arch: item.arch })),
      hvci, smartAppControl: sac,
      loaderBroken: !!loaderFacts.reason && !loaderFacts.ran,
      hostArtifactMissing: !hostFacts.ok
    }
  };
}
