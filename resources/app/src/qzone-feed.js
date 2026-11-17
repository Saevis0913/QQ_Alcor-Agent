import { QZONE_ACCOUNT } from './qzone.js';

export const QZONE_ORIGIN = 'https://user.qzone.qq.com';
const PREFIX = '/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/';
const FEEDS = `${PREFIX}feeds3_html_more`;
const OWN_FALLBACK = `${PREFIX}feeds_html_act_all`;
const POST_ID = /^[\w.-]{1,150}$/;
const LOGIN_PAGES = new Set(['qzone.qq.com', 'user.qzone.qq.com', 'qzs.qq.com', 'qzs.qzone.qq.com']);
const LOGIN_AUTH = new Set(['xui.ptlogin2.qq.com', 'ui.ptlogin2.qq.com', 'ssl.ptlogin2.qq.com', 'ptlogin2.qq.com',
  'captcha.qq.com', 't.captcha.qq.com', 'captcha.gtimg.com', 'turing.captcha.qcloud.com']);
const LOGIN_ASSETS = new Set(['imgcache.qq.com', 'staticfile.qq.com', 'static-res.qq.com', 'qq-web.cdn-go.cn', 'qq-web-other.cdn-go.cn', 'pre.cdn-go.cn']);

export function buildQzoneLoginUrl() {
  const url = new URL('https://xui.ptlogin2.qq.com/cgi-bin/xlogin');
  url.search = new URLSearchParams({
    proxy_url: 'https://qzs.qq.com/qzone/v6/portal/proxy.html',
    s_url: 'https://qzs.qq.com/qzone/v5/loginsucc.html?para=izone',
    daid: '5', appid: '549000912', style: '22', target: 'self', low_login: '1',
    pt_qr_app: '手机QQ空间'
  });
  return url;
}

function secureUrl(input) {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password ? url : null;
  } catch { return null; }
}

function loginTargetAllowed(url, method) {
  if (url.hostname === 'ptlogin2.qzone.qq.com') return method === 'GET' && url.pathname === '/check_sig';
  if (LOGIN_AUTH.has(url.hostname)) return true;
  return LOGIN_PAGES.has(url.hostname) && method === 'GET' && !/(?:\/cgi-bin\/|\/proxy\/)/i.test(url.pathname);
}

export function isQzoneLoginNavigation(input) {
  const url = secureUrl(input);
  return Boolean(url && loginTargetAllowed(url, 'GET'));
}

export function isQzoneLoginRequest(input, method) {
  const url = secureUrl(input);
  return Boolean(url && (loginTargetAllowed(url, method) || method === 'GET'
    && (LOGIN_ASSETS.has(url.hostname) || url.hostname.endsWith('.gtimg.cn') || url.hostname.endsWith('.qpic.cn'))));
}

export function qzoneError(code) {
  return Object.assign(new Error(`Qzone: ${code}`), { code });
}

export function isQzoneReadRequest(input, method) {
  try {
    const url = new URL(input);
    return method === 'GET' && url.origin === QZONE_ORIGIN && !url.username && !url.password
      && [FEEDS, OWN_FALLBACK].includes(url.pathname);
  } catch { return false; }
}

export function buildQzoneReadUrl({ account, scope, token, cursor = '', fallback = false, start = 0 }) {
  if (!QZONE_ACCOUNT.test(account) || !['own', 'friends'].includes(scope)) throw qzoneError('read_error');
  const url = new URL(fallback ? OWN_FALLBACK : FEEDS, QZONE_ORIGIN);
  const params = {
    uin: account, scope: scope === 'own' && !fallback ? '1' : '0', flag: '1', filter: 'all',
    firstGetGroup: '0', mixnocache: '0', scene: '0', sidomain: 'qzonestyle.gtimg.cn',
    useutf8: '1', outputhtmlfeed: '1', g_tk: token, count: '20'
  };
  if (fallback) {
    Object.assign(params, { hostuin: account, refresh: '0', start, refer: '2', r: Math.random() });
  } else {
    const continuation = new URLSearchParams(cursor);
    Object.assign(params, {
      view: '1', daylist: '', uinlist: '', gid: '', applist: 'all', refresh: cursor ? '0' : '1',
      aisortEndTime: '0', aisortOffset: '0', getAisort: '0', aisortBeginTime: '0',
      pagenum: continuation.get('pagenum') || '1', icServerTime: '0', begintime: continuation.get('basetime') || '',
      dayspac: '5', rd: Math.random(), usertime: Date.now(), windowId: Math.random(), format: 'json'
    });
    if (cursor) params.externparam = cursor;
  }
  url.search = new URLSearchParams(params).toString();
  return url;
}

