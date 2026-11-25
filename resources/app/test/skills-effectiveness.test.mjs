// 扩展系统「有效性」回归：钩子名 / 能力声明 / 接点 / 消费表 四类静默失效。
//
// 这些用例守的是同一件事：**加载成功不等于真的会跑**。
// 其中三条是「表与代码对账」（读源码 grep 真实调用点），因为审计表本身也会腐化 ——
// 核心里改了钩子名而表没改，比没有审计更糟（会把失效判成生效）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditSkill, auditSkills, KNOWN_HOOKS, CONSUMED_CAPABILITIES } from '../src/skills/effectiveness.js';
import { skillManager } from '../src/skills/manager.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = (over = {}) => ({
  manifest: { id: 'demo', version: '1.0.0', capabilities: [], requires: [], ...(over.manifest || {}) },
  providers: {},
  hooks: {},
  toolIds: [],
  promptSections: null,
  loadError: null,
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'manifest'))
});
const codes = (r) => r.findings.map((f) => f.code);

test('健康的插件：有钩子并且名字正确，没有告警', () => {
  const r = auditSkill(skill({ hooks: { 'after-response': () => {} } }));
  assert.equal(r.effective, true);
  assert.deepEqual(r.findings, []);
});

test('钩子名不在核心发射表里 → UNKNOWN_HOOK（加载成功但永远不会被调用）', () => {
  const r = auditSkill(skill({ hooks: { 'before-send': () => {} } }));
  assert.equal(r.effective, false);
  assert.deepEqual(codes(r), ['UNKNOWN_HOOK']);
  assert.match(r.findings[0].message, /before-send/);
  assert.match(r.findings[0].fix, /after-response/);
});

test('五个真实钩子名全部通过（一个都不许漏进黑名单）', () => {
  for (const hook of Object.keys(KNOWN_HOOKS)) {
    const r = auditSkill(skill({ hooks: { [hook]: () => {} } }));
    assert.equal(r.effective, true, hook + ' 被误判为未知钩子');
  }
});

test('清单声明了能力但 providers 没实现 → DECLARED_NOT_IMPLEMENTED', () => {
  const r = auditSkill(skill({ manifest: { capabilities: ['reply.local-policy'] } }));
  assert.equal(r.effective, false);
  assert.ok(codes(r).includes('DECLARED_NOT_IMPLEMENTED'));
});

test('实现了但没声明 → 只是 info，不算不生效', () => {
  const r = auditSkill(skill({ providers: { 'reply.local-policy': () => null } }));
  assert.equal(r.effective, true);
  assert.deepEqual(codes(r), ['IMPLEMENTED_NOT_DECLARED']);
  assert.equal(r.findings[0].level, 'info');
});

test('声明了但没人消费 → info；被核心消费 / 被别的 Skill requires / 探针后缀 都算有人用', () => {
  const lone = auditSkill(skill({
    manifest: { capabilities: ['demo.unused'] },
    providers: { 'demo.unused': () => null }
  }));
  assert.equal(lone.effective, true);
  assert.deepEqual(codes(lone), ['UNCONSUMED_CAPABILITY']);

  for (const [cap, opts] of [
    ['reply.local-policy', {}],
    ['memory.lookup', { requiredBy: new Set(['memory.lookup']) }],
    ['video.frames.available', {}]
  ]) {
    const r = auditSkill(skill({ manifest: { capabilities: [cap] }, providers: { [cap]: () => null } }), opts);
    assert.deepEqual(r.findings, [], cap + ' 不该被判成没人用');
  }
});

test('一个接点都没有 → NO_ENTRY_POINT', () => {
  const r = auditSkill(skill());
  assert.equal(r.effective, false);
  assert.deepEqual(codes(r), ['NO_ENTRY_POINT']);
  const withTools = auditSkill(skill({ toolIds: ['demo__hello'] }));
  assert.equal(withTools.effective, true);
});

test('加载失败的条目只报 LOAD_FAILED，不拿残留字段猜原因', () => {
  const r = auditSkill(skill({ loadError: '入口需导出 setup(api)', hooks: { nope: () => {} } }));
  assert.equal(r.effective, false);
  assert.deepEqual(codes(r), ['LOAD_FAILED']);
});

test('auditSkills 汇总：生效数 / 待修数 / 告警数与条目一致', () => {
  const { results, summary } = auditSkills([
    skill({ manifest: { id: 'a' }, hooks: { 'after-response': () => {} } }),
    skill({ manifest: { id: 'b' }, hooks: { 'before-send': () => {} } })
  ]);
  assert.equal(results.length, 2);
  assert.deepEqual(summary, { total: 2, effective: 1, ineffective: 1, warnings: 1, infos: 0 });
});

// ── 表与代码对账：审计表说的名字，必须在源码里真的被调用 ──────────────────────

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
};
const srcFiles = walk(path.join(APP_ROOT, 'src'));

