import { canReadAdminErrors } from '../../src/builtins/admin-errors.js';
import { getConfig } from '../../src/config.js';
import { errorCode, recordDeliveryError } from '../../src/session-effects.js';

let lifetime = new AbortController();
export function activate() { if (lifetime.signal.aborted) lifetime = new AbortController(); }
export function deactivate() { lifetime.abort(); }
export const dispose = deactivate;

const allowed = (ctx) => canReadAdminErrors(ctx, getConfig().privatePolicy?.adminQQs);
const denied = { code: 'ADMIN_PRIVATE_ONLY', reason: '仅当前管理员私聊可查看错误摘要' };

export function promptSections(ctx) {
  return allowed(ctx) ? [{
    id: 'admin-digest-usage', title: '管理员私聊',
    content: '当前管理员询问机器人运行状态或近期错误时，使用管理员摘要工具。摘要工具直接发送私信，完成后结束本轮。'
  }] : [];
}

export function setup(api) {
  api.registerTool({
    id: 'admin_digest', name: '发送管理员错误摘要', category: 'messaging',
    description: '当前管理员在私聊主动询问运行状态或近期异常时调用。工具会直接向当前私聊发送脱敏摘要。调用后不要另发摘要或重复发送。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    checkAvailability: (ctx) => allowed(ctx) ? null : denied,
    async execute(ctx) {
      if (!allowed(ctx)) return { content: denied.reason, code: denied.code, isError: true };
      const signal = ctx.signal ? AbortSignal.any([lifetime.signal, ctx.signal]) : lifetime.signal;
      try {
        const result = await api.capability('admin.error_digest', { ctx, signal });
        if (!result) throw new Error('管理员异常汇总插件未开启');
        if (result.sent && ctx.session?.id) ctx.emit?.('session-update', ctx.session.id);
        return { content: result.duplicate ? '当前会话已经请求过摘要，已跳过重复发送。' : '管理员摘要已通过 QQ 私聊发送。', isError: false };
      } catch (error) {
        if (ctx.session) recordDeliveryError(ctx.session, error);
        const code = errorCode(error);
        return { content: error.delivery === 'unknown'
          ? '管理员摘要送达状态未知，请先确认收件端。' : '管理员摘要发送未确认。',
        isError: true, code: error.delivery === 'unknown' ? 'DELIVERY_UNKNOWN' : code };
      }
    }
  });
}
