#!/usr/bin/env node
/** matrix-selftest.mjs — qq-version-matrix 全链路自检（离线，不联网）。
 *
 * T0  在 QQ_MATRIX_QQ_ROOT（默认 D:/QQ）下发现真实 wrapper
 * T1  CLI 可运行：对真实 9.9.36 wrapper 输出 verdict=builtin 且 matchesBuiltin=true
 * T2  改 1 字节副本（末字节 xor 0xFF）→ verdict=derived 且 slot1DigestMatches=true、loaderEmbedsDllSha=true
 * T3  同 packRoot 二次调用 → cached=true，自证字段仍为 true
 * T4  13 字符版本 → verdict=unsupported 且 reason 含 PROFILE_VERSION_UNSUPPORTED
 * T5  家族越界版本（9.9.46）→ verdict=unsupported（QQ_FAMILY_OUT_OF_RANGE，快路径无扫描）
 * T6  不存在的文件 → verdict=rejected
 * T7  全程结束后 D:/QQ 无新增文件
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyWrapper, discoverWrappers, makeContext } from './qq-version-matrix.mjs';

const QQ_ROOT = process.env.QQ_MATRIX_QQ_ROOT || 'D:/QQ';
const REPO = process.env.ALCOR_SOURCE_REPO || 'D:/Alcor-源码/Alcor-Agent';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'qq-version-matrix.mjs');

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log('PASS ' + name);
  else { failed += 1; console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

function snapshotDir(root) {
  const list = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      list.push(path.relative(root, p).split(path.sep).join('/'));
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return list.sort();
}

const run = async () => {
  // T0 发现真实 wrapper
  const realWrappers = discoverWrappers(QQ_ROOT);
  check('T0 发现真实 wrapper', realWrappers.length >= 1, QQ_ROOT + ' 下未找到 versions/*/resources/app/wrapper.node');
  if (!realWrappers.length) { console.log(failed + ' FAILED'); process.exit(1); }
  const real = realWrappers[0];
  console.log('     wrapper = ' + real);
  const before = snapshotDir(QQ_ROOT);

  // T1 CLI 可运行 + builtin
  const cli = spawnSync(process.execPath, [CLI, real, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let t1 = null;
  try { t1 = JSON.parse(cli.stdout)[0]; } catch {}
  check('T1a CLI 退出码 0', cli.status === 0, 'status=' + cli.status + ' stderr=' + String(cli.stderr || '').slice(0, 200));
  check('T1b verdict=builtin', t1 && t1.verdict === 'builtin', 'got ' + JSON.stringify(t1).slice(0, 200));
  check('T1c matchesBuiltin=true', t1 && t1.matchesBuiltin === true);

  // 准备改 1 字节副本（末字节 xor 0xFF，落在 overlay，不影响 PE 结构与 RVA 复原）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-selftest-'));
  const mod = path.join(tmp, 'wrapper.node');
  fs.copyFileSync(real, mod);
  const fh = fs.openSync(mod, 'r+');
  const size = fs.fstatSync(fh).size;
  const one = Buffer.alloc(1);
  fs.readSync(fh, one, 0, 1, size - 1);
  fs.writeSync(fh, Buffer.from([one[0] ^ 0xff]), 0, 1, size - 1);
  fs.closeSync(fh);

  try {
    // T2 derived（版本号必须显式给：路径 tmp/wrapper.node 推断不出）
    const ctxA = await makeContext({ repo: REPO, version: '9.9.36-53644', packRoot: path.join(tmp, 'packA') });
    const r2 = await classifyWrapper(mod, ctxA);
    check('T2a verdict=derived', r2.verdict === 'derived', 'got ' + JSON.stringify(r2).slice(0, 300));
    check('T2b slot1DigestMatches=true', r2.slot1DigestMatches === true);
    check('T2c loaderEmbedsDllSha=true', r2.loaderEmbedsDllSha === true);
    check('T2d cached=false（真构建）', r2.cached === false);

    // T3 同 packRoot 二次调用 → 缓存命中
    const r3 = await classifyWrapper(mod, ctxA);
    check('T3a cached=true（缓存命中）', r3.verdict === 'derived' && r3.cached === true);
    check('T3b 缓存路径自证字段仍 true', r3.slot1DigestMatches === true && r3.loaderEmbedsDllSha === true);

    // T4 13 字符版本 → PROFILE_VERSION_UNSUPPORTED
    const ctxB = await makeContext({ repo: REPO, version: '9.9.36-536441', packRoot: path.join(tmp, 'packB') });
    const r4 = await classifyWrapper(mod, ctxB);
    check('T4 verdict=unsupported 且 reason 含 PROFILE_VERSION_UNSUPPORTED',
      r4.verdict === 'unsupported' && /PROFILE_VERSION_UNSUPPORTED/.test(String(r4.reason || '')),
      'got ' + JSON.stringify(r4).slice(0, 300));

    // T5 家族越界 → QQ_FAMILY_OUT_OF_RANGE（快路径，无扫描）
    const ctxC = await makeContext({ repo: REPO, version: '9.9.46-99999', packRoot: path.join(tmp, 'packC') });
    const r5 = await classifyWrapper(mod, ctxC);
    check('T5 家族越界 unsupported',
      r5.verdict === 'unsupported' && /QQ_FAMILY_OUT_OF_RANGE/.test(String(r5.reason || '')),
      'got ' + JSON.stringify(r5).slice(0, 300));

    // T6 不存在的文件 → rejected
    const r6 = await classifyWrapper(path.join(tmp, 'nope.node'), ctxA);
    check('T6 不存在文件 rejected', r6.verdict === 'rejected', 'got ' + JSON.stringify(r6).slice(0, 200));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  // T7 D:/QQ 无新增文件
  const after = snapshotDir(QQ_ROOT);
  const added = after.filter(p => !before.includes(p));
  check('T7 D:/QQ 无新增文件', added.length === 0, '新增: ' + added.slice(0, 5).join(', '));

  if (failed === 0) { console.log('ALL GREEN'); process.exit(0); }
  console.log(failed + ' FAILED');
  process.exit(1);
};

run().catch(e => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });