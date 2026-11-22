/* identity 的兜底读法：宿主在注入线程上取不到 QQ 的 service（9.9.37 起 service 是线程局部对象），
   但账号 uin 在 wrapper.node 的静态单例里（profile 的 account_pair），可以直接只读进程内存拿到。
   这里只做「读」：OpenProcess + 模块基址 + ReadProcessMemory，不改 QQ 任何字节。
   需要 PowerShell 编译一小段 P/Invoke，首次约 1 秒，之后加载已编译程序集很快。 */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

const PS_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class AlcorMem {
  const uint PROCESS_VM_READ = 0x0010;
  const uint PROCESS_QUERY_INFORMATION = 0x0400;
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, int pid);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct MODULEENTRY32 { public uint dwSize; public uint th32ModuleID; public uint th32ProcessID; public uint GlblcntUsage; public uint ProccntUsage; public IntPtr modBaseAddr; public uint modBaseSize; public IntPtr hModule; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szModule; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExePath; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Module32First(IntPtr snapshot, ref MODULEENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Module32Next(IntPtr snapshot, ref MODULEENTRY32 entry);
  public static string Read(string pidText, string module, string rvaList) {
    int pid = int.Parse(pidText);
    IntPtr snap = CreateToolhelp32Snapshot(0x00000008 | 0x00000010, pid);
    if (snap == IntPtr.Zero) return "ERROR snapshot";
    var mod = new MODULEENTRY32(); mod.dwSize = (uint)Marshal.SizeOf(mod);
    long baseAddr = 0; long baseSize = 0; string found = "";
    try {
      if (Module32First(snap, ref mod)) {
        do {
          if (string.Equals(mod.szModule, module, StringComparison.OrdinalIgnoreCase)) { baseAddr = mod.modBaseAddr.ToInt64(); baseSize = mod.modBaseSize; found = mod.szModule; break; }
        } while (Module32Next(snap, ref mod));
      }
    } finally { CloseHandle(snap); }
    if (baseAddr == 0) return "ERROR module-not-found";
    IntPtr process = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid);
    if (process == IntPtr.Zero) return "ERROR open-process";
    var sb = new StringBuilder();
    sb.Append("base ").Append(baseAddr.ToString("x")).Append(" size ").Append(baseSize.ToString("x")).Append(" module ").Append(found).AppendLine();
    try {
      foreach (var item in rvaList.Split(',')) {
        if (item.Trim().Length == 0) continue;
        long rva = Convert.ToInt64(item.Trim(), 16);
        var buf = new byte[16];
        IntPtr read;
        bool ok = ReadProcessMemory(process, new IntPtr(baseAddr + rva), buf, new IntPtr(16), out read);
        if (!ok) { sb.Append("rva ").Append(item.Trim()).Append(" unreadable").AppendLine(); continue; }
        ulong lo = BitConverter.ToUInt64(buf, 0), hi = BitConverter.ToUInt64(buf, 8);
        sb.Append("rva ").Append(item.Trim()).Append(" ").Append(lo.ToString("x")).Append(" ").Append(hi.ToString("x")).AppendLine();
      }
    } finally { CloseHandle(process); }
    return sb.ToString();
  }
}
'@
if (-not ([System.Management.Automation.PSTypeName]'AlcorMem').Type) { Add-Type -TypeDefinition $src -Language CSharp }
[AlcorMem]::Read($env:ALCOR_MEM_PID, $env:ALCOR_MEM_MODULE, $env:ALCOR_MEM_RVAS)
`;

export function parseMemoryDump(text) {
  const out = { base: null, size: null, module: null, values: {}, error: null };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('ERROR')) { out.error = line; continue; }
    const base = /^base ([0-9a-f]+) size ([0-9a-f]+) module (\S+)/.exec(line);
    if (base) { out.base = parseInt(base[1], 16); out.size = parseInt(base[2], 16); out.module = base[3]; continue; }
    const value = /^rva ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+)$/.exec(line);
    if (value) { out.values[value[1]] = { lo: BigInt('0x' + value[2]), hi: BigInt('0x' + value[3]) }; continue; }
    if (/^rva [0-9a-f]+ unreadable$/.test(line)) out.values[line.split(' ')[1]] = null;
  }
  return out;
}

async function runPowerShell(script, env) {
  const file = path.join(os.tmpdir(), 'alcor-mem-read.ps1');
  fs.writeFileSync(file, script, 'utf8');
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
    windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return stdout;
}

export async function readIdentityMemory({ pid, moduleName = 'wrapper.node', rvas, timeoutMs = 20000 } = {}) {
  const list = (rvas || []).filter(Boolean).map((v) => Number(v).toString(16)).join(',');
  if (!pid || !list) return { ok: false, code: 'IDENTITY_MEMORY_ARGS', account: null };
  try {
    const text = await runPowerShell(PS_SOURCE, {
      ALCOR_MEM_PID: String(pid), ALCOR_MEM_MODULE: moduleName, ALCOR_MEM_RVAS: list,
    });
    const dump = parseMemoryDump(text);
    if (dump.error || !dump.base) return { ok: false, code: 'IDENTITY_MEMORY_UNREADABLE', detail: dump.error || 'no base', account: null };
    return { ok: true, ...dump };
  } catch (error) {
    return { ok: false, code: 'IDENTITY_MEMORY_FAILED', detail: String(error?.message || error).slice(0, 200), account: null };
  }
}

/* 从 account_pair 读当前登录 uin：两个 qword 必须一致且落在合理 uin 区间，
   否则当没读到（宁可让上层报 QQ_LOGIN_NOT_CONFIRMED，也不要编一个账号）。 */
export function pickAccount(values, rva) {
  const slot = values?.[Number(rva).toString(16)];
  if (!slot) return null;
  const { lo, hi } = slot;
  if (lo !== hi) return null;
  if (lo < 10000n || lo > 4000000000n) return null;
  return lo.toString();
}
