import { listNativeStickers } from '../../src/native-stickers.js';
import { STICKER_BATCH_LIMIT } from '../../src/builtins/sticker-model.js';

let lifetime = new AbortController();
export function activate() { if (lifetime.signal.aborted) lifetime = new AbortController(); }
export function deactivate() { lifetime.abort(); }
export const dispose = deactivate;

const response = (value, isError = false) => ({ content: JSON.stringify(value), isError });

export function setup(api) {
  api.registerTool({
    id: 'search', name: '按标签检索会话表情', category: 'sticker',
    description: '用文字检索收藏表情的标签、情绪、适用场景和备注，返回可发送 ID。',
    parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 80 }, limit: { type: 'integer' } },
      required: ['query'], additionalProperties: false },
    async execute(ctx, args) {
      try {
        return response(listNativeStickers(ctx, { query: String(args.query ?? '').slice(0, 80),
          limit: Math.min(20, Number(args.limit) || 10) }));
      } catch (error) {
        return response({ error: error.message }, true);
      }
    }
  });
  api.registerTool({
    id: 'collect_batch', name: '按人设筛选并收藏一批 QQ 表情', category: 'sticker',
    requires: ['sticker.batch_collect'], requiresVision: true,
    description: '根据当前人设和审核设置处理同一会话的多个表情。仅在用户明确提出收藏请求时调用。',
    parameters: { type: 'object', properties: {
      messageIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: STICKER_BATCH_LIMIT }
    }, required: ['messageIds'], additionalProperties: false },
    async execute(ctx, args) {
      try {
        if (!Array.isArray(args.messageIds) || !args.messageIds.length || args.messageIds.length > STICKER_BATCH_LIMIT ||
            !args.messageIds.every((id) => /^-?[1-9]\d{0,19}$/.test(String(id)))) throw new Error('QQ 消息编号无效');
        const signal = ctx.signal ? AbortSignal.any([lifetime.signal, ctx.signal]) : lifetime.signal;
        const result = await api.capability('sticker.batch_collect', { account: String(ctx.selfId),
          chatKey: ctx.chatKey, messageIds: args.messageIds, session: ctx.session, signal });
        if (!result) throw new Error('表情收藏与标签库插件未开启');
        return response(result);
      } catch (error) {
        return response({ error: error.message }, true);
      }
    }
  });
}
