#!/usr/bin/env node
// profile-pack.mjs -- produce a paired loader+DLL patch pack for any QQ version.
// In-scope: D:/Alcor-work/pack/

import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ORIGINAL_DLL = 'D:/Alcor/resources/alcor/artifacts/native/alcor-host.dll';
const ORIGINAL_LOADER = 'D:/Alcor/resources/alcor/artifacts/native/qq-host-loader.exe';
const PATCHER = 'D:/Alcor-work/patch/host-profile-patch.mjs';
const NODE = 'D:/Alcor/runtime/node.exe';

const ANCHOR_VERSION = '9.9.36-53644';
const ANCHOR_SHA256 = '0d8b94448f4dafe7337b88d6a568b004224c37fcbe2bd1142c1af7624fbd534c';
const SHA_HEX_LEN = 64;
const PROFILE_QWORDS = 16;

function parseArgs(argv) {
  const out = { json: false, slot: 1, dll: ORIGINAL_DLL, loader: ORIGINAL_LOADER, patcher: PATCHER };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--wrapper-node') out.wrapperNode = argv[++i];
    else if (a === '--profile') out.profile = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--dll') out.dll = argv[++i];
    else if (a === '--loader') out.loader = argv[++i];
    else if (a === '--patcher') out.patcher = argv[++i];
    else if (a === '--slot') out.slot = parseInt(argv[++i], 10);
    else if (a === '--json') out.json = true;
    else if (a === '--help') out.help = true;
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node profile-pack.mjs --wrapper-node <wrapper.node> --out <dir> [--json]');
  console.log('  node profile-pack.mjs --wrapper-node <wrapper.node> --profile <profile.json> --out <dir> [--json] [--slot 0|1]');
}

function sha256Buffer(buf) { return createHash('sha256').update(buf).digest('hex'); }

function isDigits(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return true;
}

function isVersion(str) {
  const idx = str.indexOf('-');
  const ver = idx < 0 ? str : str.slice(0, idx);
  const build = idx < 0 ? null : str.slice(idx + 1);
  if (build !== null && !isDigits(build)) return false;
  const segs = ver.split('.');
  if (segs.length !== 3) return false;
  return segs.every(isDigits);
}

function isHex64(s) {
  if (s.length !== 64) return false;
  for (let i = 0; i < 64; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46))) return false;
  }
  return true;
}

function inferVersionFromPath(p) {
  const parts = p.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i].toLowerCase() === 'versions') {
      const cand = parts[i + 1];
      if (isVersion(cand)) return cand;
    }
  }
  const parent = basename(dirname(p));
  if (isVersion(parent)) return parent;
  throw new Error('Cannot infer version from wrapper.node path: ' + p);
}

function parseDllTableEntries(buf) {
  const shaOff = buf.indexOf(ANCHOR_SHA256);
  if (shaOff < 0) throw new Error('Anchor sha256 not found in DLL');
  let v0end = shaOff - 1;
  if (buf[v0end] !== 0) throw new Error('Bad anchor layout in DLL');
  let v0start = v0end - 1;
  while (v0start >= 0 && buf[v0start] !== 0) v0start--;
  v0start++;
  const version0 = buf.slice(v0start, v0end).toString('ascii');
  if (!isVersion(version0)) throw new Error('Bad version0 in DLL');
  const tableStart = v0start - PROFILE_QWORDS * 8;
  if (tableStart < 0) throw new Error('Bad DLL table start');
  const entries = [];
  let cursor = tableStart + PROFILE_QWORDS * 8;
  while (cursor < buf.length) {
    while (cursor < buf.length && buf[cursor] === 0) cursor++;
    let end = cursor;
    while (end < buf.length && buf[end] !== 0 && end - cursor < 128) end++;
    if (end === cursor || buf[end] !== 0) break;
    const version = buf.slice(cursor, end).toString('ascii');
    if (!isVersion(version)) break;
    cursor = end + 1;
    if (cursor + SHA_HEX_LEN > buf.length) break;
    const sha = buf.slice(cursor, cursor + SHA_HEX_LEN).toString('ascii');
    if (!isHex64(sha)) break;
    entries.push({ version, sha256: sha.toLowerCase() });
    cursor += SHA_HEX_LEN;
  }
  if (entries.length < 2) throw new Error('Expected 2 DLL table entries, found ' + entries.length);
  return entries;
}

function parseLoaderTableEntries(buf) {
  const shaOff = buf.indexOf(ANCHOR_SHA256);
  if (shaOff < 0) throw new Error('Anchor sha256 not found in loader');
  const v1start = shaOff + SHA_HEX_LEN + 1;
  if (v1start >= buf.length || buf[v1start] === 0) throw new Error('Bad loader table layout');
  let v1end = v1start;
  while (v1end < buf.length && buf[v1end] !== 0 && v1end - v1start < 128) v1end++;
  if (buf[v1end] !== 0) throw new Error('Loader version1 not terminated');
  const version1 = buf.slice(v1start, v1end).toString('ascii');
  const sha1off = v1end + 1;
  if (sha1off + SHA_HEX_LEN > buf.length) throw new Error('Loader sha1 truncated');
  const sha1 = buf.slice(sha1off, sha1off + SHA_HEX_LEN).toString('ascii');
  if (!isHex64(sha1)) throw new Error('Loader sha1 not hex');
  return [
    { version: ANCHOR_VERSION, sha256: ANCHOR_SHA256 },
    { version: version1, sha256: sha1.toLowerCase() }
  ];
}

function replaceAll(buf, needle, replacement) {
  const n = Buffer.from(needle, 'ascii');
  const r = Buffer.from(replacement, 'ascii');
  let off = 0;
  let count = 0;
  while ((off = buf.indexOf(n, off)) !== -1) {
    r.copy(buf, off);
    off += n.length;
    count++;
  }
  return count;
}

