import { getBuiltinRuntime } from '../../src/builtin-runtime.js';
import { getConfig } from '../../src/config.js';
import { ensureStickerDecision } from '../../src/sticker-policy.js';
import { createGengjing } from '../../src/builtins/gengjing.js';
import { errorCode, recordDeliveryError } from '../../src/session-effects.js';

let lifetime = new AbortController();
let service;
let bound;
let attempted = new WeakSet();

export function activate() { if (lifetime.signal.aborted) lifetime = new AbortController(); }
export function deactivate() {
  lifetime.abort();
  service = undefined;
  bound = undefined;
  attempted = new WeakSet();
}
export const dispose = deactivate;

const criteria = {
  keyword: { type: 'string', maxLength: 100, description: '短关键词，优先用台词中的词或情绪，例如 委屈。' },
  character: { type: 'string', maxLength: 70, description: '梗图角色，例如 DeepSeek娘、GPT娘。' }
};

function currentService(runtime) {
  if (runtime !== bound) {
    service = createGengjing({ runtime });
    bound = runtime;
  }
  return service;
}

export function promptSections() {
  return [{
    id: 'gengjing-contextual',
    title: '梗鲸配图设置',
    content: contextualSend()
      ? '只有【本轮表情许可】允许时，才可按标签和语境挑一张梗图；与原生表情共用本轮一次额度，禁止换工具重试。'
      : '只有对方明确提出要发梗图、表情图或指定该角色图片时才调用发送工具。'
  }];
}

let contextualSend = () => true;

export function setup(api) {
  contextualSend = () => api.config().allowContextualSend === true;
  for (const mode of ['search', 'send']) {
    const sending = mode === 'send';
    api.registerTool({
      id: mode, name: sending ? '发送梗鲸原图' : '检索梗鲸表情包',
      category: sending ? 'messaging' : 'sticker',
      description: sending
        ? '发送一张匹配的梗鲸原图到当前会话。建议先检索，传入同一关键词或角色及选中的图片编号。'
        : '用关键词或角色检索梗鲸公开索引，返回标题、角色、原帖和可选编号。',
      parameters: { type: 'object', properties: { ...criteria, ...(sending && {
        imageId: { type: 'string', pattern: '^\\d{1,7}$', description: '检索返回的原始图片编号。' }
      }) }, additionalProperties: false },
      async execute(ctx, args) {
        const account = String(ctx.selfId);
        let unsubscribe;
        try {
          const runtime = getBuiltinRuntime();
          if (!runtime) throw new Error('梗鲸服务未就绪');
          const operation = new AbortController();
          const signal = AbortSignal.any([lifetime.signal, operation.signal, ctx.signal].filter(Boolean));
          unsubscribe = runtime.subscribe('status', (status) => {
            if (status?.paused || status?.connected === false || !runtime.isCurrent(account)) operation.abort();
          });
          if (sending && ctx.session) {
            if (attempted.has(ctx.session)) throw new Error('本轮已经尝试发送梗鲸图片');
            attempted.add(ctx.session);
          }
          const cooldownMs = 1000 * Math.max(10, Math.min(600, Number(api.config().cooldownSeconds) || 60));
          const result = await currentService(runtime)[mode]({
            ...args, account, chatKey: ctx.chatKey, signal, cooldownMs,
            ...(sending && { stickerPolicy: ensureStickerDecision(ctx.session, { selfId: account, chatKey: ctx.chatKey, sticker: getConfig().sticker }) })
          });
          if (sending && result.sent) {
            ctx.session?.sent?.push({ type: 'sticker', text: '[梗鲸图片]', messageId: result.messageId,
              at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
            if (result.bookkeepingWarning && ctx.session) {
              (ctx.session.localErrors ??= []).push({ code: 'SENDER_BOOKKEEPING_FAILED', message: result.bookkeepingWarning });
            }
            if (ctx.session?.id) ctx.emit?.('session-update', ctx.session.id);
          }
          return { content: JSON.stringify(result), isError: false };
        } catch (error) {
          if (sending && ctx.session) recordDeliveryError(ctx.session, error);
          return { content: JSON.stringify({ error: error.message, ...(error.delivery === 'unknown' && { delivery: 'unknown' }) }),
            isError: true, code: error.delivery === 'unknown' ? 'DELIVERY_UNKNOWN' : errorCode(error) };
        } finally {
          unsubscribe?.();
        }
      }
    });
  }
}
