#!/usr/bin/env node
/** qq-version-matrix.mjs — QQ 版本矩阵：一次命令看清任意 QQ 版本的适配结论（离线自证）。
 *
 * 结论四值：
 *   builtin      内建命中：wrapper.node sha256 在 native-core/qq-profiles.mjs 登记表里，
 *                随包 loader/DLL 直通，无需推导（matchesBuiltin=true，另附随包 DLL 槽位自证）。
 *   derived      现场推导：扫描器从 wrapper 复原 14 个 RVA，打成成对补丁包，
 *                自证字段 slot1DigestMatches / loaderEmbedsDllSha 双双为 true。
 *   unsupported  版本层不支持：版本号缺失/超长（PROFILE_VERSION_UNSUPPORTED）或
 *                不在 9.9.33–9.9.45 同系列区间（QQ_FAMILY_OUT_OF_RANGE）。
 *   rejected     本文件无法验证：扫描失败/签名不唯一/校验不过等完整性问题。
 *
 * 用法：
 *   node qq-version-matrix.mjs <wrapper.node | QQ根目录>... [--version 9.9.36-53644]
 *        [--json] [--repo <Alcor-Agent 仓库>] [--pack-root <目录>] [--keep]
 *
 * 版本号解析顺序：--version > 路径 versions/<版本>/resources/app/wrapper.node。
 * 未登记 wrapper 没有版本号时无法推导（verdict=unsupported）。
 *
 * 依赖（默认 D:/Alcor-源码/Alcor-Agent，可用 --repo 或环境变量 ALCOR_SOURCE_REPO 覆盖）：
 *   resources/alcor/native-core/qq-profiles.mjs    内建登记表（findQQBuildProfile/matchQQFamily）
 *   resources/alcor/native-core/host-profiles.mjs  推导 + 成对补丁包（ensureProfilePack/_internals）
 *   resources/alcor/tools/qq-profile-scan.mjs      离线 RVA 扫描器（--json）
 *   resources/alcor/artifacts/native/{alcor-host.dll,qq-host-loader.exe}
 *
 * 全程离线：不联网；除 --pack-root（默认临时目录，用后即删）外不写任何位置，绝不写 QQ 安装目录。
 * 退出码：0=全部 builtin/derived；1=存在 unsupported/rejected；2=用法错误。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_REPO = process.env.ALCOR_SOURCE_REPO || 'D:/Alcor-源码/Alcor-Agent';
const USAGE = '用法: node qq-version-matrix.mjs <wrapper.node|QQ根目录>... [--version V] [--json] [--repo PATH] [--pack-root DIR] [--keep]';

function parseArgs(argv) {
  const o = { paths: [], version: null, json: false, repo: DEFAULT_REPO, packRoot: null, keep: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--version') o.version = argv[++i];
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--pack-root') o.packRoot = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--')) throw new Error('未知参数: ' + a);
    else o.paths.push(a);
  }
  return o;
}

export function discoverWrappers(target) {
  const abs = path.resolve(target);
  let st;
  try { st = fs.statSync(abs); } catch { return []; }
  if (st.isFile()) return [abs];
  const found = [];
  const direct = path.join(abs, 'resources', 'app', 'wrapper.node');
  if (fs.existsSync(direct)) found.push(direct);
  const versionsDir = path.join(abs, 'versions');
  if (fs.existsSync(versionsDir)) {
    for (const e of fs.readdirSync(versionsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(versionsDir, e.name, 'resources', 'app', 'wrapper.node');
      if (fs.existsSync(p)) found.push(p);
    }
  }
  return found;
}

function inferVersionFromPath(p) {
  const m = /[/\\]versions[/\\]([^/\\]+)[/\\]resources[/\\]app[/\\]wrapper\.node$/i.exec(p);
  return m ? m[1] : null;
}

async function loadCore(repo) {
  const nc = path.join(repo, 'resources', 'alcor', 'native-core');
  const hp = await import(pathToFileURL(path.join(nc, 'host-profiles.mjs')).href);
  const qp = await import(pathToFileURL(path.join(nc, 'qq-profiles.mjs')).href);
  return { hp, qp };
}

export async function makeContext({ repo = DEFAULT_REPO, version = null, packRoot = null, keep = false } = {}) {
  const core = await loadCore(repo);
  return { ...core, repo, version, packRoot, keep };
}

/** 单份 wrapper 的适配结论。ctx 来自 makeContext（version/packRoot 为调用级默认，可被路径推断覆盖顺序约束）。 */
export async function classifyWrapper(wrapperPath, ctx) {
  const abs = path.resolve(wrapperPath);
  const base = { wrapper: abs };
  let st;
  try { st = fs.statSync(abs); } catch { return { ...base, verdict: 'rejected', reason: 'WRAPPER_NOT_FOUND: ' + abs }; }
  if (!st.isFile()) return { ...base, verdict: 'rejected', reason: 'WRAPPER_NOT_FOUND: 不是常规文件: ' + abs };
  const buf = fs.readFileSync(abs);
  const sha256 = ctx.hp._internals.sha256hex(buf);
  const out = { ...base, size: buf.length, sha256 };

  // ---- 内建命中：直通，不 staging、不拷贝 ----
  const builtin = ctx.qp.findQQBuildProfile('wrapper.node', sha256);
  if (builtin) {
    // 自证：随包 alcor-host.dll 的 profile 表里确实登记了这个 sha，且版本/RVA 一致
    let builtinSlotInDll = null;
    try {
      const dllBuf = fs.readFileSync(path.join(ctx.repo, 'resources', 'alcor', 'artifacts', 'native', 'alcor-host.dll'));
      const table = ctx.hp._internals.locateProfileTable(dllBuf);
      const hit = table.find(e => e.sha256 === sha256);
      if (hit && hit.version === builtin.version && hit.rvas.join(',') === Object.values(builtin.rvas).join(',')) builtinSlotInDll = table.indexOf(hit);
    } catch {}
    return {
      ...out, verdict: 'builtin', matchesBuiltin: true, builtinVersion: builtin.version,
      verification: builtin.verification, builtinSlotInDll, rvas: builtin.rvas,
      note: '内建命中：随包 loader/DLL 直通，无需推导',
    };
  }
  out.matchesBuiltin = false;

  if (path.basename(abs).toLowerCase() !== 'wrapper.node') {
    return { ...out, verdict: 'rejected', reason: 'WRONG_MODULE: 文件名必须是 wrapper.node，收到 ' + path.basename(abs) };
  }

  // ---- 版本层：先版本号，后家族区间 ----
  const version = ctx.version || inferVersionFromPath(abs);
  if (!version) {
    return {
      ...out, verdict: 'unsupported',
      reason: 'PROFILE_VERSION_UNSUPPORTED: 未登记的 wrapper 需要版本号（--version 或 versions/<版本>/resources/app/wrapper.node 目录布局）才能推导',
    };
  }
  out.version = version;
  if (!ctx.qp.matchQQFamily('wrapper.node', version)) {
    return { ...out, verdict: 'unsupported', reason: 'QQ_FAMILY_OUT_OF_RANGE: ' + version + ' 不在 9.9.33–9.9.45 同系列区间' };
  }

  // ---- 现场推导 + 成对补丁包（packRoot 缺省为一次性临时目录） ----
  const packRoot = ctx.packRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'qq-matrix-'));
  const packRootOwned = !ctx.packRoot;
  try {
    const pack = await ctx.hp.ensureProfilePack({ moduleName: 'wrapper.node', sha256, version, wrapperPath: abs, packRoot });
    // ---- 离线自证：盘上字节为准 ----
    const dllBuf = fs.readFileSync(pack.dll);
    const loaderBuf = fs.readFileSync(pack.loader);
    const dllSha = ctx.hp._internals.sha256hex(dllBuf);
    const table = ctx.hp._internals.locateProfileTable(dllBuf);
    const slotIdx = table.findIndex(e => e.sha256 === sha256);
    const slot1DigestMatches = slotIdx === 1 &&
      dllBuf.slice(table[slotIdx].digestOff, table[slotIdx].digestOff + 32).equals(Buffer.from(sha256, 'hex'));
    const loaderTable = ctx.hp._internals.locateProfileTable(loaderBuf);
    const loaderSlotIdx = loaderTable.findIndex(e => e.sha256 === sha256);
    const loaderEmbedsDllSha = loaderBuf.includes(Buffer.from(dllSha, 'latin1')) && loaderSlotIdx === 1;
    return {
      ...out, verdict: 'derived', derived: true, cached: pack.cached, version: pack.profile.version,
      packDir: pack.packDir, slot1DigestMatches, loaderEmbedsDllSha, rvas: pack.profile.rvas,
    };
  } catch (e) {
    const code = e && e.code ? e.code : 'PROFILE_PACK_FAILED';
    const verdict = code === 'PROFILE_VERSION_UNSUPPORTED' ? 'unsupported' : 'rejected';
    return { ...out, verdict, reason: code + ': ' + (e && e.detail ? e.detail : (e && e.message ? e.message : String(e))) };
  } finally {
    if (packRootOwned && !ctx.keep) { try { fs.rmSync(packRoot, { recursive: true, force: true }); } catch {} }
  }
}

