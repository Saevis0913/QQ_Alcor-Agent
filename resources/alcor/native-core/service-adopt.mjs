/* 消息服务兜底：宿主在注入线程上拿不到 QQ 的 msg service（9.9.37 起它是线程局部/静态懒加载对象）。
   能在进程里找到「已经存在、但没挂到静态槽上」的 service 对象时，把它写回 profile 的 service_global
   共享指针对（对象 + 控制块），宿主下一次取服务就能正常绑定并收发。
   只在用户机器上确实存在该对象时生效：对象本身不存在时会如实报告 not-found，不做任何伪造。 */
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
public class AlcorSvc {
  const uint PROCESS_VM_OPERATION = 0x0008;
  const uint PROCESS_VM_READ = 0x0010;
  const uint PROCESS_VM_WRITE = 0x0020;
  const uint PROCESS_QUERY_INFORMATION = 0x0400;
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr written);
  [DllImport("kernel32.dll")] static extern UIntPtr VirtualQueryEx(IntPtr process, IntPtr address, out MEMORY_BASIC_INFORMATION info, IntPtr length);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, int pid);
  [StructLayout(LayoutKind.Sequential)] struct MEMORY_BASIC_INFORMATION { public IntPtr BaseAddress; public IntPtr AllocationBase; public uint AllocationProtect; public IntPtr RegionSize; public uint State; public uint Protect; public uint Type; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct MODULEENTRY32 { public uint dwSize; public uint th32ModuleID; public uint th32ProcessID; public uint GlblcntUsage; public uint ProccntUsage; public IntPtr modBaseAddr; public uint modBaseSize; public IntPtr hModule; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szModule; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExePath; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Module32First(IntPtr snapshot, ref MODULEENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Module32Next(IntPtr snapshot, ref MODULEENTRY32 entry);
  const long LOW = 0x10000L, HIGH = 0x7fffffff0000L, CHUNK = 1 << 20;
  static long ModBase(string module, int pid, out long size) {
    size = 0; IntPtr snap = CreateToolhelp32Snapshot(0x00000008 | 0x00000010, pid);
    if (snap == IntPtr.Zero) return 0;
    var entry = new MODULEENTRY32(); entry.dwSize = (uint)Marshal.SizeOf(entry);
    try {
      if (Module32First(snap, ref entry)) {
        do { if (string.Equals(entry.szModule, module, StringComparison.OrdinalIgnoreCase)) { size = entry.modBaseSize; return entry.modBaseAddr.ToInt64(); } } while (Module32Next(snap, ref entry));
      }
    } finally { CloseHandle(snap); }
    return 0;
  }
  static bool Peek(IntPtr process, long address, byte[] buffer, int size) { IntPtr read; return ReadProcessMemory(process, new IntPtr(address), buffer, new IntPtr(size), out read); }
  public static string Adopt(string pidText, string module, string vtableHex, string globalHex, string controlHex, string offsetText) {
    int pid = int.Parse(pidText);
    long vtableRva = Convert.ToInt64(vtableHex, 16), globalRva = Convert.ToInt64(globalHex, 16), controlRva = Convert.ToInt64(controlHex, 16);
    int controlOffset = int.Parse(offsetText);
    long modSize; long baseAddr = ModBase(module, pid, out modSize);
    if (baseAddr == 0) return "ERROR module-not-found";
    long vtable = baseAddr + vtableRva;
    IntPtr process = OpenProcess(PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_QUERY_INFORMATION, false, pid);
    if (process == IntPtr.Zero) return "ERROR open-process " + Marshal.GetLastWin32Error();
    var report = new StringBuilder();
    report.Append("base ").Append(baseAddr.ToString("x")).Append(" size ").Append(modSize.ToString("x")).Append(" module ").Append(module).AppendLine();
    var started = Environment.TickCount;
    long scanned = 0, address = LOW; int hits = 0; long objectPointer = 0;
    var seen = new Dictionary<long, bool>();
    var info = new MEMORY_BASIC_INFORMATION(); int infoSize = Marshal.SizeOf(info);
    var head = new byte[8]; var chunk = new byte[CHUNK];
    try {
      while (address < HIGH) {
        if (VirtualQueryEx(process, new IntPtr(address), out info, new IntPtr(infoSize)) == UIntPtr.Zero) break;
        long region = info.RegionSize.ToInt64(); long next = address + (region > 0 ? region : 0x1000);
        bool readable = info.State == 0x1000 && (info.Protect & 0x100) == 0 && (info.Protect & 0x01) == 0 && info.Protect != 0;
        if (readable && region > 0 && objectPointer == 0) {
          for (long offset = 0; offset < region; offset += CHUNK) {
            int size = (int)Math.Min(CHUNK, region - offset);
            if (!Peek(process, address + offset, chunk, size)) continue;
            scanned += size;
            for (int at = 0; at + 8 <= size; at += 8) {
              long candidate = BitConverter.ToInt64(chunk, at);
              if (candidate <= LOW || candidate >= HIGH || (candidate & 7) != 0) continue;
              bool matches;
              if (seen.TryGetValue(candidate, out matches)) { if (!matches) continue; }
              else { matches = Peek(process, candidate, head, 8) && BitConverter.ToInt64(head, 0) == vtable; seen[candidate] = matches; if (!matches) continue; }
              hits++; if (objectPointer == 0) objectPointer = candidate;
            }
            if (objectPointer != 0) break;
          }
        }
        address = next;
        if (objectPointer != 0) break;
      }
      report.Append("scan ").Append(scanned).Append(' ').Append(Environment.TickCount - started).Append(" hits ").Append(hits).AppendLine();
      if (objectPointer == 0) { report.Append("object 0 control 0").AppendLine(); report.Append("wrote false false").AppendLine(); return report.ToString(); }
      var controlBuffer = new byte[8]; long controlPointer = 0;
      if (Peek(process, objectPointer + controlOffset, controlBuffer, 8)) controlPointer = BitConverter.ToInt64(controlBuffer, 0);
      report.Append("object ").Append(objectPointer.ToString("x")).Append(' ').Append(controlPointer.ToString("x")).AppendLine();
      if (controlPointer != 0) {
        var refBuffer = new byte[4];
        if (Peek(process, controlPointer + 8, refBuffer, 4)) { int refs = BitConverter.ToInt32(refBuffer, 0) + 1; IntPtr written; WriteProcessMemory(process, new IntPtr(controlPointer + 8), BitConverter.GetBytes(refs), new IntPtr(4), out written); report.Append("refs ").Append(refs).AppendLine(); }
      }
      IntPtr stub;
      var objectBytes = BitConverter.GetBytes(objectPointer);
      var controlBytes = BitConverter.GetBytes(controlPointer);
      bool wroteObject = WriteProcessMemory(process, new IntPtr(baseAddr + globalRva), objectBytes, new IntPtr(8), out stub);
      bool wroteControl = controlPointer != 0 && WriteProcessMemory(process, new IntPtr(baseAddr + controlRva), controlBytes, new IntPtr(8), out stub);
      report.Append("wrote ").Append(wroteObject ? "true" : "false").Append(' ').Append(wroteControl ? "true" : "false").AppendLine();
    } finally { CloseHandle(process); }
    return report.ToString();
  }
}
'@
if (-not ([System.Management.Automation.PSTypeName]'AlcorSvc').Type) { Add-Type -TypeDefinition $src -Language CSharp }
[AlcorSvc]::Adopt($env:ALCOR_SVC_PID, $env:ALCOR_SVC_MODULE, $env:ALCOR_SVC_VTABLE, $env:ALCOR_SVC_GLOBAL, $env:ALCOR_SVC_CONTROL, $env:ALCOR_SVC_OFFSET)
`;

export function parseAdoptReport(text) {
  const out = { base: null, size: null, module: null, scanned: 0, millis: 0, hits: 0, object: null, control: null, wroteObject: false, wroteControl: false, error: null };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('ERROR')) { out.error = line; continue; }
    const head = /^base ([0-9a-f]+) size ([0-9a-f]+) module (\S+)$/.exec(line);
    if (head) { out.base = parseInt(head[1], 16); out.size = parseInt(head[2], 16); out.module = head[3]; continue; }
    const scan = /^scan (\d+) (\d+) hits (\d+)$/.exec(line);
    if (scan) { out.scanned = Number(scan[1]); out.millis = Number(scan[2]); out.hits = Number(scan[3]); continue; }
    const object = /^object ([0-9a-f]+) ([0-9a-f]+)$/.exec(line);
    if (object) { out.object = object[1] === '0' ? null : parseInt(object[1], 16); out.control = object[2] === '0' ? null : parseInt(object[2], 16); continue; }
    const wrote = /^wrote (true|false) (true|false)$/.exec(line);
    if (wrote) { out.wroteObject = wrote[1] === 'true'; out.wroteControl = wrote[2] === 'true'; continue; }
  }
  return out;
}

async function runPowerShell(script, env) {
  const file = path.join(os.tmpdir(), 'alcor-service-adopt.ps1');
  fs.writeFileSync(file, script, 'utf8');
  const { stdout, stderr } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
    windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return { stdout, stderr };
}

export async function adoptServicePointer({ pid, moduleName = 'wrapper.node', vtableRva, globalRva, controlRva, controlOffset = 0x48 } = {}) {
  if (!pid || !Number.isSafeInteger(vtableRva) || !Number.isSafeInteger(globalRva) || !Number.isSafeInteger(controlRva)) {
    return { ok: false, code: 'SERVICE_ADOPT_ARGS', report: null };
  }
  try {
    const { stdout, stderr } = await runPowerShell(PS_SOURCE, {
      ALCOR_SVC_PID: String(pid),
      ALCOR_SVC_MODULE: moduleName,
      ALCOR_SVC_VTABLE: vtableRva.toString(16),
      ALCOR_SVC_GLOBAL: globalRva.toString(16),
      ALCOR_SVC_CONTROL: controlRva.toString(16),
      ALCOR_SVC_OFFSET: String(controlOffset),
    });
    const report = parseAdoptReport(stdout);
    if (report.error) return { ok: false, code: 'SERVICE_ADOPT_FAILED', error: report.error, report };
    if (!report.object) return { ok: false, code: 'SERVICE_OBJECT_MISSING', report };
    if (!report.wroteObject) return { ok: false, code: 'SERVICE_ADOPT_WRITE_FAILED', report };
    return { ok: true, code: null, report, stderr: String(stderr || '').slice(0, 200) };
  } catch (error) {
    return { ok: false, code: error?.killed ? 'SERVICE_ADOPT_TIMEOUT' : 'SERVICE_ADOPT_FAILED', error: String(error?.message || error).slice(0, 200), report: null };
  }
}
