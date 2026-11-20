// 长期稳定性测试：定时向白名单私聊与白名单群发文字/图片/表情/动图/视频，
// 每次发送后回读（get_msg）核对，并持续扫描应用日志里的报错。
// 停止方式：在 D:\Alcor-stability 下建一个名为 STOP 的文件（脚本下一轮自退）。
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = 'D:/Alcor';
const OUT = 'D:/Alcor-stability';
const HTTP = 'http://127.0.0.1:5310';
const PRIVATE = 3545356052;
const GROUP = 536199253;
const BASE_INTERVAL = 120000;
const JITTER = 30000;

const token = JSON.parse(fs.readFileSync(`${ROOT}/data/alcor.config.json`, 'utf8')).listen.token;
const stamp = () => new Date().toISOString();
const day = () => new Date().toISOString().slice(0, 10);

function append(file, line) {
  try { fs.appendFileSync(path.join(OUT, file), line + '\n'); } catch { /* 磁盘满等极端情况不影响发送 */ }
}
function event(obj) { append('events.jsonl', JSON.stringify({ ts: stamp(), ...obj })); }
function issue(obj) { append('issues.jsonl', JSON.stringify({ ts: stamp(), ...obj })); }
function note(line) { append('summary.md', `- ${stamp()} ${line}`); }

async function api(route, body, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${HTTP}/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { http: res.status, data };
  } catch (error) {
    return { http: 0, error: String(error?.message || error) };
  } finally { clearTimeout(timer); }
}

function listFiles(dir, exts) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)))
      .map((f) => path.join(dir, f))
      .filter((f) => { try { const s = fs.statSync(f).size; return s > 1024 && s < 6 * 1024 * 1024; } catch { return false; } });
  } catch { return []; }
}

const IMAGES = listFiles(`${ROOT}/data/sticker-images`, ['.jpg', '.jpeg', '.png']);
const GIFS = listFiles(`${ROOT}/data/sticker-images`, ['.gif']);
// 表情库的索引行只有 id/名字/字节数，真正的文件在 sticker-images 里，命名是「<rowId>-<hash>.gif」
const STICKERS = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(`${ROOT}/data/stickers/index.json`, 'utf8'));
    const rows = (Array.isArray(raw) ? raw : (raw.rows || raw.entries || [])).filter((r) => Array.isArray(r));
    const files = fs.readdirSync(`${ROOT}/data/sticker-images`).map((f) => path.join(`${ROOT}/data/sticker-images`, f));
    const out = [];
    for (const row of rows) {
      const id = String(row[0] || '');
      if (!id) continue;
      const hit = files.find((p) => path.basename(p).startsWith(id + '-'));
      if (hit) out.push({ id, name: row[3] || '', path: hit });
    }
    return out;
  } catch { return []; }
})();
const VIDEO = `${ROOT}/resources/app/assets/splash.mp4`;

const KINDS = ['image', 'sticker', 'gif', 'video', 'text'];

function pick(list, index) { return list.length ? list[index % list.length] : ''; }

function buildMessage(kind, index) {
  if (kind === 'text') return [{ type: 'text', data: { text: `稳定性巡检 #${index + 1} ${new Date().toLocaleTimeString('zh-CN')}` } }];
  const file = kind === 'video' ? VIDEO : kind === 'sticker' ? pick(STICKERS, index)?.path : kind === 'gif' ? pick(GIFS, index) : pick(IMAGES, index);
  if (!file) return null;
  const bytes = fs.readFileSync(file);
  const b64 = `base64://${bytes.toString('base64')}`;
  if (kind === 'video') {
    // 核心侧 prepareVideo 里 `inspectImage(coverInput)` 是无条件的：不带 thumb 会直接抛
    // IMAGE_INPUT_INVALID（报错名还容易误导）。这里固定配一张小 jpg 封面，走真实视频链路。
    const cover = IMAGES.find((p) => /\.jpe?g$/i.test(p) && fs.statSync(p).size < 900 * 1024) || IMAGES[0];
    const thumb = cover ? `base64://${fs.readFileSync(cover).toString('base64')}` : '';
    return { type: 'video', size: bytes.length, segments: [{ type: 'video', data: { file: b64, thumb } }] };
  }
  return { type: 'image', size: bytes.length, segments: [{ type: 'image', data: { file: b64 } }] };
}