const named = { amp: '&', apos: "'", quot: '"', lt: '<', gt: '>', nbsp: ' ' };
function decodeEntities(input) {
  return input.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? whole;
    const hex = entity[1].toLowerCase() === 'x';
    const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return value <= 0x10FFFF ? String.fromCodePoint(value) : whole;
  });
}

function plain(input) {
  return decodeEntities(input.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ''))
    .replace(/https?:\/\/[^\s<>]+/gi, '[链接]').trim();
}

function attributes(tag) {
  return Object.fromEntries(Array.from(tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g),
    ([, name, double, single]) => [name.toLowerCase(), decodeEntities(double ?? single)]));
}

function elementText(html, names) {
  // Only inspect the display portion of the feed card, before embedded comments.
  const start = html.split(/<(?:div|ul)\b[^>]*class=["'][^"']*\b(?:comments|f-comment)\b/i, 1)[0];
  const tagPattern = /<(div|p|a|span|h[1-6])\b[^>]*>/gi;
  for (const match of start.matchAll(tagPattern)) {
    const classes = (attributes(match[0]).class || '').split(/\s+/);
    if (!names.some((name) => classes.includes(name))) continue;
    const from = match.index + match[0].length;
    const tags = new RegExp(`<(/?)${match[1]}\\b[^>]*>`, 'gi');
    tags.lastIndex = from;
    let depth = 1;
    for (let next; (next = tags.exec(start)); ) {
      depth += next[1] ? -1 : 1;
      if (!depth) return plain(start.slice(from, next.index));
    }
  }
  return '';
}

function fragments(html) {
  const feedStarts = [...html.matchAll(/<[a-z][\w:-]*\b[^>]*\bid=["']feed_\d+_\d+_[^"']+["'][^>]*>/gi)];
  return feedStarts.length ? feedStarts.map((match, index) => html.slice(match.index, feedStarts[index + 1]?.index)) : [html];
}

function parseCard(html, record) {
  const firstTag = html.match(/^\s*<[^>]+>/)?.[0] || '';
  const outer = attributes(firstTag);
  const header = outer.id?.match(/^feed_(\d+)_(\d+)_\d+_(\d+)_/);
  const marker = html.match(/<[^>]*\bname=["']feed_data["'][^>]*>/i)?.[0] || '';
  const meta = attributes(marker);
  const owner = html.match(/\blink=["']nameCard_(\d+)["']/)?.[1];
  const authorId = String(meta['data-uin'] || outer['data-uin'] || header?.[1] || record.opuin || record.uin || owner || '');
  const appId = String(header?.[2] || meta['data-appid'] || outer['data-appid'] || record.appid || '');
  if (appId === '217') return { ignored: true };
  const tid = meta['data-tid'];
  const id = [tid && !/^\d+$/.test(tid) ? tid : '', meta['data-fkey'], outer['data-key'], meta['data-key'], outer['data-tid'], record.tid, record.key, tid, outer.id]
    .map((value) => String(value ?? '')).find((value) => POST_ID.test(value));
  if (id === 'advertisement_app' || authorId === '0') return { ignored: true };
  if (!id || !QZONE_ACCOUNT.test(authorId)) return null;
  const created = Number(header?.[3] || meta['data-abstime'] || record.abstime || 0);
  const author = elementText(html, ['f-name']) || plain(String(record.nickname || ''));
  const text = elementText(html, ['f-info', 'f-detail', 'txt-box', 'txt-box-title', 'content-box']) || plain(String(record.content || record.summary || ''));
  const media = /\b(?:data-pickey|data-videoid)\s*=|\bclass=["'][^"']*\b(?:img-item|img-box|f-img|video-box|f-video)\b/i.test(html);
  if (!text && !media) return null;
  return { id, authorId, author: author.slice(0, 120), text: text.slice(0, 4000), media, createdAt: created > 0 ? (created < 1e12 ? created * 1000 : created) : null };
}

const literalToken = /\s+|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[a-z_$][\w$]*|"(?:[^"\\\r\n]|\\(?:\r?\n|.))*"|'(?:[^'\\\r\n]|\\(?:\r?\n|.))*'/giy;

function parseCallbackData(source) {
  try { return JSON.parse(source); } catch { /* Some web endpoints use JavaScript literal syntax. */ }
  // Tokenize the small data-only subset and use JSON.parse for grammar. No
  // constructors, expressions, property lookups or code execution are allowed.
  const token = new RegExp(literalToken);
  const json = [];
  while (token.lastIndex < source.length) {
    const offset = token.lastIndex;
    const match = token.exec(source);
    if (!match) {
      const char = source[offset];
      const parseKind = /^["']$/.test(char) ? 'quote' : /^[()[\]{};.=]$/.test(char) ? 'punctuation' : 'other';
      throw Object.assign(qzoneError('parse_error'), { parseOffset: offset, parseKind });
    }
    const value = match[0];
    if (/^[\s/]/.test(value)) continue;
    if ((value === '}' || value === ']') && json.at(-1) === ',') json.pop();
    if (/^["']/.test(value)) {
      const escapes = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', '\\': '\\', '/': '/', "'": "'", '"': '"' };
      const decoded = value.slice(1, -1).replace(/\\(?:\r?\n|x([\da-f]{2})|u([\da-f]{4})|([^\r\n]))/gi, (_, short, long, simple) => {
        if (short || long) return String.fromCharCode(Number.parseInt(short || long, 16));
        if (simple == null) return '';
        if (Object.hasOwn(escapes, simple)) return escapes[simple];
        throw Object.assign(qzoneError('parse_error'), { parseOffset: offset, parseKind: 'escape' });
      });
      json.push(JSON.stringify(decoded));
    } else if (/^[a-z_$]/i.test(value) && /^\s*:/.test(source.slice(token.lastIndex))) {
      json.push(JSON.stringify(value));
    } else if (value === 'undefined') {
      json.push('null');
    } else if (/^[a-z_$]/i.test(value) && !['true', 'false', 'null'].includes(value)) {
      throw Object.assign(qzoneError('parse_error'), { parseOffset: offset, parseKind: 'identifier' });
    } else {
      json.push(value);
    }
  }
  return JSON.parse(json.join(' '));
}

function responseEnvelope(input) {
  const source = input.trim().replace(/^(?:(?:while\s*\(\s*1\s*\)|for\s*\(\s*;\s*;\s*\))\s*;|\/\*[\s\S]*?\*\/|\s)+/, '');
  const script = source.match(/<script\b[^>]*>\s*((?:[\w$]+\.)*[\w$]+\s*\([\s\S]*?\)\s*;?)\s*<\/script\s*>/i)?.[1];
  return (script ?? source).match(/^(?:[\w$]+\.)*[\w$]+\s*\(\s*(\{[\s\S]*\})\s*\)\s*;?$/)?.[1]
    ?? source.replace(/;\s*$/, '');
}

export function parseQzoneFeed(input) {
  const envelope = responseEnvelope(input);
  let payload;
  try { payload = parseCallbackData(envelope); } catch (error) {
    throw Object.assign(qzoneError('parse_error'), { stage: 'envelope', parseOffset: error.parseOffset, parseKind: error.parseKind || 'grammar' });
  }
  const code = payload?.code ?? payload?.ret;
  const notice = String(payload?.message || payload?.msg || '');
  if (code != null && Number(code) !== 0) {
    throw qzoneError(Number(code) === -3000 || Number(payload.subcode) === -4001 || /need\s+login|not logged|未登录|请.{0,4}登录|需要登录/i.test(notice) ? 'login_required' : 'read_error');
  }
  const main = payload?.data?.main;
  // The older scope=0 endpoint puts the timeline in friend_data, including the
  // logged-in user's own posts. The provider still filters authors per scope.
  const legacy = !Array.isArray(payload?.data?.data) && Array.isArray(payload?.data?.friend_data);
  const moreFlag = legacy ? main?.hasMoreFeeds_0 : main?.hasMoreFeeds;
  const more = [true, 1, '1', 'true'].includes(moreFlag);
  const explicitEnd = [false, 0, '0', 'false'].includes(moreFlag);
  const cursor = typeof main?.externparam === 'string' && main.externparam.length <= 4000 ? main.externparam : '';
  const next = new URLSearchParams(cursor);
  const validCursor = /^\d{1,5}$/.test(next.get('pagenum') || '') && /^\d{1,16}$/.test(next.get('basetime') || '');
  const responseRecords = legacy ? payload.data.friend_data : payload?.data?.data;
  const continuationKnown = more && (legacy || validCursor);
  const records = (explicitEnd || continuationKnown) && Number(code) === 0
    ? Array.isArray(responseRecords) ? responseRecords.filter((record) => record !== null) : responseRecords ?? []
    : responseRecords;
  if (!Array.isArray(records) || records.length > 250 || records.length === 0 && !explicitEnd && !continuationKnown) {
    throw Object.assign(qzoneError('parse_error'), { stage: 'list', records: Array.isArray(records) ? records.length : null });
  }
  const items = [];
  let unrecognized = 0;
  for (const record of records) {
    if (!record || typeof record !== 'object') { unrecognized++; continue; }
    const html = String(record.html || '').replace(/\\+x(22|27|3c|3e)/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\+\//g, '/');
    for (const fragment of fragments(html)) {
      const item = parseCard(fragment, record);
      if (!item) unrecognized++;
      else if (!item.ignored) items.push(item);
    }
  }
  if (unrecognized && !items.length) throw Object.assign(qzoneError('parse_error'), { stage: 'cards', records: records.length, unrecognized });
  return { items, more, cursor: more ? cursor : '', unrecognized };
}

export function describeQzoneResponse(input) {
  const source = input.trim();
  let fieldShape;
  try {
    const payload = parseCallbackData(responseEnvelope(source));
    const keys = object => object && typeof object === 'object' && !Array.isArray(object)
      ? Object.keys(object).filter(key => /^[A-Za-z_][A-Za-z_\d]{0,39}$/.test(key)).slice(0, 60) : [];
    fieldShape = { dataKeys: keys(payload.data), mainKeys: keys(payload.data?.main),
      mainFlags: Object.fromEntries(keys(payload.data?.main).filter(key => typeof payload.data.main[key] === 'boolean').map(key => [key,payload.data.main[key]])) };
  } catch { /* Unknown source stays represented by its sanitized token structure. */ }
  const count = (regex) => (source.match(regex) || []).length;
  const numberField = (name) => {
    const value = source.slice(0, 8192).match(new RegExp(`(?:^|[,{])\\s*["']?${name}["']?\\s*:\\s*["']?(-?\\d{1,8})(?!\\d)`))?.[1];
    return value == null ? null : Number(value);
  };
  return {
    bytes: Buffer.byteLength(source),
    envelope: /^(?:<!doctype|<html|<head)/i.test(source) ? 'html' : /^\s*\{/.test(source) ? 'object' : /^\s*[\w.$]+\s*\(/.test(source) ? 'callback' : source ? 'other' : 'empty',
    code: numberField('code'), ret: numberField('ret'), subcode: numberField('subcode'),
    script: count(/<script\b/gi), callback: count(/(?:_Callback|frameElement\.callback)\s*\(/g),
    htmlField: count(/\bhtml["']?\s*:/g), mainField: count(/\bmain["']?\s*:/g), dataField: count(/\bdata["']?\s*:/g),
    moreField: count(/\bhasMoreFeeds["']?\s*:/g), feedMarkers: count(/feed_data|feed_\d+_\d+_/g),
    textMarkers: count(/f-info|f-detail|txt-box|content-box/g), escapedTags: count(/\\x3c|\\u003c/gi),
    structure: sanitizedStructure(source),
    cursorShape: cursorShape(source), fieldShape
  };
}

function cursorShape(source) {
  const cursor = source.match(/\bexternparam["']?\s*:\s*["']([^"']{0,4000})["']/)?.[1];
  if (cursor == null) return null;
  const params = new URLSearchParams(cursor);
  return { length: cursor.length, basetime: params.has('basetime'), pagenum: params.has('pagenum') };
}

const STRUCTURE_KEYS = new Set(['code', 'ret', 'subcode', 'message', 'msg', 'time', 'notice', 'tips', 'data', 'main', 'hasMoreFeeds',
  'externparam', 'pagenum', 'begintime', 'dayspac', 'html', 'key', 'uin', 'opuin', 'nickname', 'appid', 'abstime', 'content',
  'scope', 'filter', 'refresh', 'count', 'start', 'total', 'items', 'feeds', 'list', 'end', 'next', 'offset', 'result']);
const STRUCTURE_LITERALS = new Set(['true', 'false', 'null', 'undefined']);
const STRUCTURE_WRAPPERS = new Set(['_Callback', 'callback', 'frameElement', 'while', 'for']);

function sanitizedStructure(source) {
  const token = new RegExp(literalToken);
  let output = '';
  for (let offset = 0; offset < source.length && output.length < 2048;) {
    token.lastIndex = offset;
    const match = token.exec(source);
    if (!match) {
      const char = source[offset++];
      if (/^["']$/.test(char)) { output += '"_?"'; break; }
      output += /^[().;=<>]$/.test(char) ? char : '?';
      continue;
    }
    offset = token.lastIndex;
    const value = match[0];
    if (/^[\s/]/.test(value)) continue;
    const next = source.slice(offset, offset + 256).trimStart()[0];
    if (/^["']/.test(value)) {
      const key = value.slice(1, -1);
      output += next === ':' && STRUCTURE_KEYS.has(key) ? key : next === ':' ? '_' : '"_"';
    } else if (/^-?\d/.test(value)) output += '0';
    else if (/^[a-z_$]/i.test(value)) {
      output += next === ':' && STRUCTURE_KEYS.has(value) || STRUCTURE_LITERALS.has(value) || STRUCTURE_WRAPPERS.has(value) ? value : '_';
    } else output += value;
  }
  return output.slice(0, 2048);
}
