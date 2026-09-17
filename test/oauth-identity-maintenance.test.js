'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { readDefaultAccountRef } = require('../lib/account/default-account-store');
const { openAppStateDatabase } = require('../lib/server/app-state-store');
const { maintenanceGatePath } = require('../lib/runtime/account-maintenance-gate');
const { createMaintenancePlan, applyMaintenancePlan, recoverMaintenance } = require('../lib/cli/services/account/oauth-identity-maintenance');
const { assertNoDatabaseOpeners } = require('../lib/cli/services/account/rekey-lease');

const { fixture } = require('./helpers/rekey-fixture');

test('maintenance migrates DB/default/runtime references, preserves history and values, then rolls back exactly', t => {
  const f = fixture(t), plan = f.plan();
  assert.deepEqual(plan.blockers, []);
  const target = plan.mapping[0][1];
  const result = f.apply(plan);
  assert.equal(result.status, 'completed');
  assert.equal(fs.existsSync(maintenanceGatePath(f.root)), false);
  assert.equal(readDefaultAccountRef(fs, f.root, 'codex'), target);
  const targetRuntime = path.join(f.root, 'run/codex-desktop', target);
  assert.equal(fs.existsSync(f.runtime), false);
  assert.ok(fs.readFileSync(path.join(targetRuntime, '.codex/config.toml'), 'utf8').includes(target));
  assert.equal(fs.readlinkSync(path.join(targetRuntime, '.codex/sessions')), f.shared);
  assert.equal(fs.readFileSync(path.join(f.shared, 'must-not-change.jsonl'), 'utf8'), `{"text":"history ${f.ref}"}\n`);
  const db = openAppStateDatabase(fs, f.root);
  const row = db.prepare('SELECT * FROM chat_runtime_fixture').get();
  assert.equal(row.account_ref, target); assert.ok(row.payload_json.includes('9223372036854775807'));
  assert.ok(row.payload_json.includes(`"content":"keep ${f.ref}"`));
  assert.equal(db.prepare('SELECT event_key FROM model_usage_records').get().event_key, `gateway:${f.ref}:request-fixture`);
  assert.equal(db.prepare('SELECT SUM(total_tokens) n FROM model_usage_records').get().n, 1234);
  db.close();
  assert.equal(f.apply(f.plan()).status, 'nothing_to_do');
  const rollback = recoverMaintenance(f.root, result.id, { rollback: true, leaseOptions: { assertQuiet() {} } });
  assert.equal(rollback.status, 'rolled_back');
  assert.equal(readDefaultAccountRef(fs, f.root, 'codex'), f.ref);
  assert.equal(f.plan().digest, plan.digest);
});

for (const phase of ['after_edit', 'after_move', 'before_commit']) {
  test(`failure at ${phase} leaves both resources at the exact original state`, t => {
    const f = fixture(t), plan = f.plan();
    assert.throws(() => applyMaintenancePlan(plan, { confirmDigest: plan.digest, leaseOptions: { assertQuiet() {} },
      failpoint(actual) { if (actual === phase) throw new Error('injected_failure'); }
    }), /injected_failure/);
    assert.equal(f.plan().digest, plan.digest);
    assert.equal(fs.existsSync(maintenanceGatePath(f.root)), false);
  });
}

test('tampered plan, stale data and target collision never apply partial changes', t => {
  const f = fixture(t), plan = f.plan();
  assert.throws(() => applyMaintenancePlan({ ...plan, providers: ['grok'] }, { confirmDigest: plan.digest }), /modified_or_unconfirmed/);
  const db = openAppStateDatabase(fs, f.root); db.exec('UPDATE model_usage_records SET total_tokens=4321'); db.close();
  assert.throws(() => f.apply(plan), /plan_stale/);
  const target = plan.mapping[0][1]; fs.mkdirSync(path.join(f.root, 'run/codex-desktop', target));
  assert.ok(f.plan().blockers.some(blocker => blocker.reason === 'rekey_target_exists'));
});

test('unclassified machine files block while shared historical symlinks are never traversed', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.runtime, 'unknown.sh'), `echo '${f.ref}'\n`);
  assert.ok(f.plan().blockers.some(blocker => blocker.reason === 'rekey_machine_file_format_unclassified'));
  assert.ok(f.plan().filesystem.inspected < 100);
});

