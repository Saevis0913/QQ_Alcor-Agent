import { getBuiltinRuntime } from '../../src/builtin-runtime.js';
import { startArchiveWorker } from '../../src/builtins/memory-style.js';
import { createGroupStyle } from '../../src/builtins/group-style-learning.js';
import { defaultTrendSource, fetchTrends, trendAccessError } from '../../src/builtins/group-style-trends.js';

const id = 'group-style';
let api;
let style;
let stop;

export function setup(skillApi) {
  api = skillApi;
}

export function available() {
  return getBuiltinRuntime() ? true : { ok: false, reason: '群聊风格运行时尚未连接。' };
}

export function activate() {
  if (stop) return;
  const runtime = getBuiltinRuntime();
  if (!runtime) return;
  const enabled = () => getBuiltinRuntime() === runtime && api.isSkillActive(id) && runtime.isPaused?.() !== true;
  const report = error => api.warn(error.message);
  const settings = () => {
    const options = api.config();
    const { trendSource = defaultTrendSource } = options;
    return { ...options, trendSource, publicTrends: options.publicTrends !== false && !trendAccessError(trendSource) };
  };
  const readTrends = (signal, source) => fetchTrends(api.fetch, signal, source, () => {
    const options = settings();
    return options.publicTrends && options.trendSource === source;
  });
  style = createGroupStyle({
    runtime, settings, enabled, trends: readTrends,
    warn: report
  });
  stop = startArchiveWorker({ runtime, tick: style.tick, enabled, report });
}

export function deactivate() {
  stop?.();
  stop = undefined;
  style = undefined;
}

export function promptSections(context) {
  return style?.sections(context) ?? [];
}

export const hooks = {
  'before-llm-messages': context => style?.annotateTrends(context)
};
