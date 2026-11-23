import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { waitFor } from './helpers/wait-for.mjs';

const root = process.env.ALCOR_TEST_STANDARD_DESKTOP_ROOT;
test('installed desktop archives confirmed messages and labels a gateway failure as unknown',
  { skip: !root || process.platform !== 'win32', timeout: 30_000 }, async () => {
    await fs.access(path.join(root, 'resources/app/onebot-edition.json'));
    const tmp = await fs.realpath(os.tmpdir());
    const profile = await fs.mkdtemp(path.join(tmp, 'alcor-desktop-receipt-'));
    const self = 10001, peerId = 10002;
    const seen = [];
    const backend = http.createServer(async (req, res) => {
      let text = '';
      for await (const chunk of req) text += chunk;
      const action = req.url.split('?')[0];
      if (action === '/send_private_msg') {
        seen.push(JSON.parse(text).message[0].data.text);
        if (seen.length === 2) { res.writeHead(502); res.end('Bad Gateway'); return; }
      }
      const data = action === '/get_login_info' ? { user_id: self, nickname: 'fixture' }
        : action === '/send_private_msg' ? { message_id: -77 } : action === '/get_status' ? { online: true } : [];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    });
    const ws = new WebSocketServer({ server: backend });
    let child, exited;
    try {
      backend.listen(0, '127.0.0.1');
      await once(backend, 'listening');
      const upstream = backend.address().port;
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1');
      await once(probe, 'listening');
      const port = probe.address().port;
      await new Promise(resolve => probe.close(resolve));
      await fs.writeFile(path.join(profile, 'config.json'), JSON.stringify({
        server: { port, token: 'test-agent-token', startPaused: true, autoStart: false },
        alcor: { wsUrl: 'ws://127.0.0.1:' + upstream, httpUrl: 'http://127.0.0.1:' + upstream, autoLaunch: false },
        allow: { private: [String(peerId)] }, api: { apiKey: '' }
      }));
      const env = { ...process.env, ALCOR_AGENT_DATA_DIR: profile, ALCOR_AGENT_HIDDEN_TEST: '1' };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      child = spawn(path.join(root, 'Alcor Agent.exe'), [], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
      exited = once(child, 'exit');
      const base = 'http://127.0.0.1:' + port;
      const api = async (url, body) => {
        const res = await fetch(base + url, { method: body ? 'POST' : 'GET',
          headers: { 'content-type': 'application/json', 'x-console-token': 'test-agent-token' },
          body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(1500) });
        return { status: res.status, body: await res.json() };
      };
      await waitFor(async () => {
        assert.equal((await api('/api/status')).body.onebot?.self?.userId, String(self));
      }, { interval: 20, timeout: 15_000 });
      const chat = '/api/chats/private_' + peerId;
      const send = text => api(chat + '/test-send', { text });
      const peer = [...ws.clients][0];
      peer.send(JSON.stringify({ post_type: 'message', message_type: 'private', self_id: self, user_id: peerId,
        sender: { user_id: peerId }, message_id: 77, time: Math.floor(Date.now() / 1000), raw_message: 'incoming-marker',
        message: [{ type: 'text', data: { text: 'incoming-marker' } }] }));
      assert.deepEqual(await send('confirmed-marker'), { status: 200, body: { ok: true, messageId: -77 } });
      const unknown = await send('uncertain-marker');
      assert.equal(unknown.status, 502);
      assert.equal(unknown.body.delivery, 'unknown');
      assert.equal(unknown.body.nonretryable, true);
      assert.match(unknown.body.error, /核对/);
      assert.deepEqual(seen, ['confirmed-marker', 'uncertain-marker']);
      await waitFor(async () => {
        const response = await api(chat + '/messages');
        assert.equal(response.status, 200);
        const rows = response.body.messages;
        assert.deepEqual(rows.map(m => [m.text, m.mid]).sort(), [['confirmed-marker', -77], ['incoming-marker', 77]]);
      }, { interval: 15, timeout: 2000 });
      const [code] = await exited;
      assert.equal(code, 0);
      const ui = JSON.parse(await fs.readFile(path.join(profile, 'electron-verification.json'), 'utf8'));
      assert.equal(ui.dataDir, profile);
      assert.deepEqual([ui.port, ui.coreOwned, ui.paused, ui.visible], [port, false, true, false]);
    } finally {
      if (child?.pid && child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
      for (const socket of ws.clients) socket.terminate();
      ws.close();
      backend.closeAllConnections();
      await new Promise(resolve => backend.close(resolve));
      assert.equal(path.dirname(await fs.realpath(profile)), tmp);
      await fs.rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
    }
  });
