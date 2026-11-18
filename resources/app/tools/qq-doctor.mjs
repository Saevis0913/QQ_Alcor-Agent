#!/usr/bin/env node
// 随包排查器：不启动界面，只读地判断「QQ 为什么连不上」，并把报告落一份到 data。
// 用法：runtime\node.exe resources\app\tools\qq-doctor.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnoseQQ, scanFrameworkDirs, qqInstallRoots, formatReport } from '../src/qq-diagnosis.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ALCOR_DATA_DIR || path.resolve(here, '../../../data');
const json = process.argv.includes('--json');

const report = { at: new Date().toISOString(), dataDir, running: false, backendReady: false, processes: [], connection: null, frameworkDirs: [], configError: '' };
let connection = null;
try {
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'alcor.config.json'), 'utf8'));
  const host = String(config?.listen?.host || '127.0.0.1');
  const port = Number(config?.listen?.port || 5310);
  const token = String(config?.listen?.token || '');
  connection = { url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`, token };
  report.backendType = config?.backend?.type || 'onebot';
} catch (error) {
  report.configError = `读不到 ${path.join(dataDir, 'alcor.config.json')}：${error.message}`;
}

async function getJson(url, token, timeout = 4000) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

if (connection) {
  try {
    const health = await getJson(`${connection.url}/health`, connection.token);
    report.running = health?.name === 'Alcor' && health?.listening === true;
    report.coreVersion = health?.version || '';
    const processes = await getJson(`${connection.url}/manage/processes`, connection.token);
    report.processes = Array.isArray(processes?.processes) ? processes.processes : [];
    report.connection = health?.backend || processes?.connection || null;
    if (report.running) {
      try {
        const status = await getJson(`${connection.url}/get_status`, connection.token);
        // 就绪以核心自述为准：/manage/processes 的 connection.receiveReady 在 native 后端恒为 false。
        // get_status 回的是 {status:'ok',retcode:0,data:{online}},没有 ok 字段。
        report.backendReady = status?.data?.online === true && health?.backend?.ws === 'open' && health?.backend?.receiveReady === true;
      } catch { /* 核心活着但后端答不上来，照样能给出进程级结论 */ }
    }
    report.frameworkDirs = scanFrameworkDirs(qqInstallRoots(report.processes));
  } catch (error) {
    report.running = false;
    report.configError = report.configError || `核心没有响应：${error.message}`;
  }
}

const verdict = diagnoseQQ(report);
if (json) {
  console.log(JSON.stringify({ report, verdict }, null, 2));
} else {
  // 先把报告落盘，再打结论：这样「判定码」永远是屏幕上的最后一行。
  try {
    const file = path.join(dataDir, `qq-doctor-${Date.now()}.log`);
    fs.writeFileSync(file, JSON.stringify({ report, verdict }, null, 2));
    console.log(`报告已写入 ${file}`);
  } catch { /* 只读运行，写不进也不影响结论 */ }
  if (report.configError) console.log(`配置：${report.configError}`);
  formatReport({ ...verdict, running: report.running, backendReady: report.backendReady });
}

const codes = { ALREADY_CONNECTED: 0, READY_TO_CONNECT: 0, RECEIVE_NOT_READY: 1, HOST_PRESENT: 1, FOREIGN_MODULES: 1, NO_QQ_RUNNING: 1, UNSUPPORTED_BUILD: 2, PROCESS_UNREADABLE: 4 };
process.exitCode = report.running ? (codes[verdict.code] ?? 3) : 3;
