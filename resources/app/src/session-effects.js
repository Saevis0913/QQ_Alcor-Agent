// Delivery uncertainty blocks automatic and manual replays of this run.
export function sessionHasEffects(session) {
  return Boolean(session?.deliveryUnknown || session?.sideEffects?.length || session?.sent?.length);
}

/**
 * 会话终态：出错记 error；有实际动作记 done；一个字都没发出记 noreply。
 * #runAgent 收尾与"补发后重新结算"必须用同一套判定，否则两边会打架
 * （补发那次运行结束时被判成 done、落盘却停在上一次的 noreply）。
 */
export function sessionStatus(session) {
  if (session?.error) return 'error';
  return sessionHasEffects(session) ? 'done' : 'noreply';
}

export function recordDeliveryError(session, error) {
  if (error?.delivery === 'unknown') session.deliveryUnknown = true;
  if (error?.nonretryable) session.nonretryable = true;
  return error;
}

export function errorCode(error) {
  const explicit = String(error?.code || '');
  if (/^[A-Z][A-Z0-9_]{2,80}$/.test(explicit)) return explicit;
  const text = String(error?.message ?? error ?? '');
  const nativeCode = text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/)?.[0];
  const httpStatus = text.match(/\bHTTP\s+(\d{3})\b/)?.[1];
  if (/authentication_error|invalid_api_key|invalid\s+api\s+key|api key:\s*\*+|your api key[^.]{0,40}invalid|incorrect api key|unauthorized|\b401\b/i.test(text)) return 'API_KEY_INVALID';
  if (/insufficient\s+(quota|balance)|quota[_ ]exceeded|exceeded your current quota|余额不足|额度不足|\b402\b/i.test(text)) return 'API_QUOTA_EXCEEDED';
  if (/model[_ ]not[_ ]found|no such model|does not exist|invalid model|model .{0,40}not found/i.test(text)) return 'MODEL_NOT_AVAILABLE';
  if (httpStatus === '401') return 'API_KEY_INVALID';
  if (httpStatus === '402') return 'API_QUOTA_EXCEEDED';
  return nativeCode || (httpStatus ? `HTTP_${httpStatus}` : 'AGENT_OPERATION_FAILED');
}
