// Separate process so that only the profile survives a simulated desktop restart.
import { createApp } from '../../src/app.js';
import { waitFor } from '../helpers/wait-for.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRoutes } from '../../src/routes.js';

const [kind, target, text, entry] = process.argv.slice(2);
const app = createApp({ standard: true, log() {} });
let result;
try {
  await app.onebot.connect();
  await waitFor(() => assert.ok(app.onebot.selfId));
  if (['archive-error', 'notify-error', 'account-switch'].includes(entry)) {
    await waitFor(() => assert.equal(app.store.activeAccount, app.onebot.selfId));
    if (entry === 'archive-error') {
      const temporaryFile = path.join(process.env.ALCOR_AGENT_DATA_DIR, 'messages',
        kind + '_' + target + '.json.' + process.pid + '.tmp');
      fs.mkdirSync(temporaryFile, { recursive: true });
    }
    const endpoint = '/api/chats/' + kind + '_' + target + '/test-send';
    const onebot = entry === 'account-switch' ? { connected: true, selfId: app.onebot.selfId,
      async sendText(...args) {
        const receipt = await app.onebot.sendText(...args);
        app.store.setAccount('10009');
        return receipt;
      } } : app.onebot;
    const routes = createRoutes({ onebot, store: app.store, readBody: async () => ({ text }),
      emit() { if (entry === 'notify-error') throw new Error('fixture UI notification failure'); } });
    const route = routes.find(row => row.method === 'POST' && row.pattern instanceof RegExp && row.pattern.test(endpoint));
    result = await route.handler({ match: route.pattern.exec(endpoint), json: (_res, status, body) => ({ status, body }) });
    result.inArchive = app.store.recent(kind + ':' + target).some(row => row.self && row.text === text);
  } else if (entry === 'queue') {
    await app.sender.sendTextBatch(kind + ':' + target, [text]);
  } else {
    await app.onebot.sendText(kind, target, text, { expected_self_id: app.onebot.selfId });
  }
  result ??= { ok: true };
} catch (error) {
  result = { ok: false, code: error.code, delivery: error.delivery, nonretryable: error.nonretryable, message: error.message };
} finally {
  app.onebot.close();
}
process.send(result, () => process.exit(0));
