'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { fixture } = require('./helpers/rekey-fixture');
const { applyMaintenancePlan, recoverMaintenance } = require('../lib/cli/services/account/oauth-identity-maintenance');
const { nativeFingerprint } = require('../lib/cli/services/account/rekey-native-policy');
const { maintenanceGatePath } = require('../lib/runtime/account-maintenance-gate');
const { readDefaultAccountRef } = require('../lib/account/default-account-store');
const { classifyDatabaseText } = require('../lib/cli/services/account/codex-rekey-reference-policy');

const service = path.resolve(__dirname, '../lib/cli/services/account/oauth-identity-maintenance');

function addNative(f, mode = 'DELETE') {
  const databases = [path.join(f.runtime, '.codex/state_5.sqlite'), path.join(f.root, 'run/chat-harness', f.ref, '.codex/state_5.sqlite')];
  const fingerprints = [];
  databases.forEach((file, index) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA journal_mode=${mode}; CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,first_user_message TEXT,n INTEGER,b BLOB);
      CREATE TABLE _sqlx_migrations(version INTEGER PRIMARY KEY,description TEXT);
      INSERT INTO _sqlx_migrations VALUES(7,'vendor-owned'); PRAGMA user_version=31`);
    const pointer = path.join(f.runtime, '.codex/sessions/must-not-change.jsonl');
    db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run(`thread-${index}`, pointer, `history ${f.ref}`, 9223372036854775807n, Buffer.from([0, 255, 17]));
    fingerprints.push(nativeFingerprint(db).digest); db.close();
  });
  const logs = new DatabaseSync(path.join(f.runtime, '.codex/logs_2.sqlite'));
  logs.exec('CREATE TABLE logs(id INTEGER PRIMARY KEY AUTOINCREMENT,feedback_log_body TEXT)');
  logs.prepare('INSERT INTO logs(feedback_log_body) VALUES(?)').run(`failure at ${f.ref}`); logs.close();
  return { databases, fingerprints };
}

function readNative(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const statement = db.prepare('SELECT * FROM threads'); statement.setReadBigInts(true);
    return { row: statement.get(), fingerprint: nativeFingerprint(db).digest, version: db.prepare('PRAGMA user_version').get().user_version };
  } finally { db.close(); }
}

for (const mode of ['DELETE', 'WAL']) test(`two native participants migrate and roll back without altering vendor schema, history, integers or shared files (${mode})`, t => {
  const f = fixture(t), native = addNative(f, mode), plan = f.plan();
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.filesystem.nativeDatabases.length, 2);
  assert.equal(plan.filesystem.nativeDatabases.reduce((sum, value) => sum + value.changes.reduce((n, change) => n + change.count, 0), 0), 2);
  const result = f.apply(plan), nextRef = plan.mapping[0][1];
  assert.equal(result.status, 'completed');
  native.databases.forEach(file => {
    const moved = file.replace(f.ref, nextRef), data = readNative(moved);
    assert.equal(data.row.id.startsWith('thread-'), true);
    assert.equal(data.row.rollout_path, path.join(f.runtime.replace(f.ref, nextRef), '.codex/sessions/must-not-change.jsonl'));
    assert.equal(data.row.first_user_message, `history ${f.ref}`);
    assert.equal(data.row.n, 9223372036854775807n); assert.deepEqual(Buffer.from(data.row.b), Buffer.from([0, 255, 17]));
    assert.equal(data.version, 31);
    assert.equal(fs.readFileSync(data.row.rollout_path, 'utf8'), `{"text":"history ${f.ref}"}\n`);
  });
  assert.equal(readDefaultAccountRef(fs, f.root, 'codex'), nextRef);
  assert.equal(recoverMaintenance(f.root, result.id, { rollback: true, leaseOptions: { assertQuiet() {} } }).status, 'rolled_back');
  native.databases.forEach((file, index) => assert.equal(readNative(file).fingerprint, native.fingerprints[index]));
  assert.equal(f.plan().digest, plan.digest);
});

for (const phase of ['before_native_update', 'before_native_commit', 'after_native_commit', 'after_native_close', 'after_move', 'before_commit', 'after_commit']) {
  test(`SIGKILL at ${phase} reconciles native and AIH databases from actual committed states`, t => {
    const f = fixture(t), native = addNative(f), before = f.plan();
    const driver = `const fs=require('node:fs');const m=require(${JSON.stringify(service)});const root=${JSON.stringify(f.root)};
      const plan=m.createMaintenancePlan(root,['codex']);m.applyMaintenancePlan(plan,{confirmDigest:plan.digest,leaseOptions:{assertQuiet(){}},failpoint(phase,info){
        if(phase===${JSON.stringify(phase)}){fs.writeFileSync(root+'/crash-id.txt',info.id);process.kill(process.pid,'SIGKILL');}}});`;
    const child = spawnSync(process.execPath, ['-e', driver], { encoding: 'utf8', timeout: 30000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const id = fs.readFileSync(path.join(f.root, 'crash-id.txt'), 'utf8');
    let result;
    try { result = recoverMaintenance(f.root, id, { leaseOptions: { assertQuiet() {} } }); }
    catch (error) { t.diagnostic(JSON.stringify({ cause: error.cause?.message, blockers: f.plan().blockers })); throw error; }
    const committed = phase === 'after_commit';
    assert.equal(result.status, committed ? 'completed' : 'rolled_back');
    if (!committed) {
      native.databases.forEach((file, index) => assert.equal(readNative(file).fingerprint, native.fingerprints[index]));
      assert.equal(f.plan().digest, before.digest);
    } else assert.equal(f.plan().mapping.length, 0);
    assert.equal(fs.existsSync(maintenanceGatePath(f.root)), false);
  });
}

for (const phase of ['before_native_rollback_commit', 'after_native_rollback_commit']) test(`native compensation can itself be killed at ${phase} and resumed`, t => {
  const f = fixture(t); addNative(f);
  const before = f.plan(), applied = f.apply(before);
  const driver = `const m=require(${JSON.stringify(service)});m.recoverMaintenance(${JSON.stringify(f.root)},${JSON.stringify(applied.id)},
    {rollback:true,leaseOptions:{assertQuiet(){}},failpoint(phase){if(phase===${JSON.stringify(phase)})process.kill(process.pid,'SIGKILL');}});`;
  const child = spawnSync(process.execPath, ['-e', driver], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(recoverMaintenance(f.root, applied.id, { leaseOptions: { assertQuiet() {} } }).status, 'rolled_back');
  assert.equal(f.plan().digest, before.digest);
});

test('unknown native fields and reverse collisions remain blockers, never become ignored binary references', t => {
  const f = fixture(t), { databases } = addNative(f);
  const db = new DatabaseSync(databases[0]);
  db.exec('ALTER TABLE threads ADD COLUMN future_address TEXT');
  db.prepare('UPDATE threads SET future_address=?').run(`/future/${f.ref}/payload`); db.close();
  assert.ok(f.plan().blockers.some(value => value.reason === 'native_reference_unclassified'));
  assert.throws(() => f.apply(f.plan()), /plan_has_blockers/);
});

test('native post-migration writes cannot be overwritten by rollback', t => {
  const f = fixture(t), { databases } = addNative(f), before = f.plan(), applied = f.apply(before);
  const moved = databases[0].replace(f.ref, before.mapping[0][1]);
  const db = new DatabaseSync(moved); db.exec("UPDATE threads SET first_user_message='new native write'"); db.close();
  assert.throws(() => recoverMaintenance(f.root, applied.id, { rollback: true, leaseOptions: { assertQuiet() {} } }), /recovery_required/);
  assert.equal(readNative(moved).row.first_user_message, 'new native write');
  assert.equal(fs.existsSync(maintenanceGatePath(f.root)), true);
});

test('native backup corruption never gets silently substituted with a newly generated snapshot', t => {
  const f = fixture(t); addNative(f); const applied = f.apply(f.plan());
  fs.appendFileSync(path.join(applied.backupDirectory, 'native/0.sqlite'), 'corrupted');
  assert.throws(() => recoverMaintenance(f.root, applied.id, { rollback: true, leaseOptions: { assertQuiet() {} } }), /recovery_required/);
});

test('historical file-change paths are preserved while active runtime paths still migrate', () => {
  const old = 'acct_11111111111111111111', next = 'acct_22222222222222222222', mapping = new Map([[old, next]]);
  const record = { item: { kind: 'file_change', detail: { changes: [{ path: `fixture-${old}.txt`, diff: `content ${old}` }] } }, runtimeDir: `/aih/run/${old}` };
  const result = classifyDatabaseText('chat_runtime_events', 'payload_json', JSON.stringify(record), mapping);
  assert.equal(result.kind, 'rewrite');
  assert.deepEqual(JSON.parse(result.value).item, record.item);
  assert.equal(JSON.parse(result.value).runtimeDir, `/aih/run/${next}`);
  record.item.kind = 'future-operation';
  assert.equal(classifyDatabaseText('chat_runtime_events', 'payload_json', JSON.stringify(record), mapping).kind, 'unknown');
});

test('second participant commit failure compensates the already-committed first native store', t => {
  const f = fixture(t), native = addNative(f), before = f.plan();
  assert.throws(() => applyMaintenancePlan(before, { confirmDigest: before.digest, leaseOptions: { assertQuiet() {} },
    failpoint(phase, info) { if (phase === 'before_native_commit' && info.index === 1) throw new Error('fixture_second_store_failure'); }
  }), /fixture_second_store_failure/);
  native.databases.forEach((file, index) => assert.equal(readNative(file).fingerprint, native.fingerprints[index]));
  assert.equal(f.plan().digest, before.digest);
});

test('a committed native transaction whose acknowledgement is lost is resolved by state, not replay', t => {
  const f = fixture(t); addNative(f); const before = f.plan();
  const exec = DatabaseSync.prototype.exec; let nativeWrite = false, injected = false;
  DatabaseSync.prototype.exec = function(sql) {
    const isNativeCommit = nativeWrite && sql === 'COMMIT' && this.prepare('PRAGMA user_version').get().user_version === 31;
    const result = exec.call(this, sql);
    if (!injected && isNativeCommit) { injected = true; throw new Error('fixture_native_commit_ack_lost'); }
    return result;
  };
  try {
    assert.throws(() => applyMaintenancePlan(before, { confirmDigest: before.digest, leaseOptions: { assertQuiet() {} },
      failpoint(phase) { if (phase === 'before_native_commit') nativeWrite = true; }
    }), /fixture_native_commit_ack_lost/);
  } finally { DatabaseSync.prototype.exec = exec; }
  assert.equal(injected, true); assert.equal(f.plan().digest, before.digest);
});

test('failure to close a native handle keeps recovery gated even when its commit succeeded', t => {
  const f = fixture(t); addNative(f); const before = f.plan();
  const close = DatabaseSync.prototype.close; let committed = false, captured;
  DatabaseSync.prototype.close = function() {
    if (committed && !captured && this.prepare('PRAGMA user_version').get().user_version === 31) {
      captured = this; throw new Error('fixture_native_close_failed');
    }
    return close.call(this);
  };
  let id;
  try {
    assert.throws(() => applyMaintenancePlan(before, { confirmDigest: before.digest, leaseOptions: { assertQuiet() {} },
      failpoint(phase) { if (phase === 'after_native_commit') committed = true; }
    }), error => { id = error.journalId; return error.cause?.code === 'rekey_native_database_close_failed'; });
  } finally { DatabaseSync.prototype.close = close; if (captured) close.call(captured); }
  assert.ok(captured); assert.equal(fs.existsSync(maintenanceGatePath(f.root)), true);
  assert.equal(recoverMaintenance(f.root, id, { leaseOptions: { assertQuiet() {} } }).status, 'rolled_back');
  assert.equal(f.plan().digest, before.digest);
});

test('native row paths in a new schema or binary field require an explicit policy', t => {
  const f = fixture(t), { databases } = addNative(f);
  const db = new DatabaseSync(databases[0]);
  db.exec('CREATE TABLE future_state(data BLOB)');
  db.prepare('INSERT INTO future_state VALUES(?)').run(Buffer.from(f.ref));
  db.exec(`CREATE VIEW old_account_view AS SELECT '${f.ref}' AS account_reference`); db.close();
  const blockers = f.plan().blockers;
  assert.ok(blockers.some(value => value.reason === 'native_binary_reference'));
  assert.ok(blockers.some(value => value.reason === 'native_schema_reference'));
});

test('cold-journal settlement interrupted a second time remains recoverable without deleting vendor files', t => {
  const f = fixture(t); addNative(f); const before = f.plan();
  const first = `const fs=require('node:fs');const m=require(${JSON.stringify(service)});const r=${JSON.stringify(f.root)};const p=m.createMaintenancePlan(r,['codex']);
    m.applyMaintenancePlan(p,{confirmDigest:p.digest,leaseOptions:{assertQuiet(){}},failpoint(phase,i){if(phase==='before_native_commit'){fs.writeFileSync(r+'/crash-id.txt',i.id);process.kill(process.pid,'SIGKILL');}}});`;
  assert.equal(spawnSync(process.execPath, ['-e', first], { encoding: 'utf8', timeout: 30000 }).signal, 'SIGKILL');
  const id = fs.readFileSync(path.join(f.root, 'crash-id.txt'), 'utf8');
  // Interrupt at the actual SQLite mode transition, including marker-absent recovery.
  const second = `const {DatabaseSync}=require('node:sqlite');const exec=DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec=function(sql){const r=exec.call(this,sql);if(sql==='PRAGMA journal_mode=TRUNCATE')process.kill(process.pid,'SIGKILL');return r;};
    require(${JSON.stringify(service)}).recoverMaintenance(${JSON.stringify(f.root)},${JSON.stringify(id)},{leaseOptions:{assertQuiet(){}}});`;
  assert.equal(spawnSync(process.execPath, ['-e', second], { encoding: 'utf8', timeout: 30000 }).signal, 'SIGKILL');
  assert.equal(recoverMaintenance(f.root, id, { leaseOptions: { assertQuiet() {} } }).status, 'rolled_back');
  assert.equal(f.plan().digest, before.digest);
});

test('orphan native WAL is not dropped from the inventory just because its main file is missing', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.runtime, '.codex/state_5.sqlite-wal'), Buffer.from(f.ref));
  assert.ok(f.plan().blockers.some(value => value.reason === 'native_sidecar_without_main'));
});

test('public CLI requires verifiable admission: roundtrip when available, unchanged refusal under enclosing OS restrictions', t => {
  const f = fixture(t); addNative(f); const before = f.plan();
  const planFile = path.join(f.root, 'migration-plan.private');
  fs.writeFileSync(planFile, JSON.stringify(before), { mode: 0o600 });
  const cli = path.resolve(__dirname, '../scripts/oauth-identity-maintenance.js');
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30000 });
  const applied = run(['apply', '--ai-home', f.root, '--plan', planFile, '--confirm', before.digest]);
  if (applied.status !== 0 && process.platform === 'darwin') {
    const capability = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', process.execPath, '-e', 'process.exit(0)'],
      { encoding: 'utf8', timeout: 5000 });
    if (capability.status === 71 && /sandbox_apply: Operation not permitted/.test(capability.stderr)) {
      // The full isolation profile denies system process visibility. Refusal is
      // the production contract in that environment, not a reason to disable
      // the guard. Native focused runs separately execute the real CLI roundtrip.
      assert.match(applied.stderr, /"error":"rekey_runtime_quiescence_unverifiable"/);
      assert.equal(fs.existsSync(maintenanceGatePath(f.root)), false);
      assert.equal(f.plan().digest, before.digest);
      t.diagnostic('Enclosing OS policy: verified admission refusal with both resources unchanged; no roundtrip claimed in this branch.');
      return;
    }
  }
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.status, 'completed');
  const reverted = run(['rollback', '--ai-home', f.root, '--id', result.id, '--confirm', before.digest]);
  assert.equal(reverted.status, 0, reverted.stderr);
  assert.equal(JSON.parse(reverted.stdout).status, 'rolled_back');
  assert.equal(f.plan().digest, before.digest);
  assert.equal(applied.stdout.includes(f.ref), false, 'CLI receipt never prints raw account mappings');
});

test('public CLI can recover an initial gate crash with the retained confirmed plan', t => {
  const f = fixture(t); addNative(f); const before = f.plan();
  const planFile = path.join(f.root, 'migration-plan.private');
  fs.writeFileSync(planFile, JSON.stringify(before), { mode: 0o600 });
  const driver = `const fs=require('node:fs');const m=require(${JSON.stringify(service)});const p=JSON.parse(fs.readFileSync(${JSON.stringify(planFile)},'utf8'));
    m.applyMaintenancePlan(p,{confirmDigest:p.digest,leaseOptions:{assertQuiet(){}},failpoint(phase,i){if(phase==='after_gate'){fs.writeFileSync(${JSON.stringify(path.join(f.root,'crash-id.txt'))},i.id);process.kill(process.pid,'SIGKILL');}}});`;
  assert.equal(spawnSync(process.execPath, ['-e', driver], { encoding: 'utf8', timeout: 30000 }).signal, 'SIGKILL');
  const id = fs.readFileSync(path.join(f.root,'crash-id.txt'), 'utf8');
  const recovered = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/oauth-identity-maintenance.js'),
    'recover','--ai-home',f.root,'--id',id,'--plan',planFile,'--confirm',before.digest], {encoding:'utf8',timeout:30000});
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).reason, 'no_mutations_started');
  assert.equal(f.plan().digest, before.digest);
});
