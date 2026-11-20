'use strict';
/**
 * 进程注入可行性检测（首启引导用）。
 *
 * 目标：在「连不上 QQ」之前就把机器条件查清楚，并把能自动修的项目当场修掉。
 * 只做检测与修复动作，不改变任何既有功能语义：不注入、不启动 QQ、不改配置。
 *
 * 状态语义：
 *   ok       已满足
 *   fixable  缺东西，但点一下能自动修（下载/解压/建目录）
 *   manual   必须用户自己处理（装 QQ、重启、改权限、关内存完整性）
 *   optional 只是提醒，不挡使用（例如没开 QQ 时的账号检查）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { probeLoader, probeHostArtifact, probeEnvironment, peArchitecture } from './qq-compat.js';

const VC_RUNTIME_FILES = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'];
const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

function system32() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32');
}

/** 运行库是否齐全（只看文件存在，不做 LoadLibrary，避免污染进程）。 */
export function inspectVCRuntime(dir = system32()) {
  const missing = [];
  for (const name of VC_RUNTIME_FILES) {
    try { if (!fs.statSync(path.join(dir, name)).size) missing.push(name); }
    catch { missing.push(name); }
  }
  return { ok: missing.length === 0, missing, dir };
}

/** 数据目录可写：注入日志、缓存都落在这里，只读目录会让连接看起来「莫名失败」。 */
export function inspectDataDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return { ok: true, dir };
  } catch (error) {
    return { ok: false, dir, error: String(error?.message || error) };
  }
}

function rowSupported(row) {
  return Boolean(row && row.supported === true);
}

function pickQQRows(rows) {
  return (rows || []).filter(row => row && row.pid);
}

/**
 * 汇总检测结果。compat 由 probeQQCompat 给出，processes 是 discovery 的行。
 * 所有检查都是只读的，会自动修的项只登记动作，等用户点。
 */
export async function collectInjectionCheck({ installRoot, dataDir, processRows = [], compat = null, env = null } = {}) {
  const c = compat || await probeEnvironment().catch(() => ({}));
  const e = env || await probeLoader().catch(() => ({ ok: false, error: 'probe_failed' }));
  const host = probeHostArtifact(installRoot);
  const vc = inspectVCRuntime();
  const data = inspectDataDir(dataDir || path.join(installRoot || '.', 'data'));
  const rows = pickQQRows(processRows);
  const supported = rows.filter(rowSupported);

  const items = [];
  const add = (id, label, status, detail, extra = {}) => items.push({ id, label, status, detail, ...extra });

  const osText = c?.os ? `${c.os.version || ''} · ${c.os.arch || ''}`.trim() : String(process.platform);
  add('platform', '系统与架构', (process.arch === 'x64' && c?.os?.is64 !== false) ? 'ok' : 'manual',
    process.arch === 'x64' ? osText : `当前进程是 ${process.arch}，注入组件只有 x64 版本`);

  add('vcredist', 'Visual C++ 运行库', vc.ok ? 'ok' : 'fixable',
    vc.ok ? 'vcruntime140 / msvcp140 已安装' : `缺少 ${vc.missing.join('、')}，点「自动修复」下载安装（约 25 MB）`,
    { fix: 'vcredist' });

  const loaderOk = e.ran === true && e.stage === 'arguments';
  add('loader', '注入器 qq-host-loader.exe', loaderOk ? 'ok' : 'manual',
    loaderOk ? `可运行（stage=${e.stage}，${e.bytes} B）` : `跑不起来：${e.reason || '未知原因'}。请重新安装 Alcor Agent 修复组件`,
    { detailRaw: e });

  add('hostdll', '宿主 alcor-host.dll', host.ok ? 'ok' : 'manual',
    host.ok ? `${host.bytes} B` : '文件缺失或被改动，请重新安装 Alcor Agent');

  add('datadir', '数据目录可写', data.ok ? 'ok' : 'fixable',
    data.ok ? `${data.dir}` : `不可写：${data.error}。点「自动修复」重建目录`,
    { fix: data.ok ? null : 'datadir' });

  add('qqinstall', 'QQ 客户端', rows.length ? 'ok' : 'optional',
    rows.length ? `检测到 ${rows.length} 个 QQ 进程` : '没有运行中的 QQ。装好官方 QQ 并登录后回来点「重新检测」');

  const supportedRows = rows.filter(row => row.supported === true);
  add('qqbuild', 'QQ 版本适配', supportedRows.length ? 'ok' : (rows.length ? 'manual' : 'optional'),
    supportedRows.length ? `${supportedRows[0].version || '受支持构建'} · ${supportedRows[0].architecture || 'x64'}`
      : rows.length ? '当前 QQ 的 wrapper.node 不在适配清单里，请换用受支持的版本' : '登录 QQ 后会自动检查');

  const selfElevated = c?.self?.elevated === true;
  const qqElevated = (c?.flags?.elevatedQQ || []).length > 0;
  const elevatedKnown = rows.length > 0 && c?.self?.elevated !== undefined;
  add('elevation', '权限一致', elevatedKnown ? (selfElevated === qqElevated ? 'ok' : 'manual') : 'optional',
    elevatedKnown
      ? (selfElevated === qqElevated
        ? `Alcor 与 QQ 都是${selfElevated ? '管理员' : '普通权限'}`
        : `QQ 是${qqElevated ? '管理员' : '普通权限'}，Alcor 是${selfElevated ? '管理员' : '普通权限'}——两边必须一致，请以相同方式启动`)
      : '登录 QQ 后可比较权限');

  const foreignSession = (c?.flags?.foreignSession || []).length > 0;
  add('session', 'Windows 会话一致', foreignSession ? 'manual' : 'ok',
    foreignSession ? 'QQ 与 Alcor 不在同一个登录会话（远程桌面/切换用户），请在同一会话里运行' : `会话 ${c?.self?.sessionId ?? '—'}`);

  if (c?.flags?.hvci) add('hvci', '内存完整性（HVCI）', 'manual', '已开启：可能拦住 DLL 注入。需要在「Windows 安全中心 → 设备安全性 → 内核隔离」里关闭后重启');
  if (c?.flags?.smartAppControl) add('sac', '智能应用控制', 'manual', '已开启：可能拦截未签名组件。需要在「Windows 安全中心 → 应用和浏览器控制」里调整');
  if (c?.security?.defender?.realtime) {
    add('defender', 'Defender 排除项', 'optional',
      `实时保护开启，建议把 ${installRoot || '安装目录'} 加入排除项（可选，不修也能用）`, { fix: 'defender' });
  }

  const summary = {
    ok: items.filter(i => i.status === 'ok').length,
    fixable: items.filter(i => i.status === 'fixable').length,
    manual: items.filter(i => i.status === 'manual').length,
    optional: items.filter(i => i.status === 'optional').length,
  };
  return { items, summary, compat: c, loader: e, hostDll: host, vc, data, qqProcesses: rows, checkedAt: new Date().toISOString() };
}

