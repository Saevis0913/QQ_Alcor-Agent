#!/usr/bin/env node
'use strict';
/**
 * 命令行版「进程注入可行性检测」。
 *
 * 用途：用户连不上 QQ 时先跑这个（也可以由支持人员远程指导执行），
 * 输出与本机控制台首启弹窗完全一致的检测项与结论。
 * 只读：不注入、不启动 QQ、不改配置。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectInjectionCheck, formatInjectionReport } from '../src/injection-doctor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const installRoot = path.resolve(here, '../../..');
const dataDir = process.env.ALCOR_DATA_DIR || path.join(installRoot, 'data');

function readToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'alcor.config.json'), 'utf8'));
    return { token: cfg?.listen?.token || '', http: cfg?.listen?.http?.url || 'http://127.0.0.1:5310' };
  } catch { return { token: '', http: 'http://127.0.0.1:5310' }; }
}

async function readProcesses() {
  const { token, http } = readToken();
  if (!token) return [];
  try {
    const res = await fetch(`${http}/manage/processes`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) });
    const body = await res.json();
    return Array.isArray(body?.processes) ? body.processes : [];
  } catch { return []; }
}

const processes = await readProcesses();
const result = await collectInjectionCheck({ installRoot, dataDir, processRows: processes });
const text = formatInjectionReport(result);
console.log(text);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const reportPath = path.join(dataDir, `injection-check-${stamp}.log`);
try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(reportPath, text); console.log(`\n报告已保存：${reportPath}`); }
catch { /* 目录不可写时只打印 */ }
const blocking = result.summary.fixable + result.summary.manual;
process.exit(blocking > 0 ? 1 : 0);
