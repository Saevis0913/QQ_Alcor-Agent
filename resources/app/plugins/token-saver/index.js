import { createTokenSaver } from '../../src/builtins/token-saver.js';
const saver = createTokenSaver();
export const hooks = { 'before-context': context => saver.context(context), 'after-response': context => saver.response(context), 'after-tool': context => saver.tool(context) };
export const providers = { 'reply.local-policy': request => saver.policy(request) };
export function deactivate() { saver.clear(); }
export function dispose() { saver.clear(); }
