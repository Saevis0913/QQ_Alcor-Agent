import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnoseQQ } from '../src/qq-diagnosis.js';

const knownQQ = { pid: 2868, path: 'C:\\QQandAlcor\\QQ\\QQ.exe', supported: true, alcorHostLoaded: true,
  foreignModules: [], version: '9.9.37-54395', startedAt: new Date(Date.now() - 12 * 60000).toISOString() };

const connection = (serviceAdopt) => ({ connected: true, pid: 2868, accountLastFour: '4497', identitySource: 'memory',
  serviceBound: false, receiveReady: false, events: 0, serviceAdopt });

test('two zero-hit scans become "QQ never created the service object"', () => {
  const result = diagnoseQQ({ running: true, processes: [knownQQ], backendReady: false,
    connection: connection({ attempts: 2, found: 0, lastCode: 'SERVICE_OBJECT_MISSING', lastHits: 0, lastMillis: 157,
      neverCreatedAt: new Date().toISOString() }) });
  assert.equal(result.code, 'SERVICE_NEVER_CREATED');
  assert.match(result.detail, /12 分钟/);
  assert.match(result.detail, /命中 0 次/);
  assert.match(result.hint, /OneBot/);
  assert.match(result.hint, /采集证据/);
});

test('a single zero-hit scan stays on the retrying verdict', () => {
  const result = diagnoseQQ({ running: true, processes: [knownQQ], backendReady: false,
    connection: connection({ attempts: 1, found: 0, lastCode: 'SERVICE_OBJECT_MISSING', lastHits: 0, lastMillis: 157 }) });
  assert.equal(result.code, 'IDENTITY_SERVICE_UNBOUND');
  assert.match(result.detail, /serviceBound=false/);
});

test('a scan that found an object but could not write it is not called never-created', () => {
  const result = diagnoseQQ({ running: true, processes: [knownQQ], backendReady: false,
    connection: connection({ attempts: 2, found: 0, lastCode: 'SERVICE_ADOPT_WRITE_FAILED', lastHits: 2 }) });
  assert.equal(result.code, 'IDENTITY_SERVICE_UNBOUND');
  assert.doesNotMatch(result.detail, /扫不到/);
});