for (const crashPhase of ['after_edit', 'after_move', 'before_commit', 'after_commit']) {
  test(`actual subprocess crash ${crashPhase} recovers using the SQLite commit marker`, t => {
    const f = fixture(t), original = f.plan();
    const driver = `const fs=require('node:fs'); const m=require(${JSON.stringify(path.resolve(__dirname, '../lib/cli/services/account/oauth-identity-maintenance'))});
      const p=m.createMaintenancePlan(${JSON.stringify(f.root)},['codex']);
      m.applyMaintenancePlan(p,{confirmDigest:p.digest,leaseOptions:{assertQuiet(){}},failpoint(phase,info){
        if(phase===${JSON.stringify(crashPhase)}) {fs.writeFileSync(${JSON.stringify(path.join(f.root, 'crash-id.txt'))},info.id);process.exit(77);}
      }});`;
    const child = spawnSync(process.execPath, ['-e', driver], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 77, child.stderr);
    assert.throws(() => openAppStateDatabase(fs, f.root), /maintenance_in_progress/);
    const id = fs.readFileSync(path.join(f.root, 'crash-id.txt'), 'utf8');
    const recovered = recoverMaintenance(f.root, id, { leaseOptions: { assertQuiet() {} } });
    assert.equal(recovered.status, crashPhase === 'after_commit' ? 'completed' : 'rolled_back');
    if (crashPhase !== 'after_commit') assert.equal(f.plan().digest, original.digest);
    else assert.equal(f.plan().mapping.length, 0);
    assert.equal(fs.existsSync(maintenanceGatePath(f.root)), false);
  });
}

test('completed rollback refuses subsequent live writes instead of restoring a stale snapshot', t => {
  const f = fixture(t), result = f.apply(f.plan());
  const db = openAppStateDatabase(fs, f.root); db.exec('UPDATE model_usage_records SET total_tokens=9999'); db.close();
  assert.throws(() => recoverMaintenance(f.root, result.id, { rollback: true, leaseOptions: { assertQuiet() {} } }), /recovery_required/);
  assert.equal(fs.existsSync(maintenanceGatePath(f.root)), true);
});

test('quiescence requires verifiable lsof output; missing tool and foreign readers fail closed', () => {
  assert.throws(() => assertNoDatabaseOpeners('/fixture.db', { execFileSync() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } }), /unverifiable/);
  assert.throws(() => assertNoDatabaseOpeners('/fixture.db', { execFileSync() { return '999999\n'; } }), /openers_active/);
  assert.doesNotThrow(() => assertNoDatabaseOpeners('/fixture.db', { execFileSync() { return `${process.pid}\n`; } }));
});

for (const phase of ['rollback_after_move', 'rollback_after_edit']) {
  test(`an interrupted explicit rollback resumes its persisted intent: ${phase}`, t => {
    const f = fixture(t), original = f.plan(), committed = f.apply(original);
    const driver = `const m=require(${JSON.stringify(path.resolve(__dirname, '../lib/cli/services/account/oauth-identity-maintenance'))});
      m.recoverMaintenance(${JSON.stringify(f.root)},${JSON.stringify(committed.id)},{rollback:true,leaseOptions:{assertQuiet(){}},
        failpoint(phase){if(phase===${JSON.stringify(phase)})process.exit(78)}});`;
    const child = spawnSync(process.execPath, ['-e', driver], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 78, child.stderr);
    const recovered = recoverMaintenance(f.root, committed.id, { leaseOptions: { assertQuiet() {} } });
    assert.equal(recovered.status, 'rolled_back');
    assert.equal(f.plan().digest, original.digest);
  });
}

test('a SQL uniqueness failure after filesystem staging restores the whole operation', t => {
  const f = fixture(t), target = f.plan().mapping[0][1];
  const db = openAppStateDatabase(fs, f.root);
  db.exec('CREATE TABLE reference_collision(account_ref TEXT UNIQUE)');
  db.prepare('INSERT INTO reference_collision VALUES(?)').run(f.ref);
  db.prepare('INSERT INTO reference_collision VALUES(?)').run(target);
  db.close();
  const original = f.plan();
  assert.throws(() => f.apply(original), /plan_has_blockers/);
  assert.equal(f.plan().digest, original.digest);
});

