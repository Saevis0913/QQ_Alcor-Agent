import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在 import config/update-manager 之前指到临时目录，避免测试读写现役 data。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-update-notify-'));
process.env.ALCOR_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} });

const mgr = await import('../src/update-manager.js');
const { DEFAULT_CONFIG } = await import('../src/config.js');

test('默认策略是 notify：不自动下载、不自动安装', () => {
  assert.equal(DEFAULT_CONFIG.update.mode, 'notify');
  assert.equal(DEFAULT_CONFIG.update.autoInstall, false);
  assert.equal(mgr.resolveUpdateMode({}), 'notify');
  assert.equal(mgr.resolveUpdateMode({ update: {} }), 'notify');
  // 老配置里残留 autoInstall:true 也不再触发自动更新（mode 才是开关）
  assert.equal(mgr.resolveUpdateMode({ update: { autoInstall: true } }), 'notify');
  assert.equal(mgr.resolveUpdateMode({ update: { mode: 'auto' } }), 'auto');
  assert.equal(mgr.resolveUpdateMode({ update: { mode: 'auto', autoInstall: false } }), 'notify');
});

test('只有显式 auto + 补丁版本才自动安装', () => {
  assert.equal(mgr.shouldAutoInstall({ mode: 'notify', latest: '0.3.2-as.6', current: '0.3.2-as.5' }), false);
  assert.equal(mgr.shouldAutoInstall({ mode: 'auto', latest: '0.3.2-as.6', current: '0.3.2-as.5' }), true);
  assert.equal(mgr.shouldAutoInstall({ mode: 'auto', latest: '0.4.0', current: '0.3.2' }), false);
  assert.equal(mgr.shouldAutoInstall({ mode: 'auto', latest: '', current: '0.3.2' }), false);
});

test('提示只在「有新版本且本次启动没关过」时出现', () => {
  assert.equal(mgr.shouldPromptUpdate({ hasUpdate: false, latest: '0.3.2-as.6' }), false);
  assert.equal(mgr.shouldPromptUpdate({ hasUpdate: true, latest: '', dismissedVersion: '' }), false);
  assert.equal(mgr.shouldPromptUpdate({ hasUpdate: true, latest: '0.3.2-as.6', dismissedVersion: '' }), true);
  assert.equal(mgr.shouldPromptUpdate({ hasUpdate: true, latest: '0.3.2-as.6', dismissedVersion: '0.3.2-as.6' }), false);
  // 换了一个更新的版本，即使关过上一个也要重新提示
  assert.equal(mgr.shouldPromptUpdate({ hasUpdate: true, latest: '0.3.2-as.7', dismissedVersion: '0.3.2-as.6' }), true);
});

test('发布说明被压成 3–5 行可读概括', () => {
  const notes = [
    '# 0.3.2-as.6',
    '',
    '| 版本 | 说明 |',
    '| --- | --- |',
    '- **更新改为手动确认**：不再自动下载',
    '* 新增 `IDENTITY_SERVICE_UNBOUND` 判定',
    '修复：安装器结束 QQ 后自动重启',
    '第五条不该出现',
    '---'
  ].join('\n');
  const lines = mgr.summarizeNotes(notes, 4);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines, [
    '更新改为手动确认：不再自动下载',
    '新增 IDENTITY_SERVICE_UNBOUND 判定',
    '修复：安装器结束 QQ 后自动重启',
    '第五条不该出现'
  ]);
  assert.deepEqual(mgr.summarizeNotes(''), []);
  assert.equal(mgr.summarizeNotes('x'.repeat(300))[0].length, 119);
});

test('updateState 暴露 mode / prompt / summary，dismiss 后本次启动不再提示', () => {
  const before = mgr.updateState();
  assert.equal(before.mode, 'notify');
  assert.equal(before.prompt, false); // 还没检查过，没有新版本
  assert.ok(Array.isArray(before.summary));

  const after = mgr.dismissUpdate();
  assert.equal(after.prompt, false);
  assert.equal(after.mode, 'notify');
  // dismiss 只影响内存里的版本号：模块重新加载（= 重启进程）后 dismissedLatest 归零
  assert.equal(mgr.shouldPromptUpdate({ hasUpdate: true, latest: '0.3.2-as.6', dismissedVersion: '' }), true);
});