async function readBack(messageId, chatKind, chatId) {
  const got = await api('get_msg', { message_id: messageId, expected_self_id: 2790528295 });
  const d = got.data;
  const ok = got.http === 200 && typeof d === 'object' && (d?.status === 'ok' || d?.retcode === 0);
  const type = ok ? (d?.data?.message?.[0]?.type || d?.data?.post_type || 'unknown') : '';
  return { ok, http: got.http, retcode: d?.retcode ?? null, wording: d?.wording || d?.data?.wording || '', type, chatKind, chatId };
}

// 换个账号/重连后核心会拒绝旧的自述 id（409 NATIVE_ACCOUNT_CHANGED）：
// 每次发送前问一次核心当前账号，别再写死。
async function currentSelfId() {
  try {
    const state = await api('get_status', {}, 8000);
    const id = Number(state.data?.data?.self_id ?? state.data?.data?.user_id ?? 0);
    if (id > 0) return id;
  } catch { /* 下面用兜底 */ }
  return 2790528295;
}

async function sendOne(kind, index) {
  const target = index % 2 === 0 ? { kind: 'group', id: GROUP } : { kind: 'private', id: PRIVATE };
  const built = buildMessage(kind, index);
  if (!built) { event({ kind, target, status: 'skipped', reason: 'no asset' }); return { ok: false }; }
  const segments = built.segments || built;
  const route = target.kind === 'group' ? 'send_group_msg' : 'send_private_msg';
  const SELF = await currentSelfId();
  const body = target.kind === 'group'
    ? { group_id: target.id, message: segments, expected_self_id: SELF }
    : { user_id: target.id, message: segments, expected_self_id: SELF };
  const t0 = Date.now();
  const sent = await api(route, body, built.size > 3_000_000 ? 150000 : 90000);
  const latency = Date.now() - t0;
  const ok = sent.http === 200 && sent.data?.status === 'ok';
  const mid = sent.data?.data?.message_id ?? null;
  let back = null;
  if (ok && mid) back = await readBack(mid, target.kind, target.id);
  event({
    kind, target: `${target.kind}:${target.id}`, bytes: built.size || null, latencyMs: latency,
    status: ok ? 'ok' : 'failed', messageId: mid, delivery: sent.data?.data?.delivery ?? null,
    http: sent.http, retcode: sent.data?.retcode ?? null, wording: sent.data?.wording ?? sent.error ?? '',
    readBack: back ? { ok: back.ok, type: back.type, retcode: back.retcode } : null
  });
  if (!ok) issue({ area: 'send', kind, target: `${target.kind}:${target.id}`, http: sent.http, retcode: sent.data?.retcode, wording: sent.data?.wording || sent.error || '' });
  else if (back && !back.ok) issue({ area: 'read-back', kind, messageId: mid, http: back.http, retcode: back.retcode, wording: back.wording });
  return { ok, mid };
}

// 增量扫描应用日志里的报错
let logOffset = 0;
let logFile = '';
function scanLog() {
  const file = `${ROOT}/data/logs/qq-agent-${day()}.log`;
  try {
    if (file !== logFile) { logFile = file; logOffset = 0; }
    const size = fs.statSync(file).size;
    if (size <= logOffset) { logOffset = Math.max(0, size); return; }
    const buf = Buffer.alloc(size - logOffset);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, buf.length, logOffset);
    fs.closeSync(fd);
    logOffset = size;
    for (const line of buf.toString('utf8').split('\n')) {
      if (/\[ERROR|ERROR[ _]|失败|不可用|NOT_[A-Z_]+|timed out|ECONNRESET/.test(line) && !/0 失败/.test(line)) {
        issue({ area: 'app-log', line: line.trim().slice(0, 300) });
      }
    }
  } catch { /* 日志还没生成 */ }
}

