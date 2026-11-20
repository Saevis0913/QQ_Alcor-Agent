#!/usr/bin/env node
// 崩溃取证：把「双击闪退 / 事件日志里出现 0x80000003」这类问题需要的信息一次性收齐。
// 只读：不改配置、不动数据、不上传任何东西。产物写到 data\crash-report-<时间>.txt。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const DATA = process.env.ALCOR_AGENT_DATA_DIR || path.join(ROOT, 'data');

const lines = [];
const add = (title) => { lines.push('', '══ ' + title + ' ══'); };
const put = (label, value) => { lines.push(String(label).padEnd(22, ' ') + ' ' + (value ?? '')); };

function ps(command) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch (error) {
    return '（查询失败：' + String(error?.message || error).slice(0, 120) + '）';
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function tail(file, count) {
  try {
    const text = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    return text.slice(-count);
  } catch { return []; }
}

const pkg = readJson(path.join(ROOT, 'resources', 'app', 'package.json')) || {};

add('基本信息');
put('生成时间', new Date().toISOString());
put('程序版本', pkg.version || '未知');
put('安装目录', ROOT);
put('数据目录', DATA);
put('系统', `${os.type()} ${os.release()} ${os.arch()}`);
put('CPU', `${os.cpus()?.[0]?.model || ''} × ${os.cpus()?.length || 0}`);
put('内存', `${Math.round(os.totalmem() / 1048576)} MB（可用 ${Math.round(os.freemem() / 1048576)} MB）`);
put('Node', process.version);
put('是否管理员', ps('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'));
put('会话 ID', ps('(Get-Process -Id $PID).SessionId'));

add('会干扰启动的环境变量');
for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) {
  put(name + '（本进程）', process.env[name] === undefined ? '未设置' : process.env[name]);
  put(name + '（用户级）', ps(`[Environment]::GetEnvironmentVariable('${name}','User')`) || '未设置');
  put(name + '（系统级）', ps(`[Environment]::GetEnvironmentVariable('${name}','Machine')`) || '未设置');
}

add('安全策略 / 拦截面');
put('HVCI 内存完整性', ps(`$k='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity'; if (Test-Path $k) { (Get-ItemProperty $k).Enabled } else { '未配置' }`));
put('智能应用控制', ps(`$k='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy'; if (Test-Path $k) { (Get-ItemProperty $k).VerifiedAndReputablePolicyState } else { '未配置' }`));
put('Defender 实时保护', ps(`(Get-MpPreference).DisableRealtimeMonitoring`));
put('Defender 排除项', ps(`((Get-MpPreference).ExclusionPath -join '; ')`));
put('第三方安全软件', ps(`Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | ForEach-Object { $_.displayName }`) || '（读不到）');

add('崩溃痕迹');
const dumps = (() => { try { return fs.readdirSync(path.join(DATA, 'crash-dumps')).filter((n) => /\.dmp$/i.test(n)); } catch { return []; } })();
put('崩溃转储 (data/crash-dumps)', dumps.length ? dumps.join(', ') : '无');
put('连续失败计数', JSON.stringify(readJson(path.join(DATA, 'crash-count.json')) || {}));
put('启动标记 .starting', fs.existsSync(path.join(DATA, '.starting')) ? '存在（上次没走到就绪）' : '不存在');
const boot = tail(path.join(DATA, 'boot-diag.log'), 40);
lines.push('', '── data/boot-diag.log 最后 40 行 ──');
lines.push(...(boot.length ? boot : ['（没有这个文件：程序在写日志之前就退出了）']));

add('事件日志（应用错误，最近 10 条）');
const events = ps(`Get-WinEvent -FilterHashtable @{LogName='Application'; Level=1,2; StartTime=(Get-Date).AddDays(-7)} -MaxEvents 60 -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'Alcor|QQ.exe|OpenQQ' } | Select-Object -First 10 | ForEach-Object { '{0} | {1} | {2}' -f $_.TimeCreated, $_.ProviderName, (($_.Message -split [char]10)[0..3] -join ' / ') }`);
lines.push(events || '（最近 7 天没有相关错误事件）');

add('运行库与端口');
put('vcruntime140.dll', fs.existsSync(path.join(ROOT, 'vcruntime140.dll')) ? '有' : '没有');
put('vcruntime140_1.dll', fs.existsSync(path.join(ROOT, 'vcruntime140_1.dll')) ? '有' : '没有');
put('5320 端口占用', ps(`(Get-NetTCPConnection -LocalPort 5320 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { (Get-Process -Id $_.OwningProcess).ProcessName }) -join ','`) || '空闲');
put('QQ 进程', ps(`(Get-Process QQ -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id):$($_.Path)" }) -join ' / '`) || '没在运行');
put('QQ 安装目录', ps(`$k='HKLM:\\SOFTWARE\\WOW6432Node\\Tencent\\QQNT'; if (Test-Path $k) { (Get-ItemProperty $k).InstallDir } else { '' }`) || '未登记');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.join(DATA, `crash-report-${stamp}.txt`);
try {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(out, lines.join('\r\n') + '\r\n', 'utf8');
} catch (error) {
  console.error('写报告失败：' + error.message);
  console.log(lines.join('\n'));
  process.exit(1);
}

console.log(lines.join('\n'));
console.log('\n报告已保存：' + out);
console.log('把这个文件发给作者即可（里面不含聊天记录、令牌与密码）。');
