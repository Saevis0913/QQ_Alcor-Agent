import { getBuiltinRuntime } from '../../src/builtin-runtime.js';
import { createProfileLike } from '../../src/builtins/profile-like.js';
import { errorCode, recordDeliveryError } from '../../src/session-effects.js';

let lifetime = new AbortController();
export function activate() {
  if (lifetime.signal.aborted) lifetime = new AbortController();
}
export function deactivate() { lifetime.abort(); }
export const dispose = deactivate;

export function setup(api) {
  api.registerTool({
    id: 'send_profile_like',
    name: '给请求者的QQ资料卡点赞',
    category: 'messaging',
    description: '仅在当前真实发言者明确要求给其本人QQ资料卡点赞时使用。不能给第三人、空间或说说点赞。未知结果禁止重试。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        targetUserId: { type: 'string', pattern: '^[1-9]\\d{0,9}$',
          description: '仅可填写本轮明确请求为自己点赞的发言者QQ号。只有一位请求者时可省略，多位时必须选择一位。' },
        times: { type: 'integer', minimum: 1, maximum: 10, default: 1,
          description: '点赞次数，默认1，每账号每天对同一用户最多10次（含未确认请求）。' }
      }
    },
    async execute(ctx, args) {
      let unsubscribe;
      try {
        const runtime = getBuiltinRuntime();
        if (!runtime) throw Object.assign(new Error('资料卡点赞服务未就绪。'), { code: 'PROFILE_LIKE_NOT_READY' });
        const operation = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, operation.signal, ctx.signal].filter(Boolean));
        const account = String(ctx.selfId);
        unsubscribe = runtime.subscribe('status', status => {
          if (status?.paused || status?.connected === false || !runtime.isCurrent(account)) operation.abort();
        });
        const service = createProfileLike({ runtime,
          isActive: context => getBuiltinRuntime() === runtime && api.isSkillActive('profile-like', context) });
        const result = await service.execute(ctx, args, { signal });
        return { content: JSON.stringify(result), isError: false };
      } catch (error) {
        if (ctx.session) recordDeliveryError(ctx.session, error);
        return { content: JSON.stringify({ error: error.message,
          ...(error.delivery === 'unknown' && { delivery: 'unknown' }) }),
        isError: true, code: error.delivery === 'unknown' ? 'DELIVERY_UNKNOWN' : errorCode(error) };
      } finally { unsubscribe?.(); }
    }
  });
}