function metrics() {
  try {
    const ps = execSync(
      'powershell -NoProfile -Command "(Get-Process -Name \'Alcor Agent\' -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum"',
      { encoding: 'utf8', timeout: 20000 }).trim();
    const rss = Number(ps) || 0;
    const inbox = fs.statSync(`${ROOT}/data/inbox.json`).size;
    const media = fs.statSync(`${ROOT}/data/alcor.config.json.media-index.json`).size;
    const stickers = fs.readdirSync(`${ROOT}/data/sticker-images`).length;
    event({ metric: 'rss/inbox/media/stickers', rssMB: Math.round(rss / 1048576), inboxBytes: inbox, mediaIndexBytes: media, stickerFiles: stickers });
  } catch { /* 采样失败只丢一条指标 */ }
}

let cycles = 0;
let running = true;
const heartbeat = { startedAt: stamp(), ok: 0, failed: 0 };
process.on('exit', (code) => { try { fs.appendFileSync(path.join(OUT, 'exit.log'), JSON.stringify({ ts: stamp(), code, pid: process.pid }) + '\n'); } catch {} });
process.on('uncaughtException', (error) => { try { fs.appendFileSync(path.join(OUT, 'exit.log'), JSON.stringify({ ts: stamp(), kind: 'uncaught', message: String(error?.stack || error) }) + '\n'); } catch {} process.exit(1); });
process.on('unhandledRejection', (error) => { try { fs.appendFileSync(path.join(OUT, 'exit.log'), JSON.stringify({ ts: stamp(), kind: 'rejection', message: String(error?.stack || error) }) + '\n'); } catch {} process.exit(2); });
process.on('SIGTERM', () => { running = false; });
process.on('SIGINT', () => { running = false; });

note(`稳定性测试启动：私聊 ${PRIVATE} / 群 ${GROUP}，素材 图片 ${IMAGES.length} 张、动图 ${GIFS.length} 张、表情 ${STICKERS.length} 个、视频 1 个；间隔 ${BASE_INTERVAL / 1000}s±${JITTER / 1000}s`);
event({ phase: 'start', images: IMAGES.length, gifs: GIFS.length, stickers: STICKERS.length, video: fs.existsSync(VIDEO) });

while (running) {
  if (fs.existsSync(path.join(OUT, 'STOP'))) { note('检测到 STOP 文件，脚本退出'); event({ phase: 'stop' }); break; }
  scanLog();

  const health = await api('get_status', {}, 15000);
  if (health.http !== 200) {
    event({ phase: 'app-down', http: health.http, error: health.error || health.data?.wording || '' });
    const wait = 60000;
    await new Promise((r) => setTimeout(r, wait));
    continue;
  }

  const kind = KINDS[cycles % KINDS.length];
  try {
    fs.writeFileSync(path.join(OUT, 'heartbeat.json'), JSON.stringify({
      pid: process.pid, startedAt: heartbeat.startedAt, updatedAt: stamp(), cycles,
      busy: true, lastKind: kind, lastOk: null, stats: { ok: heartbeat.ok, failed: heartbeat.failed }
    }, null, 1));
  } catch { /* ignore */ }
  let result = { ok: false };
  try {
    result = await sendOne(kind, cycles);
  } catch (error) {
    // 单轮异常不能掀翻整个长跑：记一笔继续下一轮
    event({ kind, status: 'exception', error: String(error?.message || error) });
    issue({ area: 'runner', kind, error: String(error?.message || error) });
  }
  cycles += 1;
  if (cycles % 5 === 0) metrics();

  heartbeat.ok += result.ok ? 1 : 0;
  heartbeat.failed += result.ok ? 0 : 1;
  try {
    fs.writeFileSync(path.join(OUT, 'heartbeat.json'), JSON.stringify({
      pid: process.pid, startedAt: heartbeat.startedAt, updatedAt: stamp(), cycles,
      busy: false, lastKind: kind, lastOk: !!result.ok, stats: { ok: heartbeat.ok, failed: heartbeat.failed }
    }, null, 1));
  } catch { /* ignore */ }
  note(`第 ${cycles} 轮 ${kind} → ${result.ok ? 'OK' : 'FAIL'}`);

  const wait = BASE_INTERVAL + Math.floor((Math.random() * 2 - 1) * JITTER);
  await new Promise((r) => setTimeout(r, Math.max(30000, wait)));
}
