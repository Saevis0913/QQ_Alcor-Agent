import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const maxArchive = 64 * 1024 * 1024;
function plainPath(file) {
  let cursor = path.resolve(file);
  if (process.platform === 'win32' && !/^[a-z]:\\/i.test(cursor)) throw Error('local-path');
  while (true) {
    if (fs.lstatSync(cursor).isSymbolicLink()) throw Error('link');
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}
function readJson(file, limit) {
  plainPath(file);
  const info = fs.statSync(file);
  if (!info.isFile() || info.size > limit) throw Error('size');
  const bytes = fs.readFileSync(file);
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8';
  return JSON.parse(bytes.toString(encoding).replace(/^\uFEFF/, ''));
}

export function connection(data) {
  try {
    let custom;
    try { custom = readJson(path.join(data, 'config.json'), 4 * 1024 * 1024).alcor?.configFile; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (custom && !path.isAbsolute(custom)) return null;
    const {listen} = readJson(custom || path.join(data, 'alcor.config.json'), 1024 * 1024);
    const host = { 'localhost':'127.0.0.1', '127.0.0.1':'127.0.0.1', '::1':'::1', '[::1]':'::1' };
    if (!Object.hasOwn(host, listen.host) || !Number.isInteger(listen.port) || listen.port < 1 || listen.port > 65535) return null;
    return { hostname:host[listen.host], port:listen.port, token: typeof listen.token === 'string' ? listen.token : '' };
  } catch { return null; }
}
const integer = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
const bool = b => typeof b === 'boolean' ? b : null;
const utc = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) ? value : null;
const counters = ['cyclesStarted','cyclesCompleted','inputs','unrecognized','parseErrors','duplicates',
  'staleMessages','metadataErrors','metadataTimeouts','messagesPublished','idleTimeouts'];
const knownErrors = new Set(['NATIVE_RECEIVE_CONNECTION_LOST','NATIVE_PUSH_PARSE_FAILED','NATIVE_NOTICE_PARSE_FAILED',
  'NATIVE_NOTICE_RESOLVE_FAILED','NATIVE_RECEIVE_NOT_READY']);
function progress(value) {
  if (!value || typeof value.instance !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value.instance) ||
      integer(value.session) === null || counters.some(k => integer(value[k]) === null)) return null;
  return {instance:value.instance, session:value.session, ...Object.fromEntries(counters.map(k => [k,value[k]])),
    lastStartedAt:utc(value.lastStartedAt), lastFinishedAt:utc(value.lastFinishedAt),
    pendingSession:integer(value.pendingSession), pendingMs:integer(value.pendingMs)};
}
export function receiveWindow(samples) {
  if (samples.length < 2 || samples.some(s => s.status !== 'ok' || !s.receiveProgress)) return null;
  const rows = samples.map(s => s.receiveProgress), first = rows[0], last = rows.at(-1);
  for (let i=1; i<rows.length; i++) {
    const row=rows[i];
    if (row.instance !== first.instance || row.session !== first.session ||
        counters.some(k => row[k] < rows[i-1][k])) return null;
  }
  return {...Object.fromEntries(counters.map(k => [k,last[k]-first[k]])),
    sameCyclePending:rows.every(p => p.pendingMs !== null && p.cyclesStarted === first.cyclesStarted &&
      p.cyclesCompleted === first.cyclesCompleted && p.pendingSession === first.pendingSession)};
}
export function health(config) {
  const at = new Date().toISOString();
  if (!config) return Promise.resolve({at, status:'config-unavailable'});
  return new Promise(resolve => {
    let timer, request;
    function finish(result) { clearTimeout(timer); resolve({at, ...result}); }
    try {
      request = http.get({hostname:config.hostname, port:config.port, path:'/health', agent:false,
        headers: config.token ? {authorization:'Bearer ' + config.token} : {}}, res => {
        if (res.statusCode !== 200) { finish({status:'http-' + res.statusCode}); res.destroy(); return; }
        const chunks = []; let size = 0;
        res.on('data', b => {
          size += b.length;
          if (size > 256 * 1024) { finish({status:'invalid-response'}); res.destroy(); return; }
          chunks.push(b);
        });
        res.on('error', () => finish({status:'unavailable'}));
        res.on('aborted', () => finish({status:'unavailable'}));
        res.on('end', () => {
          try {
            const h = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (h.name !== 'Alcor' || typeof h.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+.][a-zA-Z0-9.-]{1,20})?$/.test(h.version)) throw Error();
            const b = h.backend || {};
            finish({status:'ok', version:h.version, ready:bool(h.ready), connected:bool(b.connected),
              serviceBound:bool(b.serviceBound), events:integer(b.events), uptimeSeconds:integer(h.uptimeSeconds),
              lastReceivedAt:utc(b.lastReceivedAt), lastError:knownErrors.has(b.lastError) ? b.lastError : null,
              receiveProgress:progress(b.receiveProgress)});
          } catch { finish({status:'invalid-response'}); }
        });
      });
      request.on('error', () => finish({status:'unavailable'}));
      timer = setTimeout(() => { finish({status:'timeout'}); request.destroy(); }, 1800);
    } catch { finish({status:'invalid-config'}); }
  });
}
export function eventDelta(samples) {
  if (samples.length < 2 || samples.some(s => s.status !== 'ok' || !Number.isSafeInteger(s.events) || !Number.isSafeInteger(s.uptimeSeconds))) return null;
  if (samples.some(s => s.receiveProgress) && !receiveWindow(samples)) return null;
  const first = samples[0];
  const boot = s => Date.parse(s.at) - s.uptimeSeconds * 1000;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i], prev = samples[i-1];
    if (s.version !== first.version || Math.abs(boot(s)-boot(first)) > 2500 ||
        s.uptimeSeconds < prev.uptimeSeconds || s.events < prev.events) return null;
  }
  return samples.at(-1).events - first.events;
}

