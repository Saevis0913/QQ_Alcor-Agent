import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPreflight, preflightConfig, preflightPackRoot } from '../src/preflight.js';

async function workspace(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'alcor-preflight-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const installRoot = path.join(root, 'install');
  const dataDir = path.join(installRoot, 'data');
  await fs.promises.mkdir(dataDir, { recursive: true });
  return { root, installRoot, dataDir };
}

test('runPreflight creates the data skeleton and records its result', async (t) => {
  const { installRoot, dataDir } = await workspace(t);
  const result = await runPreflight({ installRoot, dataDir, logger: () => {} });
  for (const name of ['logs', 'updates', 'crash-dumps']) assert.ok(fs.existsSync(path.join(dataDir, name)), name);
  assert.equal(result.version, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'logs', 'preflight-last.json'), 'utf8'));
  assert.equal(saved.ok, result.ok);
  assert.ok(Array.isArray(saved.steps) && saved.steps.length >= 8);
});

test('a corrupt config is backed up and replaced instead of crashing startup', async (t) => {
  const { dataDir } = await workspace(t);
  const file = path.join(dataDir, 'config.json');
  await fs.promises.writeFile(file, '{ this is not json', 'utf8');
  const steps = preflightConfig({ dataDir });
  assert.equal(steps[0].fixed, true);
  assert.equal(JSON.parse(await fs.promises.readFile(file, 'utf8')).constructor, Object);
  const backups = (await fs.promises.readdir(dataDir)).filter((name) => name.startsWith('config.json.broken-'));
  assert.equal(backups.length, 1);
  assert.match(await fs.promises.readFile(path.join(dataDir, backups[0]), 'utf8'), /this is not json/);
});

test('pack root falls back to the data dir when the preferred one is unusable', async (t) => {
  const { dataDir } = await workspace(t);
  const previous = process.env.ALCOR_PROFILE_PACK_DIR;
  process.env.ALCOR_PROFILE_PACK_DIR = path.join(dataDir, '中文目录');
  t.after(() => {
    if (previous === undefined) delete process.env.ALCOR_PROFILE_PACK_DIR;
    else process.env.ALCOR_PROFILE_PACK_DIR = previous;
  });
  const steps = preflightPackRoot({ dataDir });
  assert.equal(steps[0].ok, true);
  assert.ok(!steps[0].detail.includes('中文目录'));
  assert.match(steps[0].detail, /^[\x20-\x7e]+$/);
});
