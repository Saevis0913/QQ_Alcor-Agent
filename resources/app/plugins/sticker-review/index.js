import { getBuiltinRuntime } from '../../src/builtin-runtime.js';
import { createStickerModel } from '../../src/builtins/sticker-model.js';

let lifetime = new AbortController();

export function activate() {
  if (lifetime.signal.aborted) lifetime = new AbortController();
}

export function deactivate() {
  lifetime.abort();
}
export const dispose = deactivate;

export const providers = {
  async 'sticker.review'(input) {
    const runtime = getBuiltinRuntime();
    if (!runtime) throw new Error('表情审核服务未就绪');
    const lifetimeSignal = lifetime.signal;
    const signal = input.signal ? AbortSignal.any([lifetimeSignal, input.signal]) : lifetimeSignal;
    return createStickerModel({ runtime, mode: 'review' })({ ...input, signal });
  }
};
