import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePolicyReport, evaluatePolicy } from '../src/injection-policy.js';

const report = (antivirus) => JSON.stringify({
  self: { user: 'x', elevated: true, sessionId: 1 },
  machine: { hvci: 0, sac: 0, deviceGuardRunning: [], exclusions: [], asrIds: [], asrActions: [],
    defender: { realtime: false, antivirus: false, runningMode: 'Normal', tamper: false }, antivirus },
  process: null,
  events: { codeIntegrity: [], defender: [] }
});

test('a Security Center entry whose path is gone is marked stale, not installed', () => {
  const parsed = parsePolicyReport(report([{ name: 'Kingsoft Antivirus', state: 331776, exe: 'C:\\nope\\kxetray.exe', present: false }]));
  assert.equal(parsed.ok, true);
  const row = parsed.machine.antivirus[0];
  assert.equal(row.present, false);
  assert.equal(row.stale, true);
  assert.equal(row.active, false);
});

test('a live product is active only when its state says running', () => {
  const parsed = parsePolicyReport(report([{ name: 'Live', state: 0x41010, exe: 'C:\\av\\av.exe', present: true }]));
  assert.equal(parsed.machine.antivirus[0].active, true);
  assert.equal(parsed.machine.antivirus[0].stale, false);
});

test('stale registrations are reported as leftover entries', () => {
  const parsed = parsePolicyReport(report([{ name: 'Kingsoft Antivirus', state: 331776, exe: 'C:\\nope\\kxetray.exe', present: false }]));
  const policy = evaluatePolicy(parsed, {});
  const finding = policy.findings.find((item) => item.code === 'POLICY_AV_STALE_REGISTRATION');
  assert.ok(finding);
  assert.equal(finding.level, 'info');
  assert.match(finding.detail, /Kingsoft/);
  assert.equal(policy.blocked, false);
});
