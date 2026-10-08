'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { AIH_ZCODE_USAGE_OWNER_LOG_ENV, patchZcodeUsageSource, installZcodeUsageOwnerRecorder } = require('../lib/runtime/zcode-usage-attribution-hook');

const REF = 'acct_0123456789abcdef0123';
const USAGE = { id: 'usage_one', sessionID: 'session_one', startedAt: 1_790_000_000_000, completedAt: 1_790_000_000_100,
  rawUsage: { token: 'never-persist-provider-payload' }, prompt: 'never-persist-prompt' };

test('the named native persistence decorator preserves return/this/arguments and records only successful commits', async () => {
  const source = 'function named(){};async function min(a,b){if(a.fail)throw new Error("native_failed");return this.result};'
    + 'named(min,"recordModelUsage");module.exports=min;';
  const writes = [];
  const moduleObj = { exports: {} };
  const context = { module: moduleObj, globalThis: { __aihRecordZcodeUsageOwner: usage => writes.push(usage) } };
  const patched = patchZcodeUsageSource(source);
  vm.runInNewContext(patched, context);
  assert.equal(await moduleObj.exports.call({ result: 'native_result' }, {}, USAGE), 'native_result');
  assert.deepEqual(writes, [USAGE]);
  await assert.rejects(moduleObj.exports({ fail: true }, USAGE), /native_failed/);
  assert.equal(writes.length, 1);
  assert.equal(patchZcodeUsageSource(patched), patched, 'decoration must be idempotent');
  assert.throws(() => patchZcodeUsageSource('function unrelated(){}'), /marker_unavailable/);
});

test('the owner recorder persists metadata only and reports I/O failure once without breaking native usage', () => {
  let data;
  const object = {};
  const fsImpl = { mkdirSync() {}, appendFileSync(_file, text) { data = JSON.parse(text); } };
  assert.ok(installZcodeUsageOwnerRecorder({ accountRef: REF, logPath: '/private/profile/owners.jsonl', fs: fsImpl, globalObject: object }));
  object.__aihRecordZcodeUsageOwner(USAGE);
  assert.deepEqual(data, { version: 1, accountRef: REF, usageId: USAGE.id, sessionId: USAGE.sessionID,
    startedAtMs: USAGE.startedAt, timestampMs: USAGE.completedAt });
  const good = data;
  object.__aihRecordZcodeUsageOwner({ startedAt: USAGE.startedAt });
  assert.equal(data, good);
  const warnings = [];
  installZcodeUsageOwnerRecorder({ accountRef: REF, logPath: '/private/profile/owners.jsonl', fs: {
    mkdirSync() { throw new Error('disk_unavailable'); }
  }, globalObject: object, warn: warning => warnings.push(warning) });
  object.__aihRecordZcodeUsageOwner(USAGE);
  object.__aihRecordZcodeUsageOwner(USAGE);
  assert.deepEqual(warnings, ['zcode_usage_owner_write_failed']);
});

test('the actual agent runner captures a native committed usage ID without modifying the installed entry', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-usage-hook-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'agent.cjs');
  const logPath = path.join(root, 'private', 'owners.jsonl');
  const source = 'function named(){};function scope(e){if(e)return e}named(scope,"normalizeModelSessionIdForAttribution");'
    + 'async function persist(db,usage){process.stdout.write("NATIVE_OK")};named(persist,"recordModelUsage");'
    + `persist({},${JSON.stringify(USAGE)});`;
  fs.writeFileSync(entry, source);
  const result = spawnSync(process.execPath, [require.resolve('../lib/runtime/zcode-session-attribution-runner'), entry], {
    encoding: 'utf8', env: { ...process.env, AIH_ZCODE_SESSION_ATTRIBUTION_SCOPE: REF, [AIH_ZCODE_USAGE_OWNER_LOG_ENV]: logPath }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'NATIVE_OK');
  const record = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  assert.equal(record.accountRef, REF);
  assert.equal(record.usageId, USAGE.id);
  assert.equal(fs.readFileSync(entry, 'utf8'), source);
  assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
});
