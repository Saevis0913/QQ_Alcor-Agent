#!/usr/bin/env node
// 随包排查器：不启动界面，只读地判断「QQ 为什么连不上」，并把报告落一份到 data。
// 用法：runtime\node.exe resources\app\tools\qq-doctor.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnoseQQ, readQQProcessSnapshot, scanFrameworkDirs, qqInstallRoots, formatReport } from '../src/qq-diagnosis.js';
import { probeQQCompat } from '../src/qq-compat.js';
import { createAlcorRuntime } from '../src/alcor-runtime.js';
import { dataDirName } from '../src/profile.js';
import { readConfigJson } from '../../alcor/src/config.mjs';
import { inspectStandardConnection } from '../src/standard-connection.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ALCOR_DATA_DIR || process.env.ALCOR_AGENT_DATA_DIR || path.resolve(here, '../../..', dataDirName());
const json = process.argv.includes('--json');

const report = { at: new Date().toISOString(), dataDir, running: false, backendReady: false,
  processes: [], connection: null, frameworkDirs: [], configError: '', processScanError: '' };
const settingsFile = path.join(dataDir, 'config.json');
const appRoot = path.resolve(here, '..');
const getSettings = () => fs.existsSync(settingsFile) ? readConfigJson(settingsFile)?.alcor : null;
const runtime = createAlcorRuntime({ dataDir, appRoot, getSettings });
const standard = fs.existsSync(path.join(appRoot, 'onebot-edition.json'));
const state = standard ? await inspectStandardConnection(getSettings).catch(() => ({
  directOneBot: true, backendType: 'onebot', running: false, backendReady: false, code: 'ONEBOT_PROBE_UNAVAILABLE'
})) : await runtime.inspect();
Object.assign(report, { running: state.running, backendReady: state.backendReady, coreCode: state.code,
  backendType: state.backendType, directOneBot: state.directOneBot, coreVersion: state.version, configError: state.error,
  connection: state.connection ?? null, statusOnline: state.statusOnline, statusError: state.statusError });
if (state.running && state.backendType === 'native') {
  try {
    const result = await runtime.manage('processes', { timeoutMs: 4000 });
    if (!result.ok) throw new Error('HTTP ' + result.status);
    const snapshot = readQQProcessSnapshot(result.body);
    report.processes = snapshot.processes;
    report.connection = { ...report.connection, ...snapshot.connection,
      receiveReady: state.receiveReady ?? snapshot.connection?.receiveReady };
    report.frameworkDirs = scanFrameworkDirs(qqInstallRoots(report.processes));
  } catch (error) { report.processScanError = error.message; }
  try { report.compat = await probeQQCompat({ processRows: report.processes }); } catch { report.compat = null; }
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
  formatReport(verdict);
}

const codes = { ALREADY_CONNECTED: 0, READY_TO_CONNECT: 0, RECEIVE_NOT_READY: 1, HOST_PRESENT: 1, FOREIGN_MODULES: 1, NO_QQ_RUNNING: 1, UNSUPPORTED_BUILD: 2, PROCESS_SCAN_FAILED: 4, PROCESS_UNREADABLE: 4, ELEVATION_MISMATCH: 5, SESSION_MISMATCH: 5, ARCH_MISMATCH: 2, HOST_RUNTIME_BROKEN: 6, INJECTION_BLOCKED: 7, PROFILE_SCANNER_MISSING: 6, PROFILE_SCAN_FAILED: 2, PROFILE_SCAN_MISMATCH: 3, PROFILE_WRAPPER_NOT_FOUND: 2, PROFILE_VERSION_UNSUPPORTED: 2, PROFILE_PATCH_FAILED: 6, PROFILE_VERIFY_FAILED: 6, PROFILE_PACK_FAILED: 6, HOST_TARGET_DENIED: 7, HOST_ALREADY_PRESENT: 7, HOST_LOAD_BLOCKED: 6, HOST_ENTRY_FAILED: 6, HOST_ARTIFACT_INVALID: 6, HOST_LOADER_MISSING: 6, HOST_LOADER_TIMEOUT: 6, HOST_LOADER_FAILED: 6, HOST_THREAD_PENDING: 6, HOST_REFERENCE_STUCK: 6, HOST_START_INCOMPLETE: 6 };
process.exitCode = codes[verdict.code] ?? 3;
