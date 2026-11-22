import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NativeDirectory } from '../native-core/directory-cache.mjs';
import { loadMediaCache, saveMediaCache } from '../native-core/media-cache.mjs';

function groupEvent(groupId) {
  return { group_id: groupId, user_id: 42, message: [] };
}

test('events during a failed scan cooldown do not postpone the retry', async (t) => {
  const directory = new NativeDirectory({ account: '10001', receiveGeneration: 1 });
  let now = 1_000;
  let attempts = 0;
  t.mock.method(Date, 'now', () => now);
  directory.members = async () => {
    attempts++;
    if (attempts === 1) throw new Error('Simulated scan failure');
    return [{ user_id: 42, nickname: 'Local member' }];
  };

  for (const time of [1_000, 11_000, 21_000]) {
    now = time;
    const event = await directory.enrich(groupEvent(1));
    assert.equal(event.member_scan_error, 'GROUP_MEMBER_SCAN_FAILED');
  }

  now = 31_000;
  const event = await directory.enrich(groupEvent(1));
  assert.equal(event.sender?.nickname, 'Local member');
});

test('failed group scans respect the directory cache entry limit', async () => {
  const directory = new NativeDirectory({ account: '10001', receiveGeneration: 1 });
  directory.members = async () => { throw new Error('Simulated scan failure'); };

  for (let groupId = 1; groupId <= 140; groupId++) {
    await directory.enrich(groupEvent(groupId));
  }

  assert.equal(directory.cache.size, 128);
});

function mediaRow(number) {
  return {
    id: `alcor-media-${number.toString(16).padStart(64, '0')}`,
    account: '10001',
    kind: 'image',
    selfUid: 'u_local-test',
    index: 'YQ==',
  };
}

test('media cache startup keeps valid rows around malformed entries', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'alcor-media-test-'));
  const file = join(folder, 'media.json');
  t.after(() => {
    unlinkSync(file);
    rmdirSync(folder);
  });

  const first = mediaRow(1);
  const badId = mediaRow(2);
  badId.id = [badId.id];
  const badAccount = mediaRow(3);
  badAccount.account = [badAccount.account];
  const last = mediaRow(4);
  writeFileSync(file, JSON.stringify({ version: 1, rows: [first, badId, badAccount, null, last] }));

  const keys = [...loadMediaCache(file).keys()];
  assert.deepEqual(keys, [first.id, last.id]);
});

test('media cache persists the newest rows within the file budget', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'alcor-media-capacity-'));
  const file = join(folder, 'media.json');
  t.after(() => {
    if (existsSync(file)) unlinkSync(file);
    rmdirSync(folder);
  });

  const index = Buffer.alloc(2048, 1);
  const marketFace = Buffer.alloc(2048, 2);
  const rows = new Map();
  for (let number = 1; number <= 1600; number++) {
    const row = mediaRow(number);
    rows.set(row.id, {
      account: row.account,
      descriptor: { kind: 'image', selfUid: row.selfUid, index, marketFace, publicSticker: 'a'.repeat(32) }
    });
  }

  saveMediaCache(file, rows);
  assert.ok(statSync(file).size <= 8 * 1024 * 1024);
  const restored = loadMediaCache(file);
  assert.equal(restored.has(mediaRow(1600).id), true);
  assert.equal(restored.has(mediaRow(1).id), false);
  assert.ok(restored.size > 0);
});
