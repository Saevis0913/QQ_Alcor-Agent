import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicyReport, evaluatePolicy, policyRemedies } from '../src/injection-policy.js';

function report(overrides = {}) {
  return {
    ok: true,
    self: { user: 'PC\\alice', sessionId: 1, elevated: true, ...(overrides.self || {}) },
    machine: {
      hvci: false, sac: 0, deviceGuardRunning: [],
      defender: { realtime: false, antivirus: false, runningMode: 'Normal', tamper: false },
      exclusions: [], asrIds: [], asrActions: [], antivirus: [],
      ...(overrides.machine || {})
    },
    process: overrides.process === null ? null : {
      pid: 100, sessionId: 1, name: 'QQ', path: 'C:/QQ/QQ.exe', owner: 'PC\\alice',
      mitigations: { blockDynamicCode: false, microsoftSignedOnly: false, auditMicrosoftSignedOnly: false,
        blockRemoteImageLoads: false, blockLowLabelImageLoads: false, disallowChildProcess: false, dep: true },
      ...(overrides.process || {})
    }
  };
}
const codes = (result) => result.findings.map((item) => item.code);

test('parse maps ON/OFF, 1/0 and booleans without guessing', () => {
  const parsed = parsePolicyReport(JSON.stringify({
    self: { user: 'PC\\a', sessionId: 2, elevated: false },
    machine: { hvci: 1, sac: 2, deviceGuardRunning: [2], defender: { realtime: true, antivirus: true, runningMode: 'Normal', tamper: 'True' }, exclusions: ['D:\\Alcor'], asrIds: ['x'], asrActions: [1], antivirus: [{ name: 'Defender', state: 1 }] },
    process: { pid: 7, sessionId: 2, name: 'QQ', path: 'C:/QQ/QQ.exe', owner: 'PC\\a', mitigations: { blockDynamicCode: 1, microsoftSignedOnly: 'ON', auditMicrosoftSignedOnly: 0, blockRemoteImageLoads: true, blockLowLabelImageLoads: 'OFF', disallowChildProcess: 1, dep: 'ON' } }
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.machine.hvci, true);
  assert.equal(parsed.machine.sac, 2);
  assert.equal(parsed.process.mitigations.blockDynamicCode, true);
  assert.equal(parsed.process.mitigations.microsoftSignedOnly, true);
  assert.equal(parsed.process.mitigations.blockLowLabelImageLoads, false);
  assert.equal(parsed.process.mitigations.dep, true);
});

test('empty or broken probe output is reported as an error, not as "all clear"', () => {
  assert.equal(parsePolicyReport('').ok, false);
  assert.equal(parsePolicyReport('not json').ok, false);
  const result = evaluatePolicy({ ok: false, error: 'POLICY_PROBE_INVALID' });
  assert.equal(result.ok, false);
  assert.equal(result.findings.length, 0);
});

test('smart app control enforcing blocks, evaluation only warns', () => {
  assert.match(codes(evaluatePolicy(report({ machine: { sac: 1 } }))).join(','), /POLICY_SAC_ENFORCING/);
  const evaluating = evaluatePolicy(report({ machine: { sac: 2 } }));
  assert.ok(codes(evaluating).includes('POLICY_SAC_EVALUATION'));
  assert.equal(evaluating.blocked, false);
});

test('HVCI is informational only', () => {
  const result = evaluatePolicy(report({ machine: { hvci: true, defender: { realtime: false } } }));
  const hvci = result.findings.find((item) => item.code === 'POLICY_HVCI_ON');
  assert.equal(hvci.level, 'info');
  assert.equal(result.blocked, false);
});

test('CIG is downgraded when this machine already injected successfully', () => {
  const cig = { microsoftSignedOnly: true };
  const unknown = evaluatePolicy(report({ process: { mitigations: { microsoftSignedOnly: true } } }));
  assert.equal(unknown.findings.find((item) => item.code === 'POLICY_QQ_CIG').level, 'warn');

  const loaded = evaluatePolicy(report({ process: { mitigations: { microsoftSignedOnly: true } } }), { memory: { cig: { lastOutcome: 'loaded' } } });
  assert.equal(loaded.findings.find((item) => item.code === 'POLICY_QQ_CIG').level, 'info');

  const blocked = evaluatePolicy(report({ process: { mitigations: { microsoftSignedOnly: true } } }), { memory: { cig: { lastOutcome: 'blocked' } } });
  assert.ok(codes(blocked).includes('POLICY_QQ_CIG_CONFIRMED_BLOCK'));
  assert.equal(blocked.blocked, true);
});

test('ACG blocks outright', () => {
  const result = evaluatePolicy(report({ process: { mitigations: { blockDynamicCode: true } } }));
  assert.ok(codes(result).includes('POLICY_QQ_ACG'));
  assert.equal(result.blocked, true);
});

test('remote staging path is a block, temp staging path is a warning', () => {
  const remote = evaluatePolicy(report({ process: { mitigations: { blockRemoteImageLoads: true } } }), { stagingPath: '\\\\server\\share\\host' });
  assert.equal(remote.blocked, true);
  const local = evaluatePolicy(report({ process: { mitigations: { blockRemoteImageLoads: true } } }), { stagingPath: 'C:/ProgramData/Alcor/host/abc' });
  assert.equal(local.blocked, false);
  const temp = evaluatePolicy(report({ process: { mitigations: { blockLowLabelImageLoads: true } } }), { stagingPath: 'C:/Users/x/AppData/Local/Temp/alcor' });
  assert.ok(codes(temp).includes('POLICY_QQ_BLOCK_LOW_LABEL'));
  assert.equal(temp.blocked, false);
});

test('user, session and elevation mismatches are classified separately', () => {
  const otherUser = evaluatePolicy(report({ process: { owner: 'PC\\bob' } }));
  assert.ok(codes(otherUser).includes('POLICY_USER_MISMATCH'));
  const otherSession = evaluatePolicy(report({ process: { sessionId: 3 } }));
  assert.ok(codes(otherSession).includes('POLICY_SESSION_MISMATCH'));
  const notAdmin = evaluatePolicy(report({ self: { elevated: false } }));
  const elevation = notAdmin.findings.find((item) => item.code === 'POLICY_ELEVATION_MISMATCH');
  assert.ok(['warn', 'block'].includes(elevation.level));
  assert.equal(notAdmin.blocked, false);
});

test('defender realtime without exclusion warns, and exclusion removes it', () => {
  const bare = evaluatePolicy(report({ machine: { defender: { realtime: true } } }), { installRoot: 'D:/Alcor', packRoot: 'C:/ProgramData/Alcor/host' });
  assert.equal(bare.findings.find((item) => item.code === 'POLICY_DEFENDER_REALTIME').canExclude, true);
  const covered = evaluatePolicy(report({ machine: { defender: { realtime: true }, exclusions: ['d:\\alcor', 'C:\\ProgramData\\Alcor\\host'] } }), { installRoot: 'D:/Alcor', packRoot: 'C:/ProgramData/Alcor/host' });
  assert.ok(!codes(covered).includes('POLICY_DEFENDER_REALTIME'));
});

test('ransomware ASR rule only warns when it is enabled', () => {
  const on = evaluatePolicy(report({ machine: { asrIds: ['c1db55ab-c21a-4637-bb3f-a12568109d35'], asrActions: [1] } }));
  assert.ok(codes(on).includes('POLICY_ASR_RANSOMWARE'));
  const off = evaluatePolicy(report({ machine: { asrIds: ['c1db55ab-c21a-4637-bb3f-a12568109d35'], asrActions: [0] } }));
  assert.ok(!codes(off).includes('POLICY_ASR_RANSOMWARE'));
});

test('onebot fallback is always offered and remedies follow the report', () => {
  const result = evaluatePolicy(report());
  assert.ok(codes(result).includes('POLICY_ONEBOT_FALLBACK'));
  const remedies = policyRemedies(report({ machine: { defender: { realtime: true } }, self: { elevated: false } })).map((item) => item.id);
  assert.deepEqual(remedies, ['defender-exclusion', 'relaunch-admin', 'onebot']);
});

test('a matching CodeIntegrity 3077 within the failure window is confirmed, not guessed', () => {
  const withEvent = report({});
  withEvent.events = { codeIntegrity: [{ time: '2026-11-22T04:00:00.000Z', id: 3077, message: 'Code Integrity determined that the image specified in the binary file C:\\ProgramData\\Alcor\\host\\abc\\alcor-host.dll is invalid' }], defender: [] };
  const result = evaluatePolicy(withEvent, { lastFailure: { at: '2026-11-22T04:05:00.000Z', code: 'HOST_LOAD_BLOCKED', stage: 'load_library' } });
  const finding = result.findings.find((item) => item.code === 'POLICY_CODE_INTEGRITY_BLOCK');
  assert.ok(finding);
  assert.equal(finding.level, 'block');
  assert.equal(result.blocked, true);
});

test('an unrelated 3077 leaves the cause unconfirmed', () => {
  const withEvent = report({});
  withEvent.events = { codeIntegrity: [{ time: '2026-11-22T04:00:00.000Z', id: 3077, message: 'image C:\\Windows\\System32\\other.sys is invalid' }], defender: [] };
  const result = evaluatePolicy(withEvent, { lastFailure: { at: '2026-11-22T04:05:00.000Z', code: 'HOST_LOAD_BLOCKED', stage: 'load_library' } });
  assert.ok(!result.findings.some((item) => item.code === 'POLICY_CODE_INTEGRITY_BLOCK'));
  const unconfirmed = result.findings.find((item) => item.code === 'POLICY_EVIDENCE_UNCONFIRMED');
  assert.ok(unconfirmed);
  assert.match(unconfirmed.detail, /HOST_LOAD_BLOCKED/);
  assert.equal(result.blocked, false);
});

test('a 3077 outside the window does not confirm the current failure', () => {
  const withEvent = report({});
  withEvent.events = { codeIntegrity: [{ time: '2026-11-21T04:00:00.000Z', id: 3077, message: 'alcor-host.dll is invalid' }], defender: [] };
  const result = evaluatePolicy(withEvent, { lastFailure: { at: '2026-11-22T04:05:00.000Z', code: 'HOST_LOAD_BLOCKED' } });
  assert.ok(!result.findings.some((item) => item.code === 'POLICY_CODE_INTEGRITY_BLOCK'));
  assert.ok(result.findings.some((item) => item.code === 'POLICY_EVIDENCE_UNCONFIRMED'));
});

test('defender 1116 on a host file is a quarantine finding and an audit 3076 stays informational', () => {
  const withEvents = report({});
  withEvents.events = {
    codeIntegrity: [{ time: '2026-11-22T04:00:00.000Z', id: 3076, message: 'would have blocked qq-host-loader.exe' }],
    defender: [{ time: '2026-11-22T04:00:00.000Z', id: 1116, message: 'Detected Trojan:Win32/Wacatac.B!ml in file alcor-host.dll' }]
  };
  const result = evaluatePolicy(withEvents, { lastFailure: { at: '2026-11-22T04:02:00.000Z', code: 'HOST_ARTIFACT_INVALID' } });
  const quarantine = result.findings.find((item) => item.code === 'POLICY_AV_QUARANTINE');
  assert.equal(quarantine.level, 'block');
  assert.equal(result.findings.find((item) => item.code === 'POLICY_CODE_INTEGRITY_AUDIT').level, 'info');
});

test('a modified host artifact is reported as a hash mismatch', () => {
  const result = evaluatePolicy(report({}), { artifacts: [{ name: 'alcor-host.dll', sha256: 'aa', expectedSha256: 'bb' }] });
  const mismatch = result.findings.find((item) => item.code === 'POLICY_ARTIFACT_HASH_MISMATCH');
  assert.ok(mismatch);
  assert.equal(result.blocked, true);
});