function run(file, args, { timeoutMs = 300000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(file, args, { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout?.on('data', d => { out += d.toString(); });
    child.stderr?.on('data', d => { err += d.toString(); });
    child.once('error', error => { clearTimeout(timer); resolve({ code: -1, out, err: err + String(error?.message || error) }); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024 * 1024) throw new Error(`下载内容过小（${buf.length} B）`);
  fs.writeFileSync(dest, buf);
  return buf.length;
}

/** 自动修复动作：每个都返回 {ok, message}，失败也不抛，交给 UI 显示。 */
export const INJECTION_FIXES = {
  async vcredist({ dataDir }) {
    const dir = path.join(dataDir, 'tools');
    const file = path.join(dir, 'vc_redist.x64.exe');
    let bytes = 0;
    try { bytes = await download(VC_REDIST_URL, file); }
    catch (error) { return { ok: false, message: `下载失败：${error.message}。可以手动到 aka.ms/vs/17/release/vc_redist.x64.exe 安装` }; }
    const done = await run(file, ['/install', '/quiet', '/norestart'], { timeoutMs: 600000 });
    if (done.code !== 0 && done.code !== 1638 && done.code !== 3010) {
      return { ok: false, message: `安装返回 ${done.code}（${(done.err || done.out || '').slice(0, 200)}）` };
    }
    return { ok: true, message: `已安装 ${(bytes / 1048576).toFixed(1)} MB 运行库，可能需要重启后生效` };
  },
  async datadir({ dataDir }) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const probe = path.join(dataDir, '.write-probe');
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      return { ok: true, message: `已重建 ${dataDir}` };
    } catch (error) { return { ok: false, message: `仍然不可写：${error.message}` }; }
  },
  async defender({ installRoot }) {
    const target = installRoot || '';
    const script = `try{ Add-MpPreference -ExclusionPath '${target.replace(/'/g, "''")}' -ErrorAction Stop; 'ok' }catch{ $_.Exception.Message }`;
    const done = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeoutMs: 120000 });
    const ok = /ok/.test(done.out || '');
    return { ok, message: ok ? '已加入 Defender 排除项' : `需要管理员权限：${(done.out || done.err || '').slice(0, 160)}` };
  },
  async elevate() {
    return { ok: false, message: '需要你手动处理：把 QQ 和 Alcor Agent 用同一种权限启动（都普通，或都管理员）' };
  },
};

export async function runInjectionFix(id, context = {}) {
  const fix = INJECTION_FIXES[id];
  if (!fix) return { ok: false, message: `没有针对 ${id} 的自动修复` };
  try { return await fix(context); }
  catch (error) { return { ok: false, message: String(error?.message || error) }; }
}

export function formatInjectionReport(result) {
  const lines = ['Alcor Agent 进程注入可行性检测', `时间：${result.checkedAt}`, ''];
  for (const item of result.items) {
    const mark = item.status === 'ok' ? '[通过]' : item.status === 'fixable' ? '[可自动修复]' : item.status === 'manual' ? '[需你处理]' : '[提示]';
    lines.push(`${mark} ${item.label}：${item.detail}`);
  }
  lines.push('', `汇总：通过 ${result.summary.ok} · 可自动修复 ${result.summary.fixable} · 需你处理 ${result.summary.manual} · 提示 ${result.summary.optional}`);
  return lines.join('\n');
}
