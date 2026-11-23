import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const install = process.env.ALCOR_TEST_INSTALL_ROOT;
const installed = relative => import(pathToFileURL(path.join(install, relative)).href);

test('installed desktop receives private/group events and preserves an explicitly unconfirmed send',
  { skip: !install || process.platform !== 'win32', timeout: 45_000 }, async t => {
    const [{ createBridge }, { NativeBackend }, { BridgeError }] = await Promise.all([
      installed('resources/alcor/src/server.mjs'), installed('resources/alcor/src/native-backend.mjs'),
      installed('resources/alcor/src/backend.mjs')
    ]);
    const parent = await fs.realpath(os.tmpdir());
    const profile = await fs.mkdtemp(path.join(parent, 'alcor-desktop-message-'));
    const token = randomBytes(24).toString('hex');
    const self = 10001, sender = 10002, group = 10003;
    const sends = [];
    const status = { type: 'native', connected: true, receiveReady: true, ws: 'open', http: 'reachable',
      qqOnline: false, identitySource: 'memory', accountLastFour: '0001', serviceBound: false, events: 0, lastReceivedAt: null };
    const ok = data => ({ status: 'ok', retcode: 0, data });
    let publish;
    let identified = false;
    t.mock.method(NativeBackend.prototype, 'start', callback => { publish = callback; });
    t.mock.method(NativeBackend.prototype, 'close', async () => {});
    t.mock.method(NativeBackend.prototype, 'connect', async () => assert.fail('A desktop connection was requested during a fixture test'));
    t.mock.method(NativeBackend.prototype, 'snapshot', () => ({ ...status }));
    t.mock.method(NativeBackend.prototype, 'call', async (action, params) => {
      if (action === 'get_status') return ok({ online: status.qqOnline, native: { ...status } });
      if (action === 'get_login_info') { identified = true; return ok({ user_id: self, nickname: 'fixture' }); }
      if (action === 'get_version_info') return ok({ app_name: 'fixture' });
      if (action.startsWith('get_')) return ok([]);
      if (action === 'send_private_msg' || action === 'send_group_msg') {
        sends.push(params.message);
        if (sends.length === 1) throw new BridgeError('NATIVE_SEND_UNCONFIRMED', 502, 'unknown');
        return ok({ message_id: 7000 + sends.length });
      }
      throw new BridgeError('UNSUPPORTED_FIXTURE_ACTION', 400);
    });
    const config = { listen: { host: '127.0.0.1', port: 0, token }, backend: { type: 'native' }, readOnly: false };
    const bridge = createBridge(config);
    let child, exited;
    try {
      const { httpUrl } = await bridge.listen();
      config.listen.port = Number(new URL(httpUrl).port);
      const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
      const call = (action, params = {}) => fetch(httpUrl + '/' + action, {
        method: 'POST', headers, body: JSON.stringify(params), signal: AbortSignal.timeout(3500)
      });
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1');
      await once(probe, 'listening');
      const port = probe.address().port;
      await new Promise(resolve => probe.close(resolve));
      await fs.writeFile(path.join(profile, 'alcor.config.json'), JSON.stringify(config));
      await fs.writeFile(path.join(profile, 'config.json'), JSON.stringify({
        server: { port, startPaused: true, autoStart: false }, alcor: { autoLaunch: false },
        api: { apiKey: '', model: '', baseUrl: '' }, allow: { private: [], groups: [] }, allowAllWhenEmpty: false,
        ui: { installGuideSeen: true, alcorAccessGuideSeen: true, injectionCheckSeen: true }
      }));
      const env = { ...process.env, ALCOR_AGENT_DATA_DIR: profile, ALCOR_AGENT_HIDDEN_TEST: '1',
        ALCOR_PROFILE_PACK_DIR: path.join(profile, 'pack') };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      child = spawn(path.join(install, 'Alcor Agent.exe'), [], { cwd: install, windowsHide: true, stdio: 'ignore', env });
      exited = once(child, 'exit');
      await t.waitFor(() => assert.ok(identified && bridge.status().clients > 0), { timeout: 20_000, interval: 20 });
      const initial = (await (await call('get_bridge_info')).json()).data;
      assert.equal(initial.accountLastFour, '0001');
      assert.deepEqual([initial.bridge.backend.serviceBound, initial.bridge.backend.events, initial.bridge.ready], [false, 0, false]);
      const uncertain = await call('send_private_msg', { user_id: sender, message: 'unconfirmed fixture' });
      assert.equal(uncertain.status, 502);
      const failed = await uncertain.json();
      assert.deepEqual([failed.wording, failed.delivery], ['NATIVE_SEND_UNCONFIRMED', 'unknown']);
      assert.deepEqual([bridge.status().ready, bridge.status().backend.events], [false, 0]);
      for (const [index, type] of ['private', 'group'].entries()) {
        const text = type + ' inbound fixture';
        status.events++;
        status.lastReceivedAt = new Date().toISOString();
        status.qqOnline = true;
        publish({ post_type: 'message', message_type: type, self_id: self, user_id: sender,
          ...(type === 'group' && { group_id: group }), message_id: 8001 + index,
          time: Math.floor(Date.now() / 1000), sender: { user_id: sender }, raw_message: text,
          message: [{ type: 'text', data: { text } }] });
        const resp = await call('send_' + type + '_msg', { [type === 'group' ? 'group_id' : 'user_id']: type === 'group' ? group : sender,
          message: type + ' outbound fixture' });
        assert.equal(resp.status, 200);
        assert.equal((await resp.json()).data.message_id, 7002 + index);
      }
      assert.deepEqual(sends, ['unconfirmed fixture', 'private outbound fixture', 'group outbound fixture']);
      assert.deepEqual([bridge.status().backend.serviceBound, bridge.status().backend.events], [false, 2]);
      await t.waitFor(async () => {
        const inbox = JSON.parse(await fs.readFile(path.join(profile, 'inbox.json'), 'utf8'));
        assert.deepEqual(inbox.messages.map(m => [m.chatKey, m.mid, m.text]).sort(), [
          ['group:' + group, 8002, 'group inbound fixture'], ['private:' + sender, 8001, 'private inbound fixture']
        ]);
      }, { timeout: 5000, interval: 30 });
      const [code] = await exited;
      assert.equal(code, 0);
      const ui = JSON.parse(await fs.readFile(path.join(profile, 'electron-verification.json'), 'utf8'));
      assert.deepEqual([ui.port, ui.paused, ui.coreOwned, ui.visible], [port, true, false, false]);
      assert.equal(path.resolve(ui.dataDir), profile);
      t.diagnostic('Installed Electron inbox: private 1, group 1. Core sends: 1 explicitly unknown, 2 confirmed. No repeated dispatch.');
    } finally {
      if (child?.pid && child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
      await bridge.close();
      assert.equal(path.dirname(await fs.realpath(profile)), parent);
      await fs.rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
    }
  });
