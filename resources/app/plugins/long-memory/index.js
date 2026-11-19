import { getBuiltinRuntime } from '../../src/builtin-runtime.js';
import { createLongMemory } from '../../src/builtins/memory-long.js';
import { startArchiveWorker } from '../../src/builtins/memory-style.js';

const id = 'long-memory';
let api;
let memory;
let stop;

export function setup(skillApi) {
  api = skillApi;
}

export function available() {
  return getBuiltinRuntime() ? true : { ok: false, reason: '长期记忆运行时尚未连接。' };
}

export function activate() {
  if (stop) return;
  const runtime = getBuiltinRuntime();
  if (!runtime) return;
  const enabled = () => getBuiltinRuntime() === runtime && api.isSkillActive(id) && runtime.isPaused?.() !== true;
  memory = createLongMemory({ runtime, settings: api.config, enabled, warn: error => api.warn(error.message) });
  stop = startArchiveWorker({
    runtime, tick: memory.tick, enabled, everyMs: 15 * 60_000, report: error => api.warn(error.message)
  });
}

export function deactivate() {
  stop?.();
  stop = undefined;
  memory = undefined;
}

function access(action, { ctx, args }) {
  try {
    if (!memory) throw new Error('长期记忆未启动。');
    return { content: JSON.stringify(memory[action](ctx, args)), isError: false };
  } catch (error) {
    return { content: error.message, isError: true };
  }
}

export const providers = {
  'memory.lookup': request => access('lookup', request),
  'memory.change': request => access('change', request)
};

export const hooks = {
  'before-llm-messages': context => memory?.annotate(context)
};
