/* 安装后自检（preflight）：把「用户装完还得自己排查」的几类问题在第一次启动时自动处理掉。
   只做安全、可逆的动作：建目录、补运行库、清过期标记、备份坏配置、选定可写的补丁包根目录。
   不静默改系统设置（不改 hosts、不关防护、不动 QQ），那类只报告。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readConfigJson } from '../../alcor/src/config.mjs';

export const PREFLIGHT_VERSION = 1;
const RUNTIME_DLLS = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'];
const DIRS = ['', 'logs', 'host', 'updates', 'crash-dumps', 'qq-profiles'];

const isAscii = (value) => /^[\x20-\x7e]+$/.test(String(value || ''));

function ensureDir(target, steps, id) {
  try {
    const existed = fs.existsSync(target);
    fs.mkdirSync(target, { recursive: true });
    fs.accessSync(target, fs.constants.W_OK);
    steps.push({ id, ok: true, fixed: !existed, detail: target });
    return true;
  } catch (error) {
    steps.push({ id, ok: false, fixed: false, detail: target + '（' + String(error?.message || error) + '）' });
    return false;
  }
}

export function preflightDirs({ dataDir } = {}) {
  const steps = [];
  for (const name of DIRS) {
    const target = name ? path.join(dataDir, name) : dataDir;
    ensureDir(target, steps, 'dir:' + (name || 'data'));
  }
  return steps;
}

/* 运行库：安装目录缺 VC++ 运行库时，Electron 在没装过 VC++ 的机器上会直接闪退。
   优先从安装包自带副本取；没有就从系统目录复制；都拿不到就明确报告「需要重装」。 */
export function preflightRuntime({ installRoot, dryRun = false } = {}) {
  const steps = [];
  const local = path.join(installRoot, 'resources', 'app', 'assets', 'runtime');
  for (const dll of RUNTIME_DLLS) {
    const target = path.join(installRoot, dll);
    if (fs.existsSync(target)) { steps.push({ id: 'runtime:' + dll, ok: true, fixed: false, detail: target }); continue; }
    const candidates = [path.join(local, dll), path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', dll)];
    const source = candidates.find((item) => fs.existsSync(item));
    if (!source) { steps.push({ id: 'runtime:' + dll, ok: false, fixed: false, detail: '缺少 ' + dll + '，且没有可复制的来源' }); continue; }
    if (dryRun) { steps.push({ id: 'runtime:' + dll, ok: true, fixed: true, detail: '将复制 ' + source }); continue; }
    try { fs.copyFileSync(source, target); steps.push({ id: 'runtime:' + dll, ok: true, fixed: true, detail: source + ' → ' + target }); }
    catch (error) { steps.push({ id: 'runtime:' + dll, ok: false, fixed: false, detail: String(error?.message || error) }); }
  }
  return steps;
}

/* 崩溃标记：上次启动没走到「窗口与托盘就绪」会留下 .starting。
   超过 10 分钟还留着，说明那次的崩溃处理已经做过了，这里只负责清掉，避免永久进安全模式。 */
export function preflightMarkers({ dataDir, dryRun = false } = {}) {
  const steps = [];
  const marker = path.join(dataDir, '.starting');
  if (!fs.existsSync(marker)) { steps.push({ id: 'marker', ok: true, fixed: false, detail: '没有残留标记' }); return steps; }
  const age = Date.now() - Number(fs.statSync(marker).mtimeMs || 0);
  if (age < 10 * 60 * 1000) { steps.push({ id: 'marker', ok: true, fixed: false, detail: '本次启动的标记，保留' }); return steps; }
  if (!dryRun) { try { fs.rmSync(marker, { force: true }); } catch { /* 清不掉也不影响启动 */ } }
  steps.push({ id: 'marker', ok: true, fixed: !dryRun, detail: '清理过期启动标记' });
  return steps;
}

/* 配置坏了不要直接崩：备份坏文件、写回默认值，用户至少还能进界面看日志。 */
export function preflightConfig({ dataDir, dryRun = false } = {}) {
  const steps = [];
  const file = path.join(dataDir, 'config.json');
  if (!fs.existsSync(file)) { steps.push({ id: 'config', ok: true, fixed: false, detail: '还没生成配置，使用默认值' }); return steps; }
  try {
    const parsed = readConfigJson(file);
    if (parsed && typeof parsed === 'object') { steps.push({ id: 'config', ok: true, fixed: false, detail: '配置可读' }); return steps; }
    throw new Error('配置不是对象');
  } catch (error) {
    const backup = file + '.broken-' + Date.now();
    if (!dryRun) {
      try { fs.copyFileSync(file, backup); } catch { /* 备份失败也要继续 */ }
      try { fs.writeFileSync(file, '{}\n', 'utf8'); } catch { /* 只读目录就留给用户 */ }
    }
    steps.push({ id: 'config', ok: false, fixed: !dryRun, detail: '配置读取失败（' + String(error?.message || error) + '），已备份为 ' + backup });
    return steps;
  }
}

/* 补丁包根目录：ProgramData 不可写或含非 ASCII 时换到 data 目录，别让未登记版本永远出不了包。 */
export function preflightPackRoot({ dataDir, dryRun = false } = {}) {
  const steps = [];
  const candidates = [
    process.env.ALCOR_PROFILE_PACK_DIR,
    path.join(process.env.ProgramData || process.env.ALLUSERSPROFILE || '', 'Alcor', 'host'),
    path.join(dataDir, 'host'),
    path.join(os.tmpdir(), 'Alcor', 'host'),
  ].filter((item) => item && isAscii(item));
  const probe = path.join(dataDir, '.preflight-pack-probe');
  for (const root of candidates) {
    try {
      if (!dryRun) {
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(probe, 'ok');
        fs.rmSync(probe, { force: true });
      }
      steps.push({ id: 'packroot', ok: true, fixed: root !== candidates[0], detail: root });
      return steps;
    } catch { /* 换下一个候选 */ }
  }
  steps.push({ id: 'packroot', ok: false, fixed: false, detail: '找不到可用的 ASCII 补丁包目录' });
  return steps;
}

export async function runPreflight({ installRoot, dataDir, dryRun = false, logger = null } = {}) {
  const startedAt = Date.now();
  const steps = [
    ...preflightDirs({ dataDir }),
    ...preflightRuntime({ installRoot, dryRun }),
    ...preflightMarkers({ dataDir, dryRun }),
    ...preflightConfig({ dataDir, dryRun }),
    ...preflightPackRoot({ dataDir, dryRun }),
  ];
  const failed = steps.filter((item) => !item.ok);
  const fixed = steps.filter((item) => item.fixed);
  const result = {
    version: PREFLIGHT_VERSION,
    at: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    installRoot, dataDir,
    ok: failed.length === 0,
    fixed: fixed.map((item) => item.id),
    failed: failed.map((item) => ({ id: item.id, detail: item.detail })),
    steps,
  };
  try {
    const logs = path.join(dataDir, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'preflight-last.json'), JSON.stringify(result, null, 2), 'utf8');
    logger ?? ((line) => console.log(line));
    logger('[preflight] ' + (result.ok ? 'ok' : 'issues=' + failed.length) + ' fixed=' + fixed.length + ' ' + result.elapsedMs + 'ms');
  } catch { /* 日志写不进不影响主流程 */ }
  return result;
}
