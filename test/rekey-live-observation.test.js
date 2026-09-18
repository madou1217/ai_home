'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { fixture } = require('./helpers/rekey-fixture');
const { recoverMaintenance } = require('../lib/cli/services/account/oauth-identity-maintenance');
const { isUnrelatedLiveObservation } = require('../lib/cli/services/account/rekey-live-observation-policy');

function activity(f, value) {
  const file = path.join(f.root, 'run/account-activity.json');
  fs.writeFileSync(file, JSON.stringify(value)); return file;
}

function unrelatedLog(f) {
  const file = path.join(f.root, 'run/chat-harness/acct_99999999999999999999/.codex/logs_2.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE logs(id INTEGER PRIMARY KEY,feedback_log_body TEXT)');
  db.prepare('INSERT INTO logs VALUES(1,?)').run('initial diagnostic'); db.close();
  return file;
}

test('unrelated liveness observations may advance but are never overwritten by forward or rollback', t => {
  const f = fixture(t), file = activity(f, { updatedAt: 1, accounts: {} });
  const before = f.plan();
  const newer = JSON.stringify({ updatedAt: 2, accounts: { acct_99999999999999999999: { seenAt: 2 } } });
  fs.writeFileSync(file, newer);
  assert.equal(f.plan().digest, before.digest);
  const result = f.apply(before);
  assert.equal(fs.readFileSync(file, 'utf8'), newer);
  recoverMaintenance(f.root, result.id, { rollback: true, leaseOptions: { assertQuiet() {} } });
  assert.equal(fs.readFileSync(file, 'utf8'), newer);
  assert.equal(f.plan().digest, before.digest);
});

test('hook observation schema is explicit and an old, new or escaped target ref removes the exemption', t => {
  const f = fixture(t), mapping = new Map(f.plan().mapping), next = mapping.get(f.ref);
  const value = { version: 1, enabled: true, updatedAt: '2026-09-17T00:00:00Z', targetBinaryPath: '/fixture/bin/codex', upstreamBinaryPath: '/fixture/original', reason: 'healthy' };
  const relative = 'run/codex/cli-hook-state.json';
  assert.equal(isUnrelatedLiveObservation(relative, JSON.stringify(value), mapping), true);
  for (const ref of [f.ref, next]) {
    assert.equal(isUnrelatedLiveObservation(relative, JSON.stringify({ ...value, reason: ref }), mapping), false);
    const escaped = JSON.stringify({ ...value, reason: ref }).replace(ref, ref.replace('_', '\\u005f'));
    assert.equal(isUnrelatedLiveObservation(relative, escaped, mapping), false);
  }
  assert.equal(isUnrelatedLiveObservation(relative, JSON.stringify({ ...value, futureConfig: 'unknown' }), mapping), false);
  assert.equal(isUnrelatedLiveObservation('run/another-state.json', JSON.stringify(value), mapping), false);
});

test('activity containing an affected identity, metadata changes and arbitrary files remain strict', t => {
  const f = fixture(t), file = activity(f, { updatedAt: 1, accounts: { [f.ref]: { seenAt: 1 } } });
  const before = f.plan();
  activity(f, { updatedAt: 2, accounts: { [f.ref]: { seenAt: 2 } } });
  assert.throws(() => f.apply(before), /plan_stale/);
  activity(f, { updatedAt: 2, accounts: {} });
  const noRefs = f.plan(); fs.chmodSync(file, 0o600);
  assert.notEqual(f.plan().digest, noRefs.digest);
  const unrelated = path.join(f.root, 'run/future-config.json'); fs.writeFileSync(unrelated, '{"config":1}');
  const original = f.plan(); fs.writeFileSync(unrelated, '{"config":2}');
  assert.throws(() => f.apply(original), /plan_stale/);
});

test('another account native log may append historical text without preventing a target migration', t => {
  const f = fixture(t), file = unrelatedLog(f), before = f.plan();
  const db = new DatabaseSync(file); db.prepare('INSERT INTO logs VALUES(2,?)').run(`past diagnostic mentioning ${f.ref}`); db.close();
  assert.equal(f.plan().digest, before.digest);
  const result = f.apply(before);
  recoverMaintenance(f.root, result.id, { rollback: true, leaseOptions: { assertQuiet() {} } });
  const current = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(current.prepare('SELECT COUNT(*) n FROM logs').get().n, 2); } finally { current.close(); }
});

test('unknown native log fields and schema changes are not hidden by diagnostic volatility', t => {
  const f = fixture(t), file = unrelatedLog(f), before = f.plan();
  const db = new DatabaseSync(file); db.exec('ALTER TABLE logs ADD COLUMN future_address TEXT');
  db.prepare('UPDATE logs SET future_address=?').run('/runtime/'+f.ref); db.close();
  const after = f.plan();
  assert.notEqual(after.digest, before.digest);
  assert.ok(after.blockers.some(item => item.reason === 'native_reference_unclassified'));
});

test('a diagnostic database inside the migrated account root still has full state protection', t => {
  const f = fixture(t), file = path.join(f.runtime, '.codex/logs_2.sqlite');
  const db = new DatabaseSync(file); db.exec('CREATE TABLE logs(id INTEGER PRIMARY KEY,feedback_log_body TEXT)'); db.close();
  const before = f.plan();
  const writer = new DatabaseSync(file); writer.exec("INSERT INTO logs VALUES(1,'new target-account write')"); writer.close();
  assert.throws(() => f.apply(before), /plan_stale/);
});

test('durable journals without a policy version keep their original strict verification', t => {
  const f = fixture(t), file = activity(f, { updatedAt: 1, accounts: {} });
  const { buildFilesystemPlan } = require('../lib/cli/services/account/codex-rekey-inventory');
  const { assertFilesystemState } = require('../lib/cli/services/account/rekey-consistency');
  const current = f.plan();
  const oldFilesystem = buildFilesystemPlan(fs, f.root, '', new Map(current.mapping), { observationPolicy: 0 });
  assert.equal(Object.hasOwn(oldFilesystem, 'observationPolicy'), false);
  const legacy = { ...current, filesystem: oldFilesystem };
  assert.doesNotThrow(() => assertFilesystemState(f.root, legacy, oldFilesystem.fingerprint));
  fs.writeFileSync(file, JSON.stringify({ updatedAt: 2, accounts: {} }));
  assert.throws(() => assertFilesystemState(f.root, legacy, oldFilesystem.fingerprint), /filesystem_state_mismatch/);
  assert.doesNotThrow(() => assertFilesystemState(f.root, current, current.filesystem.fingerprint));
  assert.throws(() => buildFilesystemPlan(fs, f.root, '', new Map(current.mapping), { observationPolicy: 2 }), /policy_unsupported/);
});
