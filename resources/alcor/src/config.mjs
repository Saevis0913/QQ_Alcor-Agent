import fs from 'node:fs';
import path from 'node:path';

const loopbacks = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
function number(value, fallback, min, max, name) {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < min || selected > max) throw new Error(`Invalid ${name}`);
  return selected;
}
function endpoint(value, protocols, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid ${name}`); }
  if (!protocols.includes(url.protocol) || !loopbacks.has(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error(`Invalid ${name}: requires a loopback endpoint without embedded credentials`);
  return url.href.replace(/\/$/, '');
}
function outboundRows(value, kind, listen) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error(`Invalid ${kind}`);
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Invalid ${kind}`);
    const ws = kind === 'reverseWebSockets';
    const keys = ws ? ['url', 'token'] : ['url', 'secret', 'quickReply', 'timeoutMs', 'maxQueue'];
    if (Object.keys(row).some(k => !keys.includes(k))) throw new Error(`Invalid ${kind} fields`);
    let url;
    try { url = new URL(row.url); } catch { throw new Error(`Invalid ${kind} URL`); }
    const local = loopbacks.has(url.hostname);
    const port = Number(url.port || (['https:', 'wss:'].includes(url.protocol) ? 443 : 80));
    if (!(ws ? ['ws:', 'wss:'] : ['http:', 'https:']).includes(url.protocol) ||
        (!local && !['https:', 'wss:'].includes(url.protocol)) || url.username || url.password || url.hash || url.search ||
        (local && port === (listen.port ?? 5310))) throw new Error(`Invalid ${kind} endpoint: use local or encrypted external URL, not this core`);
    const secret = row[ws ? 'token' : 'secret'] ?? '';
    if (typeof secret !== 'string' || secret.length > 4096 || !/^[\x20-\x7e]*$/.test(secret)) throw new Error(`Invalid ${kind} credential`);
    if (ws) return { url: url.href, token: secret };
    if (row.quickReply !== undefined && typeof row.quickReply !== 'boolean') throw new Error('Invalid callback quickReply');
    return { url: url.href, secret, quickReply: row.quickReply ?? false,
      timeoutMs: number(row.timeoutMs, 5000, 50, 30000, 'callback timeoutMs'),
      maxQueue: number(row.maxQueue, 64, 1, 256, 'callback maxQueue') };
  });
}
export function normalizeConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid configuration');
  const listen = input.listen ?? {};
  const backend = input.backend ?? {};
  if(backend.type!==undefined && !['native','onebot'].includes(backend.type))throw new Error('Invalid backend.type');
  const native=backend.type==='native';
  if(native && input.compatibility!==undefined && input.compatibility!=='passthrough')throw new Error('Native backend requires native action handling');
  if(native && ['httpUrl','wsUrl','httpToken','wsToken','onebotConfigFile'].some(key=>backend[key]!==undefined))throw new Error('Native backend must not contain external backend routing');
  if (!loopbacks.has(listen.host ?? '127.0.0.1')) throw new Error('Invalid listen.host: loopback required');
  if (typeof listen.token !== 'string' || listen.token.length < 16 || !/^[\x21-\x7e]+$/.test(listen.token)) throw new Error('Invalid listen.token: at least 16 visible ASCII characters required');
  if (input.readOnly !== undefined && typeof input.readOnly !== 'boolean') throw new Error('Invalid readOnly');
  if (input.compatibility !== undefined && !['passthrough', 'legacy-onebot'].includes(input.compatibility)) throw new Error('Invalid compatibility mode');
  for (const key of ['httpToken', 'wsToken']) if (backend[key] !== undefined && (typeof backend[key] !== 'string' || !/^[\x20-\x7e]*$/.test(backend[key]))) throw new Error(`Invalid backend.${key}`);
  const result = {
    listen: { host: listen.host ?? '127.0.0.1', port: number(listen.port, 5310, 0, 65535, 'listen.port'), token: listen.token },
    backend: native ? {type:'native'} : { httpUrl: endpoint(backend.httpUrl, ['http:', 'https:'], 'backend.httpUrl'), wsUrl: endpoint(backend.wsUrl, ['ws:', 'wss:'], 'backend.wsUrl'), httpToken: backend.httpToken ?? '', wsToken: backend.wsToken ?? '' },
    readOnly: input.readOnly ?? true,
    compatibility: input.compatibility ?? 'passthrough',
    requestTimeoutMs: number(input.requestTimeoutMs, 15000, 1, 300000, 'requestTimeoutMs'),
    sendTimeoutMs: number(input.sendTimeoutMs, 120000, 1, 600000, 'sendTimeoutMs'),
    maxBodyBytes: number(input.maxBodyBytes, 32 * 1024 * 1024, 128, 64 * 1024 * 1024, 'maxBodyBytes'),
    maxResponseBytes: number(input.maxResponseBytes, 32 * 1024 * 1024, 128, 64 * 1024 * 1024, 'maxResponseBytes'),
    maxJsonDepth: number(input.maxJsonDepth, 64, 4, 128, 'maxJsonDepth'),
    maxBufferedBytes: number(input.maxBufferedBytes, 64 * 1024 * 1024, 128, 256 * 1024 * 1024, 'maxBufferedBytes'),
    maxConnections: number(input.maxConnections, 64, 1, 512, 'maxConnections'),
    maxWsClients: number(input.maxWsClients, 16, 1, 128, 'maxWsClients'),
    clientTimeoutMs: number(input.clientTimeoutMs, Math.max((input.sendTimeoutMs ?? 120000) + 5000, 30000), 20, 900000, 'clientTimeoutMs'),
    maxConcurrent: number(input.maxConcurrent, 32, 1, 256, 'maxConcurrent'),
    reconnectMinMs: number(input.reconnectMinMs, 1000, 10, 60000, 'reconnectMinMs'),
    reconnectMaxMs: number(input.reconnectMaxMs, 30000, 10, 300000, 'reconnectMaxMs'),
    wsHeartbeatMs: number(input.wsHeartbeatMs, 20000, 20, 120000, 'wsHeartbeatMs')
  };
  result.httpCallbacks = outboundRows(input.httpCallbacks, 'httpCallbacks', result.listen);
  result.reverseWebSockets = outboundRows(input.reverseWebSockets, 'reverseWebSockets', result.listen);
  if (result.reconnectMinMs > result.reconnectMaxMs) throw new Error('Invalid reconnect interval order');
  return result;
}

