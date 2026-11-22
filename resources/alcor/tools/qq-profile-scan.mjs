#!/usr/bin/env node
/**
 * qq-profile-scan.mjs — offline RVA recovery for QQ NT wrapper.node (x64).
 *
 * Derives the 14 profile RVAs (native-core/qq-profiles.mjs schema) from a
 * wrapper.node binary without a disassembler, using anchors reverse-engineered
 * from the 9.9.36-53644 reference build:
 *
 *   service_vtable / core_vtable  MSVC RTTI scan for .?AVMSFService@nt@@ and
 *                                 .?AVMSFCoreService@nt@@ -> COL -> vtable.
 *   service_getter / globals      singleton getter shape: one function holds both
 *                                 a 48 8b 05 load and a 48 8d 0d lea to the same
 *                                 .data-bss global; the getter is found as a direct
 *                                 caller of the functions that lea the class vtable;
 *                                 service_getter additionally calls the core getter
 *                                 (cross-checked).
 *   release / string_* /          function-start byte signatures (rel32/disp8
 *   callback_* / send / receive   immediates wildcarded), each must hit exactly once
 *                                 in .text and (where applicable) be a .pdata begin.
 *   account_pair                  function-local-static accessor: a function with
 *                                 two lea rax -> T sites to the same bss struct plus
 *                                 a 83 3d .. ff guard cmp; the account pair field is
 *                                 at T+8. T is constrained to the MSF global cluster
 *                                 behind core_global.
 *
 * Self-verification: when the file sha256 matches a build known to
 * native-core/qq-profiles.mjs, every recovered RVA is compared against that
 * profile and any mismatch fails the run (exit 1 with a reason on stderr).
 *
 * Usage: node qq-profile-scan.mjs <path-to-wrapper.node> [--json] [--debug]
 * Exit:  0 = all 14 recovered uniquely (and verified when profile known)
 *        1 = failure (reason printed on stderr)
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

const IMAGE_BASE = 0x180000000n;

function fail(reason) {
  console.error('qq-profile-scan: FAIL: ' + reason);
  process.exit(1);
}
function debug(enabled, ...args) { if (enabled) console.error('[debug]', ...args); }

// ---------- CLI ----------
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const debugMode = args.includes('--debug') || !!process.env.QQ_SCAN_DEBUG;
const fileArg = args.find(a => !a.startsWith('--'));
if (!fileArg) fail('usage: node qq-profile-scan.mjs <wrapper.node> [--json] [--debug]');
if (basename(fileArg).toLowerCase() !== 'wrapper.node') fail('WRONG_MODULE: expected a wrapper.node binary, got ' + basename(fileArg));

let buf;
try { buf = readFileSync(fileArg); } catch (e) { fail('READ_ERROR: ' + e.message); }

// ---------- minimal PE model ----------
function parsePE(b) {
  if (b.length < 0x400 || b.readUInt16LE(0) !== 0x5a4d) fail('BAD_PE: missing MZ header');
  const pe = b.readUInt32LE(0x3c);
  if (b.readUInt32LE(pe) !== 0x4550) fail('BAD_PE: missing PE signature');
  if (b.readUInt16LE(pe + 4) !== 0x8664) fail('BAD_PE: not an x64 image');
  const opt = pe + 24;
  if (b.readUInt16LE(opt) !== 0x20b) fail('BAD_PE: not PE32+');
  const numSec = b.readUInt16LE(pe + 6);
  const optSize = b.readUInt16LE(pe + 20);
  const secTab = opt + optSize;
  const sections = [];
  for (let i = 0; i < numSec; i++) {
    const o = secTab + i * 40;
    sections.push({
      name: b.toString('ascii', o, o + 8).replace(/\0.*$/, ''),
      vsize: b.readUInt32LE(o + 8), va: b.readUInt32LE(o + 12),
      rsize: b.readUInt32LE(o + 16), roff: b.readUInt32LE(o + 20),
    });
  }
  const ddBase = opt + 112; // PE32+ data directories
  const pdataRva = b.readUInt32LE(ddBase + 3 * 8), pdataSize = b.readUInt32LE(ddBase + 3 * 8 + 4);
  return { sections, pdataRva, pdataSize };
}
const pe = parsePE(buf);
const rva2off = rva => {
  for (const s of pe.sections)
    if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rsize) && rva - s.va < s.rsize) return s.roff + (rva - s.va);
  return -1;
};
const text = pe.sections.find(s => s.name === '.text');
const rdata = pe.sections.find(s => s.name === '.rdata');
const dataSec = pe.sections.find(s => s.name === '.data');
if (!text || !rdata || !dataSec) fail('BAD_PE: expected .text/.rdata/.data sections');
const bssLo = dataSec.va + dataSec.rsize, bssHi = dataSec.va + dataSec.vsize;

// .pdata function table (sorted by begin)
const fns = [];
{
  const po = rva2off(pe.pdataRva);
  if (po < 0 || !pe.pdataSize) fail('BAD_PE: .pdata exception directory not mapped');
  const n = Math.floor(pe.pdataSize / 12);
  for (let i = 0; i < n; i++) fns.push([buf.readUInt32LE(po + i * 12), buf.readUInt32LE(po + i * 12 + 4)]);
  fns.sort((a, b) => a[0] - b[0]);
}
const fnBegins = new Set(fns.map(f => f[0]));
function findFn(rva) {
  let lo = 0, hi = fns.length - 1, ans = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (fns[m][0] <= rva) { ans = fns[m]; lo = m + 1; } else hi = m - 1; }
  return ans && rva < ans[1] ? ans : null;
}

// ---------- one-pass .text sweep: call sites + rip-relative lea/load sites ----------
const callSitesByTarget = new Map();    // target rva -> [site rva]  (e8 rel32)
const leaSitesByTarget = new Map();     // target rva -> [{site, reg}] (48 8d /r, mod=00 rm=101)
const loadRaxSitesByTarget = new Map(); // target rva -> [site rva]  (48 8b 05)
function push(map, k, v) { const a = map.get(k); if (a) a.push(v); else map.set(k, [v]); }
{
  const s = text.roff, e = text.roff + text.rsize;
  for (let o = s; o + 7 <= e; o++) {
    const b0 = buf[o];
    if (b0 === 0xe8) {
      const site = text.va + (o - s);
      push(callSitesByTarget, (site + 5 + buf.readInt32LE(o + 1)) >>> 0, site);
      continue;
    }
    if (b0 !== 0x48) continue;
    const op = buf[o + 1], m = buf[o + 2];
    if ((m & 0xc7) !== 0x05) continue;
    const site = text.va + (o - s);
    const tgt = (site + 7 + buf.readInt32LE(o + 3)) >>> 0;
    if (op === 0x8d) push(leaSitesByTarget, tgt, { site, reg: (m >> 3) & 7 });
    else if (op === 0x8b && m === 0x05) push(loadRaxSitesByTarget, tgt, site);
  }
}
debug(debugMode, 'sweep: ' + callSitesByTarget.size + ' call targets, ' + leaSitesByTarget.size + ' lea targets, ' + loadRaxSitesByTarget.size + ' load targets');

// ---------- helpers ----------
function callersOf(fnBegin) {
  const set = new Set();
  for (const site of callSitesByTarget.get(fnBegin) ?? []) {
    const f = findFn(site);
    if (f) set.add(f[0]);
  }
  return [...set];
}
function fnsLeaTargeting(rva) {
  const set = new Set();
  for (const { site } of leaSitesByTarget.get(rva) ?? []) {
    const f = findFn(site);
    if (f) set.add(f[0]);
  }
  return [...set];
}
// singleton getter: fn holding both a 48 8b 05 load and a 48 8d 0d lea (rcx) to the same bss X
function singletonGetters() {
  const out = [];
  const seen = new Set();
  for (const [x, loadSites] of loadRaxSitesByTarget) {
    if (x < bssLo || x >= bssHi) continue;
    const leaSites = (leaSitesByTarget.get(x) ?? []).filter(s => s.reg === 1); // rcx
    if (!leaSites.length) continue;
    const loadFnSet = new Set(loadSites.map(s => { const f = findFn(s); return f ? f[0] : -1; }));
    for (const ls of leaSites) {
      const f = findFn(ls.site);
      if (f && loadFnSet.has(f[0])) {
        const key = f[0] + ':' + x;
        if (!seen.has(key)) { seen.add(key); out.push({ fn: f[0], global: x }); }
      }
    }
  }
  return out;
}
function fnCalls(fnBegin, targetBegin) {
  const f = fns.find(x => x[0] === fnBegin);
  if (!f) return false;
  return (callSitesByTarget.get(targetBegin) ?? []).some(site => site >= f[0] && site < f[1]);
}

// ---------- byte signatures ----------
function parsePattern(hex) {
  return hex.trim().split(/\s+/).map(t => (t === '??' ? null : parseInt(t, 16)));
}
function scanPattern(pat) {
  // anchor on the longest run of concrete bytes
  let bestStart = 0, bestLen = 0, runStart = 0, runLen = 0;
  for (let i = 0; i <= pat.length; i++) {
    if (i < pat.length && pat[i] !== null) {
      if (runLen === 0) runStart = i;
      runLen++;
    } else {
      if (runLen > bestLen) { bestLen = runLen; bestStart = runStart; }
      runLen = 0;
    }
  }
  if (bestLen < 4) fail('INTERNAL: signature lacks a concrete anchor run');
  const anchor = Buffer.from(pat.slice(bestStart, bestStart + bestLen));
  const hits = [];
  let idx = text.roff - bestStart;
  while (true) {
    idx = buf.indexOf(anchor, idx + bestStart);
    if (idx === -1) break;
    const pos = idx - bestStart;
    idx = idx - bestStart + 1;
    if (pos < text.roff || pos + pat.length > text.roff + text.rsize) continue;
    let ok = true;
    for (let i = 0; i < pat.length; i++) if (pat[i] !== null && buf[pos + i] !== pat[i]) { ok = false; break; }
    if (ok) hits.push(text.va + (pos - text.roff));
  }
  return hits;
}
function uniqueSignature(name, hex, requireBegin) {
  const hits = scanPattern(parsePattern(hex));
  if (hits.length !== 1) fail('SIGNATURE_NOT_UNIQUE: ' + name + ' produced ' + hits.length + ' hits (' + hits.slice(0, 8).map(h => '0x' + h.toString(16)).join(',') + (hits.length > 8 ? ',...' : '') + ')');
  if (requireBegin && !fnBegins.has(hits[0])) fail('SIGNATURE_NOT_BEGIN: ' + name + ' hit 0x' + hits[0].toString(16) + ' is not a .pdata function begin');
  return hits[0];
}

// ---------- RTTI -> vtable ----------
function findVtableByRtti(className) {
  const needle = Buffer.from(className, 'ascii');
  const names = [];
  let idx = -1;
  while ((idx = buf.indexOf(needle, idx + 1)) !== -1) names.push(idx);
  if (names.length !== 1) fail('RTTI_NAME_NOT_UNIQUE: ' + className + ' produced ' + names.length + ' string hits');
  // TypeDescriptor: {vfvptr(8), spare(8), name...}; name starts at TD+16
  const nameOff = names[0];
  const sec = pe.sections.find(s => nameOff >= s.roff && nameOff < s.roff + s.rsize);
  if (!sec) fail('RTTI_NAME_UNMAPPED: ' + className);
  const tdRva = sec.va + (nameOff - sec.roff) - 16;
  // find COL: dword(p+12)==tdRva, dword(p) in {0,1} (signature), inside .rdata.
  // Base-class subobjects have their own COLs pointing at the same TypeDescriptor;
  // the primary locator is the one whose offset-to-top (dword at p+4) is zero.
  const cols = [];
  const tb = Buffer.alloc(4); tb.writeUInt32LE(tdRva >>> 0);
  let c = rdata.roff - 13;
  while (true) {
    c = buf.indexOf(tb, c + 1);
    if (c === -1) break;
    const p = c - 12;
    if (p < rdata.roff || c + 8 > rdata.roff + rdata.rsize) continue;
    const sig = buf.readUInt32LE(p);
    if (sig !== 0 && sig !== 1) continue;
    if (buf.readInt32LE(p + 4) !== 0) continue; // base-class locator, skip
    cols.push(rdata.va + (p - rdata.roff));
  }
  // find vtables: qword in .rdata equal to IMAGE_BASE + colRva; vtable begins 8 bytes after it
  const vtSet = new Set();
  for (const col of cols) {
    const ptr = Buffer.alloc(8); ptr.writeBigUInt64LE(IMAGE_BASE + BigInt(col));
    let v = rdata.roff - 1;
    while (true) {
      v = buf.indexOf(ptr, v + 1);
      if (v === -1) break;
      if (v > rdata.roff + rdata.rsize - 8) break;
      if (v >= rdata.roff) vtSet.add(rdata.va + (v - rdata.roff) + 8);
    }
  }
  const vts = [...vtSet];
  if (vts.length !== 1) fail('VTABLE_NOT_UNIQUE: ' + className + ' produced ' + vts.length + ' vtable hits (' + vts.map(x => '0x' + x.toString(16)).join(',') + ')');
  return vts[0];
}

// ---------- run the recovery ----------
const recovered = {};
recovered.service_vtable = findVtableByRtti('.?AVMSFService@nt@@');
recovered.core_vtable = findVtableByRtti('.?AVMSFCoreService@nt@@');
debug(debugMode, 'service_vtable=0x' + recovered.service_vtable.toString(16) + ' core_vtable=0x' + recovered.core_vtable.toString(16));

// singleton getters -> service_getter + service_global + core_global
{
  const getters = singletonGetters();
  debug(debugMode, 'singleton getter candidates: ' + getters.length);
  const pick = (vtableRva, label) => {
    const refFns = fnsLeaTargeting(vtableRva);
    const callerSet = new Set();
    for (const rf of refFns) for (const cc of callersOf(rf)) callerSet.add(cc);
    const cands = getters.filter(g => callerSet.has(g.fn));
    if (cands.length !== 1) fail('GETTER_NOT_UNIQUE: ' + label + ' produced ' + cands.length + ' candidates (' + cands.map(cc => 'fn=0x' + cc.fn.toString(16) + '/g=0x' + cc.global.toString(16)).join(',') + ')');
    return cands[0];
  };
  const svc = pick(recovered.service_vtable, 'service');
  const core = pick(recovered.core_vtable, 'core');
  if (svc.fn === core.fn) fail('GETTER_COLLISION: service and core resolved to the same function');
  if (!fnCalls(svc.fn, core.fn)) fail('GETTER_CHAIN_BROKEN: service getter does not call the core getter');
  recovered.service_getter = svc.fn;
  recovered.service_global = svc.global;
  recovered.core_global = core.global;
  debug(debugMode, 'service_getter=0x' + svc.fn.toString(16) + ' service_global=0x' + svc.global.toString(16) + ' core_global=0x' + core.global.toString(16));
}

// account_pair: thread-safe local-static accessor in the MSF cluster. Shape
// (MSVC /Zc:threadSafeInit): the function returns &T via lea rax, guards it with
// 83 3d ->G ff (Init_thread epoch), and the guard sits 0x80 bytes behind the
// account struct. Callers of the accessor consume [rax+8], so the pair is T+8.
{
  const clusterLo = recovered.core_global, clusterHi = recovered.core_global + 0x8000;
  const cands = [];
  for (const [t, sites] of leaSitesByTarget) {
    if (t < clusterLo || t >= clusterHi) continue;
    const raxSites = sites.filter(s => s.reg === 0);
    if (!raxSites.length) continue;
    const fnSet = new Set(raxSites.map(s => { const f = findFn(s.site); return f ? f[0] : -1; }));
    if (fnSet.size !== 1 || fnSet.has(-1)) continue;
    const f = fns.find(x => x[0] === [...fnSet][0]);
    const fStart = rva2off(f[0]), fEnd = rva2off(f[1]);
    if (fStart < 0 || fEnd < 0) continue;
    // guard cmp: 83 3d disp32 ff with target G == T + 0x80, inside the same function
    let guardOk = false;
    for (let o = fStart; o + 7 <= fEnd; o++) {
      if (buf[o] === 0x83 && buf[o + 1] === 0x3d && buf[o + 6] === 0xff) {
        const siteRva = text.va + (o - text.roff);
        const g = (siteRva + 7 + buf.readInt32LE(o + 2)) >>> 0;
        if (g === t + 0x80) { guardOk = true; break; }
      }
    }
    if (guardOk) cands.push(t);
  }
  if (cands.length !== 1) fail('ACCOUNT_ACCESSOR_NOT_UNIQUE: produced ' + cands.length + ' candidates (' + cands.map(cc => '0x' + cc.toString(16)).join(',') + ')');
  recovered.account_pair = cands[0] + 8;
  debug(debugMode, 'account struct=0x' + cands[0].toString(16) + ' account_pair=0x' + recovered.account_pair.toString(16));
}

// function-start signatures (layout-dependent immediates wildcarded)
// release: leaf inline (mov rcx,[rcx+8]; test rcx,rcx; jne T; ret) whose slow
// path T is the atomic refcount decrement stub (sub rsp,0x20; mov eax,-1;
// lock xadd [rcx+8],eax). The raw shape appears 5 times in .text; only the real
// one jumps into the refcount stub, so disambiguate on the jump target prologue.
{
  const base = parsePattern('48 8b 49 08 48 85 c9 0f 85 ?? ?? ?? ?? c3');
  const stub = parsePattern('83 ec 20 b8 ff ff ff ff f0 0f c1 41 08');
  const cands = scanPattern(base).filter(hit => {
    const rel = buf.readInt32LE(rva2off(hit) + 9);
    const tgt = (hit + 15 + rel) >>> 0;
    const to = rva2off(tgt);
    if (to < 0 || to + stub.length > buf.length) return false;
    for (let i = 0; i < stub.length; i++) if (stub[i] !== null && buf[to + i] !== stub[i]) return false;
    return true;
  });
  if (cands.length !== 1) fail('SIGNATURE_NOT_UNIQUE: release produced ' + cands.length + ' refcount-stub-backed hits (' + cands.map(h => '0x' + h.toString(16)).join(',') + ')');
  recovered.release = cands[0];
  debug(debugMode, 'release=0x' + cands[0].toString(16));
}
recovered.string_construct = uniqueSignature('string_construct',
  '41 56 56 57 53 48 83 ec 28 48 89 cf 49 83 f8 f0 73 ?? 4c 89 c6 48 89 d3 49 83 f8 17 73 ?? 8d 04 36 88 07', true);
recovered.string_destroy = uniqueSignature('string_destroy',
  'f6 01 01 75 01 c3 48 8b 49 10 e9 ?? ?? ?? ?? cc', false);
// send is recovered before callback_move: it is the anchor that disambiguates.
recovered.send = uniqueSignature('send',
  '55 41 57 41 56 41 55 41 54 56 57 53 48 81 ec f8 01 00 00 48 8d ac 24 80 00 00 00 48 c7 85 70 01 00 00 fe ff ff ff 48 83 79 60 00', true);
// callback_move: 76-byte move-constructor template for the 16-byte callback
// storage; the same template is instantiated ~30 times for other wrapper types,
// so byte shape alone cannot separate them. The MSF instance is the one the
// recovered send() calls directly to move the caller's callback into the
// pending request.
{
  const hits = scanPattern(parsePattern('56 57 48 83 ec 38 48 89 d6 48 89 cf 48 83 c1 10 48 89 7c 24 20 48 c7 44 24 28 10 00 00 00 41 b9 10 00 00 00 31 d2 49 89 f0 ff 56 10'));
  const hitSet = new Set(hits);
  const sendFn = findFn(recovered.send);
  if (!sendFn) fail('INTERNAL: send not covered by .pdata');
  const s0 = rva2off(sendFn[0]), s1 = rva2off(sendFn[1]);
  const cands = [];
  for (let p = s0; p + 5 <= s1; p++) {
    if (buf[p] !== 0xe8) continue;
    const site = text.va + (p - text.roff);
    const tgt = (site + 5 + buf.readInt32LE(p + 1)) >>> 0;
    if (hitSet.has(tgt) && !cands.includes(tgt)) cands.push(tgt);
  }
  if (cands.length !== 1) fail('SIGNATURE_NOT_UNIQUE: callback_move produced ' + cands.length + ' send-called candidates (' + cands.map(h => '0x' + h.toString(16)).join(',') + ')');
  recovered.callback_move = cands[0];
  debug(debugMode, 'callback_move=0x' + cands[0].toString(16) + ' (called by send)');
}
recovered.callback_present = uniqueSignature('callback_present',
  '48 83 ec 28 48 83 c1 10 e8 ?? ?? ?? ?? 34 01 48 83 c4 28 c3', true);
recovered.callback_destroy = uniqueSignature('callback_destroy',
  '55 48 83 ec 40 48 8d 6c 24 40 48 c7 45 f8 fe ff ff ff 49 89 c8 48 83 c1 10 49 8b 40 10 0f 57 c0 0f 11 44 24 20 6a 03 5a 6a 10 41 59 ff d0', true);
recovered.receive = uniqueSignature('receive',
  '55 41 57 41 56 41 55 41 54 56 57 53 48 81 ec 28 01 00 00 48 8d ac 24 80 00 00 00 48 c7 85 a0 00 00 00 fe ff ff ff 44 89 c6 48 89 8d 90 00 00 00 48 83 3a 00', true);

const FIELD_ORDER = ['service_getter', 'release', 'string_construct', 'string_destroy', 'callback_move', 'callback_present', 'callback_destroy', 'service_global', 'core_global', 'service_vtable', 'core_vtable', 'account_pair', 'send', 'receive'];

// ---------- confidence gate ----------
// 结构大改的版本宁可判低置信度，也不要拿猜错的偏移去打补丁：
// ① 每个 RVA 必须落在 .text（代码段）里；② 14 个字段不得互相重复。
const CODE_FIELDS = ['service_getter', 'release', 'string_construct', 'string_destroy', 'callback_move',
  'callback_present', 'callback_destroy', 'send', 'receive'];
const textLo = text.va, textHi = text.va + Math.max(text.vsize, text.rsize);
const outsideText = CODE_FIELDS.filter(f => recovered[f] < textLo || recovered[f] >= textHi);
if (outsideText.length) {
  fail('PROFILE_SCAN_LOW_CONFIDENCE: ' + outsideText.length + ' code RVAs land outside .text ('
    + outsideText.map(f => f + '=0x' + recovered[f].toString(16)).join(', ') + ')');
}
// 数据类字段允许落在 .data 的未初始化区（.bss 部分没有文件字节），只要求被某个区段覆盖。
const inAnySection = (rva) => pe.sections.some(s2 => rva >= s2.va && rva < s2.va + Math.max(s2.vsize, s2.rsize));
const unmapped = FIELD_ORDER.filter(f => !inAnySection(recovered[f]));
if (unmapped.length) {
  fail('PROFILE_SCAN_LOW_CONFIDENCE: ' + unmapped.length + ' RVAs are not mapped by any section ('
    + unmapped.map(f => f + '=0x' + recovered[f].toString(16)).join(', ') + ')');
}
const duplicated = FIELD_ORDER.filter((f, index) => FIELD_ORDER.findIndex(other => recovered[other] === recovered[f]) !== index);
if (duplicated.length) fail('PROFILE_SCAN_LOW_CONFIDENCE: duplicate RVA across fields: ' + duplicated.join(', '));

// ---------- sha256 + self-verification against known profiles ----------
const sha256 = createHash('sha256').update(buf).digest('hex');
let profile = null, profileError = null;
try {
  const mod = await import(new URL('../native-core/qq-profiles.mjs', import.meta.url));
  profile = mod.findQQBuildProfile('wrapper.node', sha256);
} catch (e) { profileError = e.message; }

let selfCheck = null;
if (profile) {
  const mismatches = FIELD_ORDER.filter(f => profile.rvas[f] !== recovered[f]);
  selfCheck = { version: profile.version, matched: FIELD_ORDER.length - mismatches.length, total: FIELD_ORDER.length, mismatches };
  if (mismatches.length) {
    const detail = mismatches.map(f => f + ': recovered=0x' + recovered[f].toString(16) + ' expected=0x' + profile.rvas[f].toString(16)).join('; ');
    fail('SELF_CHECK_MISMATCH: ' + mismatches.length + '/' + FIELD_ORDER.length + ' RVAs diverge from profile ' + profile.version + ' -- ' + detail);
  }
}

const hexRvas = Object.fromEntries(FIELD_ORDER.map(f => [f, '0x' + recovered[f].toString(16)]));
if (jsonMode) {
  console.log(JSON.stringify({
    file: fileArg, module: 'wrapper.node', architecture: 'x64', sha256,
    profile: profile ? { version: profile.version, verification: profile.verification } : null,
    profileLoadError: profileError,
    rvas: hexRvas,
    selfCheck,
  }, null, 2));
} else {
  console.log('file      ' + fileArg);
  console.log('sha256    ' + sha256);
  console.log('profile   ' + (profile ? profile.version + ' (' + profile.verification + ')' : '(unknown build)'));
  for (const f of FIELD_ORDER) console.log(f.padEnd(18) + hexRvas[f]);
  if (selfCheck) console.log('self-check ' + selfCheck.matched + '/' + selfCheck.total + ' exact vs ' + selfCheck.version);
}