import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../ui/app/03-alcor.js', import.meta.url), 'utf8');

function harness(status, box) {
  const calls = [];
  const stub = () => {
    const node = { value: '', type: 'password', textContent: '', checked: false, isConnected: true, disabled: false,
      scrollTop: 0, clientHeight: 0, scrollHeight: 0, innerHTML: '',
      addEventListener() {}, focus() {}, select() {}, remove() {}, append() {} };
    return node;
  };
  const context = {
    window: { addEventListener() {}, confirm: () => true },
    document: { addEventListener() {}, hidden: false, activeElement: null, createElement: stub, body: { append() {} } },
    navigator: { clipboard: { writeText: async () => {} } },
    esc: (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    state: { tab: 'alcor' },
    $: () => stub(),
    api: async (path) => {
      if (path === '/api/status') return status;
      if (path === '/api/alcor/logs') return { logs: [] };
      return {};
    },
    refreshStatus: async () => {},
    switchTab() {},
    CONSOLE_MARKER: ''
  };
  vm.runInNewContext(source, context);
  context.renderOneBotEdition = (...args) => calls.push(args);
  return { context, calls, box };
}

test('native install keeps the original Alcor frame page', async () => {
  const status = { edition: { standard: false, marker: false }, onebotEdition: null,
    alcor: { running: true, embedded: true, backendReady: true, dir: 'D:\\Alcor', webuiUrl: 'http://127.0.0.1:5310/panel/' },
    onebot: { connected: true } };
  const box = { id: 'alcor-page', innerHTML: '', querySelector: () => null };
  const { context, calls } = harness(status, box);
  context.$ = (selector) => (selector === '#alcor-page' ? box : { value: '', type: 'password', textContent: '', isConnected: true, disabled: false,
    addEventListener() {}, focus() {}, select() {}, remove() {}, append() {} });
  await context.loadAlcorPage({ quiet: true });
  assert.equal(calls.length, 0);
  assert.match(box.innerHTML, /Alcor 框架/);
  assert.doesNotMatch(box.innerHTML, /OneBot 连接/);
});

test('switched install renders the OneBot page', async () => {
  const status = { edition: { standard: true, marker: true }, onebotEdition: { httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001' }, alcor: {}, onebot: {} };
  const box = { id: 'alcor-page', innerHTML: '', querySelector: () => null };
  const { context, calls } = harness(status, box);
  context.$ = (selector) => (selector === '#alcor-page' ? box : { value: '', type: 'password', textContent: '', isConnected: true, disabled: false,
    addEventListener() {}, focus() {}, select() {}, remove() {}, append() {} });
  await context.loadAlcorPage({ quiet: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], status);
});
