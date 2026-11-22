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

export async function queryOneBotStatus(httpUrl, token, { viaCore = false } = {}) {
  try {
    const method = viaCore ? 'GET' : 'POST';
    const res = await fetch(httpUrl + '/get_status', { method, body: viaCore ? undefined : '{}',
      headers: { ...(!viaCore && { 'content-type': 'application/json' }), ...(token && { authorization: 'Bearer ' + token }) },
      signal: AbortSignal.timeout(4000), redirect: 'manual' });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.status === 'ok' && body.retcode === 0 && typeof body.data?.online === 'boolean') {
      return { statusOnline: body.data.online, statusError: '' };
    }
    const statusError = viaCore && typeof body?.wording === 'string' && /^UPSTREAM_[A-Z0-9_]{1,64}$/.test(body.wording) ? body.wording
      : res.ok ? 'INVALID_STATUS_RESPONSE' : (viaCore ? 'HTTP_' : 'UPSTREAM_HTTP_') + res.status;
    return { statusOnline: null, statusError };
  } catch (error) {
    return { statusOnline: null, statusError: error.name === 'TimeoutError' ? 'STATUS_TIMEOUT' : 'STATUS_UNAVAILABLE' };
  }
}

// A standalone report checks the user's configured listener without starting Agent or QQ.
export async function inspectStandardConnection(getSettings) {
  const state = { directOneBot: true, backendType: 'onebot', running: false, backendReady: false,
    statusOnline: null, statusError: '', connection: {} };
  let config;
  try { config = normalizeStandardConnection(getSettings()); }
  catch { return { ...state, code: 'ONEBOT_CONFIG_INVALID' }; }
  const { default: WebSocket } = await import('ws');
  const url = new URL(config.wsUrl);
  if (config.accessToken) url.searchParams.set('access_token', config.accessToken);
  const verifyEvents = new Promise(resolve => {
    const socket = new WebSocket(url, { handshakeTimeout: 4000, followRedirects: false, perMessageDeflate: false,
      headers: config.accessToken ? { authorization: 'Bearer ' + config.accessToken } : {} });
    socket.once('error', () => resolve('disconnected'));
    socket.once('unexpected-response', (_req, res) => {
      resolve([401, 403].includes(res.statusCode) ? 'auth_failed' : 'disconnected');
      res.destroy();
      socket.terminate();
    });
    socket.once('open', () => { resolve('open'); socket.terminate(); });
  });
  const token = config.httpAccessToken || config.accessToken;
  const [ws, status] = await Promise.all([verifyEvents, queryOneBotStatus(config.httpUrl, token)]);
  Object.assign(state, status);
  state.connection = { ws, receiveReady: ws === 'open' };
  state.backendReady = ws === 'open' && state.statusOnline === true;
  return state;
}
