import { getBuiltinRuntime } from '../../src/builtin-runtime.js';
import { getConfig, personaForChat } from '../../src/config.js';
import { collectNativeStickerBatch } from '../../src/native-stickers.js';
import { checkStickerScope, createStickerModel } from '../../src/builtins/sticker-model.js';
import { queueIncomingStickers } from '../../src/builtins/sticker-library.js';
import { isSkillEnabledInConfig } from '../../src/skills/config.js';

let api;
let stop;
let lifetime = new AbortController();
const collecting = () => getConfig().sticker?.enabled !== false && getConfig().sticker?.collectEnabled === true &&
  isSkillEnabledInConfig('sticker-library');

export function setup(extensionApi) { api = extensionApi; }

async function collect(input) {
  const runtime = getBuiltinRuntime();
  if (!runtime) throw new Error('表情标签服务未就绪');
  const lifetimeSignal = lifetime.signal;
  const signal = input.signal ? AbortSignal.any([input.signal, lifetimeSignal]) : lifetimeSignal;
  const scope = { ...input, signal };
  const guard = () => {
    if (!collecting() || getBuiltinRuntime() !== runtime) throw new Error('表情标签收藏已暂停');
    checkStickerScope(runtime, scope);
  };
  guard();
  const classify = createStickerModel({ runtime, mode: 'labels' });
  return collectNativeStickerBatch({
    selfId: input.account, chatKey: input.chatKey, onebot: runtime.onebot,
    store: runtime.store, stickers: runtime.stickers, session: input.session
  }, {
    messageIds: input.messageIds, signal, guard,
    classify: (request) => classify({ ...request, persona: personaForChat(request.chatKey),
      preference: api.config().preference })
  });
}

export const providers = { 'sticker.batch_collect': collect };

export function activate() {
  const runtime = getBuiltinRuntime();
  if (!runtime || stop) return;
  if (lifetime.signal.aborted) lifetime = new AbortController();
  const delayMs = Math.max(1500, Math.min(15000, Number(api.config().batchDelayMs) || 4500));
  stop = queueIncomingStickers({ runtime, collect, enabled: collecting, delayMs,
    onError: () => runtime.publish('error', { source: 'sticker-library', message: '表情批量收藏暂不可用' }) });
}

export function deactivate() {
  stop?.();
  stop = undefined;
  lifetime.abort();
}
export const dispose = deactivate;
