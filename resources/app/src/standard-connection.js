const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function endpoint(value, protocols, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} 地址无效。`); }
  if (!protocols.includes(url.protocol) || !LOOPBACK.has(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} 需要本机地址，访问令牌请单独填写。`);
  }
  return url.href.replace(/\/+$/, '');
}

function token(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^[\x21-\x7e]*$/.test(value)) {
    throw new Error('访问令牌格式无效。');
  }
  return value;
}

export function normalizeStandardConnection(value, previous = {}) {
  const httpUrl = endpoint(value.httpUrl, ['http:', 'https:'], 'HTTP');
  const wsUrl = endpoint(value.wsUrl, ['ws:', 'wss:'], 'WebSocket');
  const accessToken = token(value.accessToken ?? previous.accessToken ?? '');
  const httpAccessToken = token(value.httpAccessToken ?? previous.httpAccessToken ?? '');
  return { httpUrl, wsUrl, accessToken, httpAccessToken, autoLaunch: false, dir: '', configFile: '' };
}