const validId = id => typeof id === 'number' ? Number.isSafeInteger(id) && id !== 0 :
  typeof id === 'string' && /^-?[1-9]\d*$/.test(id);
function area() { return {complete:true, skipped:0, inbound:{rows:0, withId:0}, outbound:{rows:0, withId:0}}; }
function skipped(a) { a.complete = false; a.skipped++; }
export function evidence(data, marks, started) {
  const inbox = area(), archive = area();
  function collect(file, a, fromInbox) {
    try {
      const rows = readJson(file, maxArchive).messages;
      if (!Array.isArray(rows)) throw Error('schema');
      for (const row of rows) {
        if (!row || typeof row.text !== 'string') continue;
        let bucket;
        if (row.text.trim() === marks.inbound && (fromInbox || row.self === false)) bucket = a.inbound;
        if (!fromInbox && row.text.trim() === marks.outbound && row.self === true) bucket = a.outbound;
        if (bucket) { bucket.rows++; if (validId(row.mid)) bucket.withId++; }
      }
    } catch { skipped(a); }
  }
  collect(path.join(data,'inbox.json'), inbox, true);
  delete inbox.outbound;
  function scan(dir, depth) {
    try {
      plainPath(dir);
      for (const ent of fs.readdirSync(dir, {withFileTypes:true})) {
        const isRoom = /^(?:group|private)_\d+\.json$/i.test(ent.name);
        const isFolder = (depth === 0 && ent.name === 'accounts') || (depth === 1 && /^\d+$/.test(ent.name));
        if (!isRoom && !isFolder) continue;
        const full = path.join(dir, ent.name);
        if (ent.isSymbolicLink()) { skipped(archive); continue; }
        if (isFolder && ent.isDirectory()) scan(full, depth+1);
        else if (isRoom && ent.isFile()) {
          if (fs.statSync(full).mtimeMs >= started - 2500) collect(full, archive, false);
        } else skipped(archive);
      }
    } catch { skipped(archive); }
  }
  scan(path.join(data,'messages'), 0);
  return {inbox, archive};
}

async function main(args) {
  const [root, ...opts] = args;
  if (!root || opts.length % 2) throw Error('args');
  const profile = (process.env.ALCOR_AGENT_PROFILE || '').trim();
  const suffix = /^\d+$/.test(profile) ? '-' + profile : '';
  let seconds = 60, data = process.env.ALCOR_AGENT_DATA_DIR || path.join(root,'data'+suffix), target;
  for (let i=0; i<opts.length; i+=2) {
    if (opts[i] === '--seconds') seconds = Number(opts[i+1]);
    else if (opts[i] === '--data') data = opts[i+1];
    else if (opts[i] === '--report') target = opts[i+1];
    else throw Error('args');
  }
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 120) throw Error('args');
  const id = randomBytes(8).toString('hex').toUpperCase(), marks = {inbound:'Alcor-IN-'+id, outbound:'Alcor-OUT-'+id};
  const started = Date.now(), config = connection(data), samples = [await health(config)];
  console.log('请用同一个测试会话，各发一次。');
  console.log('手机 → 桌面 QQ：' + marks.inbound);
  console.log('Agent 聊天存档页 → 手机：' + marks.outbound);
  console.log('另记桌面 QQ 是否看见入站、Agent 出站提示和手机实际收到条数。采样窗口 ' + seconds + ' 秒。');
  const end = Date.now() + seconds*1000;
  while (Date.now() < end) {
    await delay(Math.min(5000, end - Date.now()));
    samples.push(await health(config));
  }
  const report = {schema:2, started:new Date(started).toISOString(), ended:new Date().toISOString(),
    marks, samples, eventDelta:eventDelta(samples), receiveWindow:receiveWindow(samples), matches:evidence(data,marks,started)};
  target = path.resolve(target || path.join(os.tmpdir(),'Alcor-field-'+id+'.json'));
  plainPath(path.dirname(target));
  fs.writeFileSync(target, JSON.stringify(report,null,2)+'\n',{flag:'wx',encoding:'utf8'});
  console.log('核对报告已保存到 ' + target);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {console.error('未生成报告。请检查参数或选择可写且尚不存在的报告文件。');process.exitCode=1;});
}