function printTable(results) {
  for (const r of results) {
    console.log(r.wrapper);
    console.log('  sha256    ' + (r.sha256 || '-') + '  (' + (r.size || '?') + ' bytes)');
    let line = '  verdict   ' + r.verdict;
    if (r.matchesBuiltin !== undefined) line += '  matchesBuiltin=' + r.matchesBuiltin;
    if (r.builtinVersion) line += '  builtin=' + r.builtinVersion + ' (' + r.verification + ')';
    if (r.builtinSlotInDll !== null && r.builtinSlotInDll !== undefined) line += '  dllSlot=' + r.builtinSlotInDll;
    console.log(line);
    if (r.verdict === 'derived') {
      console.log('  version   ' + r.version + '  cached=' + r.cached);
      console.log('  pack      ' + r.packDir);
      console.log('  selftest  slot1DigestMatches=' + r.slot1DigestMatches + '  loaderEmbedsDllSha=' + r.loaderEmbedsDllSha);
    }
    if (r.reason) console.log('  reason    ' + r.reason);
  }
  const counts = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  console.log('汇总: ' + Object.entries(counts).map(kv => kv.join('=')).join(' '));
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); console.error(USAGE); process.exit(2); }
  if (opts.help) { console.log(USAGE); process.exit(0); }
  if (!opts.paths.length) { console.error(USAGE); process.exit(2); }
  const coreMarker = path.join(opts.repo, 'resources', 'alcor', 'native-core', 'host-profiles.mjs');
  if (!fs.existsSync(coreMarker)) { console.error('仓库不可用: ' + opts.repo + '（用 --repo 或 ALCOR_SOURCE_REPO 指定 Alcor-Agent 仓库）'); process.exit(2); }
  const ctx = await makeContext(opts);
  const targets = [];
  for (const p of opts.paths) {
    const w = discoverWrappers(p);
    if (!w.length) console.error('找不到 wrapper.node: ' + p);
    targets.push(...w);
  }
  if (!targets.length) process.exit(2);
  const results = [];
  for (const t of targets) results.push(await classifyWrapper(t, ctx));
  if (opts.json) console.log(JSON.stringify(results, null, 2));
  else printTable(results);
  const bad = results.filter(r => r.verdict !== 'builtin' && r.verdict !== 'derived').length;
  process.exit(bad ? 1 : 0);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) main().catch(e => { console.error(e && e.stack ? e.stack : String(e)); process.exit(2); });