function patchLoaderTableSlot(buf, slot, version, sha256) {
  const shaOff = buf.indexOf(ANCHOR_SHA256);
  if (shaOff < 0) throw new Error('Anchor sha256 not found in loader');
  let versionOffset, shaOffset;
  if (slot === 0) {
    let v0end = shaOff - 1;
    let v0start = v0end - 1;
    while (v0start >= 0 && buf[v0start] !== 0) v0start--;
    v0start++;
    versionOffset = v0start;
    shaOffset = shaOff;
  } else {
    let v1start = shaOff + SHA_HEX_LEN + 1;
    let v1end = v1start;
    while (v1end < buf.length && buf[v1end] !== 0 && v1end - v1start < 128) v1end++;
    if (buf[v1end] !== 0) throw new Error('Loader version1 not terminated');
    versionOffset = v1start;
    shaOffset = v1end + 1;
  }
  const capacity = shaOffset + SHA_HEX_LEN - versionOffset;
  const maxVersionLen = capacity - 1 - SHA_HEX_LEN;
  if (version.length > maxVersionLen) throw new Error('version too long for loader slot ' + slot + ': ' + version.length + ' > ' + maxVersionLen);
  const sha = sha256.toLowerCase();
  if (!isHex64(sha)) throw new Error('sha256 must be 64 hex chars');
  buf.write(version, versionOffset, 'ascii');
  buf[versionOffset + version.length] = 0;
  const shaWriteOffset = versionOffset + version.length + 1;
  buf.write(sha, shaWriteOffset, 'ascii');
}

function buildTarget(args) {
  const wrapperBuf = readFileSync(args.wrapperNode);
  const wrapperHash = sha256Buffer(wrapperBuf);
  const originalDllBuf = readFileSync(args.dll);
  const entries = parseDllTableEntries(originalDllBuf);
  const matched = entries.find(e => e.sha256 === wrapperHash);
  if (args.profile) {
    const json = JSON.parse(readFileSync(args.profile, 'utf8'));
    if (!json.version || !json.sha256 || !Array.isArray(json.rvas) || json.rvas.length !== 14) {
      throw new Error('Profile JSON must have version, sha256, rvas[14]');
    }
    return { source: 'profile', version: json.version, sha256: json.sha256.toLowerCase(), rvas: json.rvas.map(v => v.toString()) };
  }
  if (!matched) throw new Error('wrapper.node not in table and no --profile provided');
  return { source: 'table', version: matched.version, sha256: matched.sha256, rvas: null };
}

function patchDllWithPatcher(args, target) {
  const outDll = resolve(args.out, 'alcor-host.dll');
  const profPath = resolve(args.out, '.profile-tmp.json');
  writeFileSync(profPath, JSON.stringify({ version: target.version, sha256: target.sha256, rvas: target.rvas }));
  execFileSync(NODE, [args.patcher, '--in', args.dll, '--out', outDll, '--profile', profPath, '--slot', String(args.slot)], { encoding: 'utf8', stdio: 'pipe' });
  return readFileSync(outDll);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); return 0; }
  if (!args.wrapperNode) { console.error('Missing --wrapper-node'); usage(); return 1; }
  if (!args.out) { console.error('Missing --out'); usage(); return 1; }

  mkdirSync(args.out, { recursive: true });
  const target = buildTarget(args);
  const originalDllHash = sha256Buffer(readFileSync(args.dll));
  const originalLoaderBuf = readFileSync(args.loader);

  let dllBuf;
  if (target.source === 'table') {
    copyFileSync(args.dll, resolve(args.out, 'alcor-host.dll'));
    dllBuf = readFileSync(args.dll);
  } else {
    dllBuf = patchDllWithPatcher(args, target);
  }
  const newDllHash = sha256Buffer(dllBuf);

  let loaderBuf;
  if (target.source === 'table') {
    copyFileSync(args.loader, resolve(args.out, 'qq-host-loader.exe'));
    loaderBuf = readFileSync(args.loader);
  } else {
    loaderBuf = Buffer.from(originalLoaderBuf);
    replaceAll(loaderBuf, originalDllHash, newDllHash);
    patchLoaderTableSlot(loaderBuf, args.slot, target.version, target.sha256);
    writeFileSync(resolve(args.out, 'qq-host-loader.exe'), loaderBuf);
  }

  if (loaderBuf.length !== originalLoaderBuf.length) {
    throw new Error('Loader length changed: ' + loaderBuf.length + ' vs ' + originalLoaderBuf.length);
  }

  const pack = {
    wrapperNode: resolve(args.wrapperNode),
    version: target.version,
    source: target.source,
    slot: args.slot,
    files: { dll: 'alcor-host.dll', loader: 'qq-host-loader.exe' },
    dllSha256: newDllHash,
    loaderSha256: sha256Buffer(loaderBuf),
    artifactHash: newDllHash,
    createdAt: new Date().toISOString()
  };
  if (target.source === 'profile') {
    pack.profile = { version: target.version, sha256: target.sha256, rvas: target.rvas };
  }

  if (args.json) {
    writeFileSync(resolve(args.out, 'pack.json'), JSON.stringify(pack, null, 2));
    console.log(JSON.stringify(pack, null, 2));
  }

  console.log('Pack written to', resolve(args.out));
  console.log('  source=' + target.source + ' version=' + target.version);
  console.log('  dll sha256=' + newDllHash);
  console.log('  loader sha256=' + sha256Buffer(loaderBuf));
  console.log('  artifact hash patched=' + (newDllHash !== originalDllHash));
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error('ERROR: ' + e.message);
  process.exitCode = 1;
}