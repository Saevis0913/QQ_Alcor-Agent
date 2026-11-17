import { isIP } from 'node:net';
import sax from 'sax';
import { Agent } from 'undici';
import { getConfig } from '../config.js';
import { checkBrowseLock, validateFetchUrl } from '../safe-fetch.js';
import { readGet } from '../network-read.js';

export const defaultTrendSource = 'Google Trends · 台湾';
const sources = new Map([
  [defaultTrendSource, { url: new URL('https://trends.google.com/trending/rss?geo=TW'), titleLimit: 6 }],
  // 中国新闻网在 https://www.chinanews.com.cn/rss/ 公布即时新闻订阅地址。
  ['中国新闻网 · 即时新闻', { url: new URL('https://www.chinanews.com.cn/rss/scroll-news.xml'), titleLimit: 30 }]
]);
const maximumBytes = 256 * 1024;

// Resolve the public address inside the connector to pin the TLS connection.
const trendDispatcher = new Agent({
  connect: {
    lookup(hostname, { all }, callback) {
      validateFetchUrl('https://' + hostname).then(({ ip }) => {
        const family = isIP(ip);
        if (all) callback(null, [{ address: ip, family }]);
        else callback(null, ip, family);
      }, callback);
    }
  }
});

export function trendAccessError(source = defaultTrendSource) {
  if (getConfig().webSearch?.enabled === false) return '联网搜索已关闭。';
  const endpoint = sources.get(source)?.url;
  if (!endpoint) return '公开话题来源无效。';
  if (!checkBrowseLock(endpoint.href).allowed) return '浏览锁定未允许访问 ' + endpoint.hostname + '。';
  return '';
}

function parseTitles(xml, titleLimit) {
  const parser = sax.parser(true, { strictEntities: true });
  const invalid = () => { throw new Error('公开话题 RSS 格式无效。'); };
  const tags = [];
  const titles = new Set();
  let sawRoot = false;
  let title;

  parser.onerror = parser.ondoctype = invalid;
  parser.onopentag = ({ name }) => {
    if (!tags.length) {
      if (sawRoot || name !== 'rss') invalid();
      sawRoot = true;
    }
    if (titles.size < titleLimit && tags.length === 3 && tags[1] === 'channel' && tags[2] === 'item' && name === 'title') {
      title = '';
    }
    tags.push(name);
  };
  parser.ontext = parser.oncdata = fragment => { if (title !== undefined) title += fragment; };
  parser.onclosetag = () => {
    if (title !== undefined && tags.length === 4) {
      const text = title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
      if (text) titles.add(text);
      title = undefined;
    }
    tags.pop();
  };
  parser.write(xml).close();
  if (!sawRoot) invalid();
  if (!titles.size) throw new Error('公开话题 RSS 当前没有可读标题。');
  return [...titles];
}

export async function fetchTrends(fetch, signal, source = defaultTrendSource, isSelected = () => true) {
  const assertAccess = () => {
    const error = trendAccessError(source);
    if (error) throw new Error(error);
    if (!isSelected()) throw new Error('公开话题来源已变更。');
  };
  assertAccess();
  const { url, titleLimit } = sources.get(source);
  const response = await readGet(url.href, {
    fetchImpl: (url, init) => fetch(url, { ...init, dispatcher: trendDispatcher }), signal,
    headers: { accept: 'application/rss+xml, text/xml, application/xml' },
    timeoutMs: 20000, attemptMs: 7000, maxBytes: maximumBytes, label: '公开话题',
    accepts: type => /xml(?:;|$)/i.test(type), beforeAttempt: assertAccess
  });
  assertAccess();
  return parseTitles(response.buffer.toString('utf8'), titleLimit);
}