test('KNOWN_HOOKS 与 orchestrator 的 runHook(...) 调用点完全一致', () => {
  const src = fs.readFileSync(path.join(APP_ROOT, 'src', 'orchestrator.js'), 'utf8');
  const emitted = new Set([...src.matchAll(/runHook\(\s*'([^']+)'/g)].map((m) => m[1]));
  assert.ok(emitted.size >= 5, 'orchestrator 里没找到 runHook 调用点，测试本身失效了');
  assert.deepEqual([...emitted].sort(), Object.keys(KNOWN_HOOKS).sort());
});

test('CONSUMED_CAPABILITIES 与源码里的能力取用点完全一致（不漏判、也不留僵尸项）', () => {
  const found = new Set();
  const re = /(?:getCapabilityProviders|providersOf|#capFirst)\(\s*'([a-z][a-z0-9.\-]+)'/g;
  for (const file of srcFiles) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(re)) found.add(m[1]);
  }
  assert.ok(found.size >= 15, '源码里没扫到足够的能力取用点，测试本身失效了');
  assert.deepEqual([...found].sort(), Object.keys(CONSUMED_CAPABILITIES).sort());
});

test('manager.status / summary 把有效性审计透出给 /api/skills 与 UI', () => {
  const id = '__effectiveness_probe__';
  skillManager.register({
    manifest: { id, name: id, version: '0.0.1', capabilities: [], requires: [], enabledByDefault: true },
    source: 'test', dir: APP_ROOT, relDir: 'test/' + id, kind: 'plugin',
    api: null, toolIds: [], providers: {}, hooks: { 'before-send': () => {} },
    available: null, activate: null, deactivate: null, dispose: () => {}, promptSections: null,
    loadError: null
  });
  try {
    const st = skillManager.status(id);
    assert.equal(st.audit.effective, false);
    assert.deepEqual(st.audit.findings.map((f) => f.code), ['UNKNOWN_HOOK']);
    const sum = skillManager.summary();
    assert.equal(typeof sum.ineffective, 'number');
    assert.ok(sum.ineffective >= 1);
    assert.ok(sum.warnings >= 1);
  } finally {
    skillManager.unregister(id);
  }
});

test('真实目录：内置技能与插件全部加载成功，且没有一条被判成不会生效', async () => {
  const roots = { skills: path.join(APP_ROOT, 'skills'), plugins: path.join(APP_ROOT, 'plugins') };
  if (!fs.existsSync(roots.skills) || !fs.existsSync(roots.plugins)) return;
  const { loadPlugins } = await import('../src/plugin-loader.js');
  const logs = [];
  const r = await loadPlugins({ log: (m) => logs.push(String(m)), roots });
  assert.equal(r.failed.length, 0, '有内置条目加载失败：' + r.failed.map((f) => f.id + ':' + f.error).join('、'));
  const list = skillManager.list();
  const bad = list.filter((s) => s.audit && s.audit.effective === false);
  assert.deepEqual(bad.map((s) => s.id + '=' + s.audit.findings.map((f) => f.code).join('+')), []);
  // 内置条目应当一条审计发现都没有：声明的能力都有人用、实现都和声明对得上。
  // 这条断言是"仪器本身干净"的基线 —— 新增插件时它逼你先回答"谁消费它"。
  const noisy = list.filter((s) => (s.audit?.findings || []).length);
  assert.deepEqual(noisy.map((s) => s.id + '=' + s.audit.findings.map((f) => f.code).join('+')), []);
});

test('DUPLICATE_PROVIDER：同一能力被两个插件实现时，排在后面的那份被标出来', () => {
  const index = new Map([['reply.subscription', ['alpha', 'codex-subscription']]]);
  const r = auditSkill(skill({ manifest: { id: 'codex-subscription', capabilities: ['reply.subscription'] }, providers: { 'reply.subscription': () => {} } }), { providerIndex: index });
  assert.deepEqual(codes(r), ['DUPLICATE_PROVIDER']);
  assert.match(r.findings[0].message, /alpha/);
  const first = auditSkill(skill({ manifest: { id: 'alpha', capabilities: ['reply.subscription'] }, providers: { 'reply.subscription': () => {} } }), { providerIndex: index });
  assert.deepEqual(codes(first), [], '排在最前的那份确实会被调用，不该报');
  const solo = auditSkill(skill({ manifest: { id: 'solo', capabilities: ['reply.local-policy'] }, providers: { 'reply.local-policy': () => {} } }), { providerIndex: new Map([['reply.local-policy', ['solo']]]) });
  assert.deepEqual(codes(solo), [], '只有一个提供者时不该报');
});

test('系统自带的 16 个扩展都带 builtin 标记，且只有 Codex 订阅接入默认关闭', () => {
  const roots = ['plugins', 'skills'].map((k) => path.join(APP_ROOT, k));
  const entries = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) return;
    for (const dir of fs.readdirSync(root)) {
      const file = ['plugin.json', 'skill.json'].map((n) => path.join(root, dir, n)).find((p) => fs.existsSync(p));
      if (!file) continue;
      entries.push({ dir, manifest: JSON.parse(fs.readFileSync(file, 'utf8')) });
    }
  }
  assert.equal(entries.length, 16, '内置扩展数量变了，确认是否新增/移除');
  assert.deepEqual(entries.filter((e) => e.manifest.builtin !== true).map((e) => e.dir), []);
  const off = entries.filter((e) => e.manifest.enabledByDefault !== true).map((e) => e.manifest.id);
  assert.deepEqual(off, ['codex-subscription'], '只有 Codex 订阅账号接入默认关闭（它会顶替 API 模型）');
});

test('manager.status 透出 builtin，UI 才能区分系统自带与市场安装', () => {
  const id = '__builtin_probe__';
  skillManager.register({
    manifest: { id, name: id, version: '0.0.1', capabilities: [], requires: [], enabledByDefault: true, builtin: true },
    source: 'test', dir: APP_ROOT, relDir: 'test/' + id, kind: 'plugin',
    api: null, toolIds: [], providers: {}, hooks: { 'after-response': () => {} },
    available: null, activate: null, deactivate: null, dispose: () => {}, promptSections: null,
    loadError: null
  });
  try {
    assert.equal(skillManager.status(id).builtin, true);
  } finally {
    skillManager.unregister(id);
  }
});
