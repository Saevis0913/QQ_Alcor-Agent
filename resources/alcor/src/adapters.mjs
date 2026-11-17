import { BridgeError } from './backend.mjs';

// Opt-in contracts verified against reference-runtime 2.2.0 and external-onebot 4.18.42.
// These adapters do not implement either native QQ connection.
export const adaptedActions = ['delete_group_file_folder', 'set_group_reaction'];
const failed = (wording, retcode = 1500) => ({ status: 'failed', retcode, data: null, wording });
const succeeded = response => response.status === 'ok' && response.retcode === 0;
const badParameter = () => { throw new BridgeError('INVALID_ADAPTER_PARAMETERS', 400); };
function integer(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+$/.test(value))) badParameter();
  const n = Number(value); if (!Number.isSafeInteger(n)) badParameter(); return n;
}
function groupId(value) { const n = integer(value); if (n <= 0) badParameter(); return String(n); }
function nonempty(value) { if (typeof value !== 'string' || !value.trim()) badParameter(); return value; }
function boolean(value) {
  if (value === undefined) return true;
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return badParameter();
}
function nativeResult(response, field) {
  if (!succeeded(response)) return response;
  const code = response.data?.[field];
  if (!Number.isInteger(code)) return failed('UPSTREAM_NATIVE_RESULT_INVALID');
  if (code !== 0) return failed('UPSTREAM_NATIVE_ACTION_FAILED');
  return { status: 'ok', retcode: 0, data: null };
}

export async function compatibleCall(config, backend, action, params, reserve) {
  const call = (name, payload) => backend.call(name, payload, reserve);
  if (config.compatibility !== 'legacy-onebot') return call(action, params);
  if (action === 'delete_group_file_folder') {
    const group_id = groupId(params.group_id), folder_id = nonempty(params.folder_id);
    // Do not forward an unrelated `folder` parameter which external-onebot prioritizes over folder_id.
    return nativeResult(await call('delete_group_folder', { group_id, folder_id }), 'retCode');
  }
  if (action === 'set_group_reaction') {
    const message_id = integer(params.message_id), emoji_id = nonempty(params.code), set = boolean(params.is_set);
    const expectedGroup = params.group_id === undefined ? undefined : groupId(params.group_id);
    const found = await call('get_msg', { message_id });
    if (!succeeded(found)) return found;
    const message = found.data;
    if (message?.message_type !== 'group' || !message.group_id) return failed('GROUP_MESSAGE_NOT_FOUND', 1404);
    if (expectedGroup !== undefined && String(message.group_id) !== expectedGroup) return failed('GROUP_MESSAGE_SESSION_MISMATCH', 1400);
    // external-onebot checks its native message sequence before invoking the mutation.
    return nativeResult(await call('set_msg_emoji_like', { message_id, emoji_id, set }), 'result');
  }
  return call(action, params);
}
