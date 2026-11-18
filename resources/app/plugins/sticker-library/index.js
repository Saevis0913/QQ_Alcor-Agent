import { getBuiltinRuntime } from '../../src/builtin-runtime.js';
import { getConfig, personaForChat } from '../../src/config.js';
import { backfillStickerTags, collectNativeStickerBatch } from '../../src/native-stickers.js';
import { checkStickerScope, createStickerModel } from '../../src/builtins/sticker-model.js';
import { queueIncomingStickers } from '../../src/builtins/sticker-library.js';
import { isSkillEnabledInConfig } from '../../src/skills/config.js';

let api;
let stop;
let lifetime = new AbortController();
function overLimit() {
  const max = Number(getConfig().sticker?.maxEntries) || 0;
  if (max <= 0) return false;
  const runtime = getBuiltinRuntime();
  const count = Number(runtime?.stickers?.store?.count?.() ?? 0);
  return count >= max;
}

// 超过收藏上限就停止自动收藏（手动 collect_sticker 不受影响）。
const collecting = () => getConfig().sticker?.enabled !== false && getConfig().sticker?.collectEnabled === true &&
  isSkillEnabledInConfig('sticker-library') && !overLimit();

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

async function label(input) {
  const runtime = getBuiltinRuntime();
  if (!runtime) throw new Error('表情标签服务未就绪');
  const lifetimeSignal = lifetime.signal;
  const signal = input.signal ? AbortSignal.any([input.signal, lifetimeSignal]) : lifetimeSignal;
  const scope = { ...input, signal };
  checkStickerScope(runtime, scope);
  const classify = createStickerModel({ runtime, mode: 'labels' });
  return classify({ ...scope, persona: personaForChat(input.chatKey), preference: api.config().preference });
}

export const providers = { 'sticker.batch_collect': collect, 'sticker.label': label };

async function sweep() {
  const runtime = getBuiltinRuntime();
  if (!runtime || !collecting()) return;
  const selfId = String(runtime.onebot?.selfId ?? '');
  if (!/^[1-9]\d{0,9}$/.test(selfId)) return;
  const chatKeys = [...new Set((runtime.sessions?.index ?? []).map((row) => String(row.chatKey ?? ''))
    .filter((key) => /^(group|private):[1-9]\d{0,9}$/.test(key)))].slice(0, 20);
  for (const chatKey of chatKeys) {
    if (!collecting()) return;
    try {
      await backfillStickerTags({ selfId, chatKey, onebot: runtime.onebot, store: runtime.store,
        stickers: runtime.stickers, session: null, signal: lifetime.signal }, { max: 4 });
    } catch { /* 单会话失败不影响其它会话 */ }
  }
}

let sweepTimer;
let sweepKick;
export function activate() {
  const runtime = getBuiltinRuntime();
  if (!runtime || stop) return;
  if (lifetime.signal.aborted) lifetime = new AbortController();
  const delayMs = Math.max(1500, Math.min(15000, Number(api.config().batchDelayMs) || 4500));
  stop = queueIncomingStickers({ runtime, collect, enabled: collecting, delayMs,
    onError: () => runtime.publish('error', { source: 'sticker-library', message: '表情批量收藏暂不可用' }) });
  // 启动后 90 秒补一轮，此后每 2 小时扫一次「没有标签」的收藏（手动添加、旧数据都在这里补上）。
  sweepKick = setTimeout(() => { sweep().catch(() => {}); }, 90_000);
  sweepTimer = setInterval(() => { sweep().catch(() => {}); }, 2 * 60 * 60 * 1000);
}

export function deactivate() {
  stop?.();
  stop = undefined;
  clearTimeout(sweepKick);
  clearInterval(sweepTimer);
  lifetime.abort();
}
export const dispose = deactivate;