test('a trigger side effect is detected by the predicted whole-database state', t => {
  const f = fixture(t);
  const db = openAppStateDatabase(fs, f.root);
  db.exec('CREATE TRIGGER unexpected_usage_change AFTER UPDATE OF account_ref ON chat_runtime_fixture BEGIN UPDATE model_usage_records SET total_tokens=total_tokens+1; END');
  db.close();
  const original = f.plan();
  assert.throws(() => f.apply(original), /post_state_mismatch/);
  assert.equal(f.plan().digest, original.digest);
});

test('filesystem I/O failure during a staged edit rolls back without losing native content', t => {
  const f = fixture(t), original = f.plan();
  const rename = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    if (!injected && to === fs.realpathSync(f.config)) {
      injected = true;
      throw Object.assign(new Error('fixture_io_failure'), { code: 'EIO' });
    }
    return rename(from, to);
  };
  try { assert.throws(() => f.apply(original), /fixture_io_failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(f.plan().digest, original.digest);
});

test('backup checksum failure blocks recovery rather than restoring untrusted bytes', t => {
  const f = fixture(t), result = f.apply(f.plan());
  fs.appendFileSync(path.join(result.backupDirectory, 'database.sqlite'), 'tampered');
  assert.throws(() => recoverMaintenance(f.root, result.id, { rollback: true, leaseOptions: { assertQuiet() {} } }), /recovery_required/);
  assert.equal(fs.existsSync(maintenanceGatePath(f.root)), true);
});

test('a symlinked backup directory cannot redirect snapshots outside the selected AIH root', t => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-rekey-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(f.root, 'migration'));
  assert.throws(() => f.apply(f.plan()), /backup_directory_symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('default OS quiescence guard works without injected permission on a temporary database', t => {
  const f = fixture(t), plan = f.plan();
  const check = spawnSync('lsof', ['-v'], { encoding: 'utf8' });
  // A restricted test sandbox may provide lsof but forbid launching ps. That
  // is a real fail-closed branch, not permission to assume no detached clients.
  // Discard argv output: this probe checks capability, never inspects user input.
  const processes = spawnSync('ps', ['-axo', 'pid=,args='], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (check.error || check.status !== 0 || processes.error || processes.status !== 0) {
    assert.throws(() => applyMaintenancePlan(plan, { confirmDigest: plan.digest }), /quiescence_unverifiable/);
    assert.equal(fs.existsSync(maintenanceGatePath(f.root)), false);
    return;
  }
  const result = applyMaintenancePlan(plan, { confirmDigest: plan.digest });
  assert.equal(result.status, 'completed');
});

test('maintenance CLI requires an explicit root and digest and never accepts a bypass flag', () => {
  const { parseArgs } = require('../scripts/oauth-identity-maintenance');
  assert.throws(() => parseArgs(['apply', '--skip-quiescence']), /invalid_maintenance_option/);
  assert.throws(() => parseArgs(['plan', '--ai-home', '/a', '--ai-home', '/b']), /invalid_maintenance_option/);
  assert.deepEqual(parseArgs(['plan', '--ai-home', '/fixture', '--output', '/plan']), { action: 'plan', 'ai-home': '/fixture', output: '/plan' });
});

test('public migration CLI cannot execute unapproved production writes or recovery', () => {
  const { main } = require('../scripts/oauth-identity-maintenance');
  for (const action of ['apply','recover','rollback']) {
    assert.throws(() => main([action,'--ai-home','/not-accessed']), /live_migration_not_approved/);
  }
});

test('schema SQL containing an old identity is an explicit plan blocker', t => {
  const f = fixture(t), db = openAppStateDatabase(fs, f.root);
  db.exec(`CREATE VIEW stale_account_selector AS SELECT * FROM chat_runtime_fixture WHERE account_ref='${f.ref}'`);
  db.close();
  assert.ok(f.plan().blockers.some(row => row.reason === 'rekey_schema_reference_requires_review'));
});

test('unknown .ini and extensionless machine files cannot hide embedded live references', t => {
  const f = fixture(t);
  for (const name of ['settings.ini','launcher']) fs.writeFileSync(path.join(f.runtime,name), `selected=${f.ref}`);
  const plan = f.plan();
  assert.ok(plan.blockers.some(row => row.path.endsWith('settings.ini')));
  assert.ok(plan.blockers.some(row => row.path.endsWith('launcher')));
});

test('a symlinked traversal root cannot silently omit its runtime metadata', t => {
  const f = fixture(t), moved = path.join(f.root, 'external-run');
  fs.renameSync(path.join(f.root,'run'),moved);
  fs.symlinkSync(moved,path.join(f.root,'run'));
  assert.ok(f.plan().blockers.some(row => row.reason === 'rekey_traversal_root_is_symlink'));
});

test('WAL symlink is rejected before SQLite opens it and hardlinked configs block planning', t => {
  const f = fixture(t);
  const external = path.join(f.root,'untouched'); fs.writeFileSync(external,'marker');
  const wal = path.join(f.root,'app-state.db-wal');
  if (fs.existsSync(wal)) fs.unlinkSync(wal);
  fs.symlinkSync(external,wal);
  assert.throws(() => f.plan(), /sidecar_invalid/);
  assert.equal(fs.readFileSync(external,'utf8'),'marker');
  fs.unlinkSync(wal);
  fs.linkSync(f.config,path.join(f.root,'linked-config.toml'));
  assert.ok(f.plan().blockers.some(row => row.reason === 'rekey_hardlinked_machine_file'));
});

test('a lost gate does not allow startup with an unfinished journal', t => {
  const f = fixture(t);
  const { assertNoUnfinishedMaintenance } = require('../lib/runtime/account-maintenance-gate');
  const directory=path.join(f.root,'migration','oauth-rekey-00000000-0000-0000-0000-000000000001');
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'journal.json'),'{"state":"applying"}');
  assert.throws(() => assertNoUnfinishedMaintenance(fs,f.root), /recovery_required/);
  assert.throws(() => f.apply(f.plan()), /recovery_required/);
});

test('extended metadata is hashed and compared without exposing attribute values', () => {
  const { inspectReplaceableMetadata } = require('../lib/cli/services/account/rekey-file-metadata');
  const stat={nlink:1,uid:process.getuid?.(),gid:process.getgid?.(),mode:0o600};
  const linux=inspectReplaceableMetadata('/fixture',stat,{platform:'linux',execFileSync(){return '[["system.posix_acl_access","0102"]]';}});
  const changed=inspectReplaceableMetadata('/fixture',stat,{platform:'linux',execFileSync(){return '[["system.posix_acl_access","0103"]]';}});
  assert.match(linux,/^[a-f0-9]{64}$/); assert.notEqual(linux,changed);
  assert.throws(() => inspectReplaceableMetadata('/fixture',stat,{execFileSync(){throw new Error('sensitive-attribute');}}), error => error.message === 'rekey_metadata_unverifiable');
});

test('plan size is bounded before any lease or filesystem mutation', () => {
  const { digestPlan } = require('../lib/cli/services/account/oauth-identity-maintenance');
  const plan={version:3,blockers:[],padding:'x'.repeat(64*1024*1024)};
  plan.digest=digestPlan(plan);
  assert.throws(() => applyMaintenancePlan(plan,{confirmDigest:plan.digest}), /plan_size_limit/);
});

test('crash after durable gate but before journal publication recovers without inventing a snapshot', t => {
  const f = fixture(t), original = f.plan();
  const driver=`const fs=require('node:fs');const m=require(${JSON.stringify(path.resolve(__dirname,'../lib/cli/services/account/oauth-identity-maintenance'))});
    const p=m.createMaintenancePlan(${JSON.stringify(f.root)},['codex']);m.applyMaintenancePlan(p,{confirmDigest:p.digest,leaseOptions:{assertQuiet(){}},
    failpoint(phase,info){if(phase==='after_gate'){fs.writeFileSync(${JSON.stringify(path.join(f.root,'crash-id.txt'))},info.id);process.exit(79)}}});`;
  const child=spawnSync(process.execPath,['-e',driver],{encoding:'utf8',timeout:10000});
  assert.equal(child.status,79,child.stderr);
  const id=fs.readFileSync(path.join(f.root,'crash-id.txt'),'utf8');
  const result=recoverMaintenance(f.root,id,{leaseOptions:{assertQuiet(){}}});
  assert.equal(result.reason,'no_mutations_started');
  assert.equal(f.plan().digest,original.digest);
});
