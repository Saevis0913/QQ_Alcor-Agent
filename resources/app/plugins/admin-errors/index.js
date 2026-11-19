import { getBuiltinRuntime } from '../../src/builtin-runtime.js';
import { getConfig } from '../../src/config.js';
import { createAdminErrors } from '../../src/builtins/admin-errors.js';
import { isSkillEnabledInConfig } from '../../src/skills/config.js';

let api;
let service;
let bound;

export function setup(extensionApi) { api = extensionApi; }

export function activate() {
  const runtime = getBuiltinRuntime();
  if (!runtime || runtime === bound) return;
  deactivate();
  bound = runtime;
  service = createAdminErrors({
    runtime,
    isEnabled: () => getBuiltinRuntime() === runtime && isSkillEnabledInConfig('admin-errors') && runtime.isPaused?.() !== true,
    getAdmins: () => getConfig().privatePolicy?.adminQQs,
    getSettings: () => api.config()
  });
}

export function deactivate() {
  service?.close();
  bound = undefined;
  service = undefined;
}
export const dispose = deactivate;

export const hooks = {
  'after-tool': (context) => { service?.recordTool(context); }
};

export const providers = {
  async 'admin.error_digest'({ ctx, signal }) {
    if (!service) throw new Error('管理员异常汇总服务未就绪');
    return service.sendDigest(ctx, { signal });
  }
};
