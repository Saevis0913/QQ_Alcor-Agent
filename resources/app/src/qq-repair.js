// 修复动作：只做两件事——关掉 QQ（清掉驻留的注入模块）和重新拉起它。
// 不删除任何框架文件，也不改别人的安装目录。
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(file, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout }, (error, stdout, stderr) => {
      resolve({ ok: !error, error: error?.message || '', stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export function qqExecutable(processes = []) {
  for (const row of processes) {
    if (typeof row?.path === 'string' && /[\\/]QQ\.exe$/i.test(row.path) && fs.existsSync(row.path)) return row.path;
  }
  return '';
}

/** QQ 没在运行时也能找到它：先看注册表登记，再看常见安装位置。 */
export async function locateQQExecutable() {
  const keys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\QQNT',
    'HKLM\\SOFTWARE\\Tencent\\QQNT',
    'HKCU\\Software\\Tencent\\QQNT',
  ];
  const script = keys.map((k) => `(Get-ItemProperty '${k}' -ErrorAction SilentlyContinue).InstallDir`).join(';');
  const probe = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 12000);
  const fromReg = String(probe.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidates = [
    ...fromReg.map((dir) => dir.replace(/[\\/]+$/, '') + '\\QQ.exe'),
    'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
    'C:\\Program Files (x86)\\Tencent\\QQNT\\QQ.exe',
    'D:\\QQ\\QQ.exe',
    'D:\\Program Files\\Tencent\\QQNT\\QQ.exe',
  ];
  for (const file of candidates) { try { if (fs.statSync(file).isFile()) return file; } catch { /* 下一个 */ } }
  return '';
}

/** 关掉所有 QQ 进程，等它们真的退出，再从原路径重新启动。 */
export async function restartQQ({ listProcesses }) {
  const before = await listProcesses();
  const exe = qqExecutable(before);
  if (!exe) return { ok: false, code: 'QQ_PATH_UNKNOWN', error: '读不到 QQ.exe 的路径，请手动关闭并重开 QQ' };

  await run('taskkill.exe', ['/IM', 'QQ.exe', '/F', '/T']);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await delay(400);
    const rows = await listProcesses();
    if (!rows.length) break;
  }
  const remaining = await listProcesses();
  if (remaining.length) return { ok: false, code: 'QQ_STILL_RUNNING', error: 'QQ 还没有完全退出，请在任务栏退出后重试' };

  const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { ok: true, launched: exe };
}

/** 等 QQ 起来并加载账号模块，最多等 timeoutMs。 */
export async function waitForQQ({ listProcesses, timeoutMs = 40_000 }) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    await delay(800);
    last = await listProcesses();
    if (last.some((row) => row?.moduleName === 'wrapper.node')) return last;
  }
  return last;
}