export function loadConfig(filename) {
  let input;
  try { input = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { throw new Error('Cannot read configuration JSON'); }
  if(input.backend?.type==='native')return normalizeConfig(input);
  // This file is a user-selected local OneBot server config, not a QQ login/session credential.
  if (input.backend?.onebotConfigFile) {
    let source;
    try { source = JSON.parse(fs.readFileSync(path.resolve(path.dirname(filename), input.backend.onebotConfigFile), 'utf8')); } catch { throw new Error('Cannot read selected OneBot connection configuration'); }
    for (const [kind, urlKey, tokenKey] of [['httpServers', 'httpUrl', 'httpToken'], ['wsServers', 'wsUrl', 'wsToken']]) {
      const url = new URL(endpoint(input.backend[urlKey], [kind === 'httpServers' ? 'http:' : 'ws:'], `backend.${urlKey}`));
      const port = Number(url.port || (url.protocol === 'http:' || url.protocol === 'ws:' ? 80 : 443));
      const network = source.networks ?? source.network;
      const entries = (network?.[kind] ?? []).filter(row => Number(row.port) === port && loopbacks.has(row.host || '127.0.0.1'));
      if (entries.length !== 1) throw new Error(`Selected OneBot ${kind} entry is ambiguous or missing`);
      input.backend[tokenKey] = entries[0].accessToken ?? entries[0].token ?? '';
    }
  }
  return normalizeConfig(input);
}
