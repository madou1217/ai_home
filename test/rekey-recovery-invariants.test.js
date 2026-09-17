'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { fixture } = require('./helpers/rekey-fixture');
const { openAppStateDatabase } = require('../lib/server/app-state-store');
const { maintenanceGatePath } = require('../lib/runtime/account-maintenance-gate');
const { applyMaintenancePlan, recoverMaintenance } = require('../lib/cli/services/account/oauth-identity-maintenance');

const maintenanceModule = path.resolve(__dirname, '../lib/cli/services/account/oauth-identity-maintenance');

function crashedApply(f, phase) {
  const script = `const fs=require('node:fs');const m=require(${JSON.stringify(maintenanceModule)});
    const root=${JSON.stringify(f.root)};const p=m.createMaintenancePlan(root,['codex']);
    m.applyMaintenancePlan(p,{confirmDigest:p.digest,leaseOptions:{assertQuiet(){}},failpoint(phase,info){
      if(phase===${JSON.stringify(phase)}) {fs.writeFileSync(root+'/crash-id.txt',info.id);process.exit(77);}
    }});`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 77, child.stderr);
  return fs.readFileSync(path.join(f.root, 'crash-id.txt'), 'utf8');
}

function journalId(f) {
  const names = fs.readdirSync(path.join(f.root, 'migration')).filter(name => name.startsWith('oauth-rekey-'));
  assert.equal(names.length, 1);
  return names[0].slice('oauth-rekey-'.length);
}

test('a successful database commit followed by an exception retains the gate until marker-based recovery', t => {
  const f = fixture(t), plan = f.plan();
  const exec = DatabaseSync.prototype.exec;
  let injected = false;
  DatabaseSync.prototype.exec = function(sql) {
    const hasMarker = sql === 'COMMIT' && this.prepare("SELECT 1 FROM app_kv WHERE key LIKE 'maintenance:oauth-rekey:%'").get();
    const result = exec.call(this, sql);
    if (!injected && hasMarker) { injected = true; throw new Error('fixture_commit_ack_lost'); }
    return result;
  };
  try { assert.throws(() => f.apply(plan)); }
  finally { DatabaseSync.prototype.exec = exec; }
  assert.equal(injected, true);
  assert.equal(fs.existsSync(maintenanceGatePath(f.root)), true, 'ambiguous COMMIT must not ungate ordinary writers');
  const recovered = recoverMaintenance(f.root, journalId(f), { leaseOptions: { assertQuiet() {} } });
  assert.equal(recovered.status, 'completed');
  assert.equal(f.plan().mapping.length, 0);
});

test('an exception before the actual database commit is rolled back by subsequent marker-based recovery', t => {
  const f = fixture(t), plan = f.plan();
  const exec = DatabaseSync.prototype.exec;
  let injected = false;
  DatabaseSync.prototype.exec = function(sql) {
    if (!injected && sql === 'COMMIT' && this.prepare("SELECT 1 FROM app_kv WHERE key LIKE 'maintenance:oauth-rekey:%'").get()) {
      injected = true; throw new Error('fixture_commit_not_executed');
    }
    return exec.call(this, sql);
  };
  try { assert.throws(() => f.apply(plan)); }
  finally { DatabaseSync.prototype.exec = exec; }
  assert.equal(fs.existsSync(maintenanceGatePath(f.root)), true);
  const recovered = recoverMaintenance(f.root, journalId(f), { leaseOptions: { assertQuiet() {} } });
  assert.equal(recovered.status, 'rolled_back');
  assert.equal(f.plan().digest, plan.digest);
});

test('pre-commit recovery cannot declare completion when another inventoried file changed', t => {
  const f = fixture(t);
  const other = path.join(f.root, 'run/codex-app-server/other.json');
  fs.writeFileSync(other, '{"value":"original"}');
  const id = crashedApply(f, 'after_edit');
  fs.writeFileSync(other, '{"value":"later-write"}');
  assert.throws(() => recoverMaintenance(f.root, id, { leaseOptions: { assertQuiet() {} } }), /recovery_required/);
  assert.equal(fs.readFileSync(other, 'utf8'), '{"value":"later-write"}');
  assert.equal(fs.existsSync(maintenanceGatePath(f.root)), true);
});

test('rollback value collision is found in planning rather than after committing an irreversible update', t => {
  const f = fixture(t), nextRef = f.plan().mapping[0][1];
  const db = openAppStateDatabase(fs, f.root);
  db.exec('CREATE TABLE collision_fixture(account_ref TEXT)');
  db.prepare('INSERT INTO collision_fixture VALUES(?)').run(f.ref);
  db.prepare('INSERT INTO collision_fixture VALUES(?)').run(nextRef);
  db.close();
  const plan = f.plan();
  assert.ok(plan.blockers.some(blocker => blocker.reason === 'rekey_reverse_value_collision'));
  assert.throws(() => f.apply(plan), /plan_has_blockers/);
});

test('crashing twice before initial journal publication does not lose the transaction identity', t => {
  const f = fixture(t), before = f.plan();
  const id = crashedApply(f, 'after_gate');
  const driver = `const fs=require('node:fs');const rename=fs.renameSync;
    fs.renameSync=(from,to)=>{const result=rename(from,to);if(to.endsWith('/oauth-rekey.lock/owner.json'))process.exit(78);return result;};
    require(${JSON.stringify(maintenanceModule)}).recoverMaintenance(${JSON.stringify(f.root)},${JSON.stringify(id)},{leaseOptions:{assertQuiet(){}}});`;
  const child = spawnSync(process.execPath, ['-e', driver], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 78, child.stderr);
  const recovered = recoverMaintenance(f.root, id, { leaseOptions: { assertQuiet() {} } });
  assert.equal(recovered.status, 'rolled_back');
  assert.equal(f.plan().digest, before.digest);
});

for (const phase of ['after_edit', 'after_link', 'after_move', 'after_sql_updates', 'before_commit', 'after_commit']) {
  test(`SIGKILL at ${phase} restores or commits both resources without an exit handler`, t => {
    const f = fixture(t);
    const pointer = path.join(f.root, 'run/codex-app-server/current.json');
    const linkBefore = `../codex-desktop/${f.ref}/.codex/config.toml`;
    fs.symlinkSync(linkBefore, pointer);
    const original = f.plan();
    const driver = `const fs=require('node:fs');const m=require(${JSON.stringify(maintenanceModule)});
      const root=${JSON.stringify(f.root)};const plan=m.createMaintenancePlan(root,['codex']);
      m.applyMaintenancePlan(plan,{confirmDigest:plan.digest,leaseOptions:{assertQuiet(){}},failpoint(phase,info){
        if(phase===${JSON.stringify(phase)}){fs.writeFileSync(root+'/crash-id.txt',info.id);process.kill(process.pid,'SIGKILL');}
      }});`;
    const child = spawnSync(process.execPath, ['-e', driver], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const id = fs.readFileSync(path.join(f.root, 'crash-id.txt'), 'utf8');
    assert.throws(() => openAppStateDatabase(fs, f.root), /maintenance_in_progress/);
    const recovered = recoverMaintenance(f.root, id, { leaseOptions: { assertQuiet() {} } });
    const committed = phase === 'after_commit';
    assert.equal(recovered.status, committed ? 'completed' : 'rolled_back');
    const nextRef = committed ? original.mapping[0][1] : f.ref;
    assert.equal(fs.readlinkSync(pointer), `../codex-desktop/${nextRef}/.codex/config.toml`);
    assert.equal(fs.readFileSync(pointer, 'utf8').includes(nextRef), true);
    assert.equal(fs.readFileSync(path.join(f.shared, 'must-not-change.jsonl'), 'utf8'), `{"text":"history ${f.ref}"}\n`);
    if (!committed) assert.equal(f.plan().digest, original.digest);
    else assert.equal(f.plan().mapping.length, 0);
    // Retry is idempotent: it does not reapply SQL or create another account.
    assert.equal(recoverMaintenance(f.root, id, { leaseOptions: { assertQuiet() {} } }).status, recovered.status);
  });
}

for (const phase of ['rollback_after_link', 'recovery_before_commit', 'recovery_after_commit']) {
  test(`SIGKILL during rollback at ${phase} keeps the original rollback intention`, t => {
    const f = fixture(t);
    const pointer = path.join(f.root, 'run/codex-app-server/current.json');
    fs.symlinkSync(`../codex-desktop/${f.ref}/.codex/config.toml`, pointer);
    const original = f.plan(), applied = f.apply(original);
    const script = `const m=require(${JSON.stringify(maintenanceModule)});
      m.recoverMaintenance(${JSON.stringify(f.root)},${JSON.stringify(applied.id)},{rollback:true,leaseOptions:{assertQuiet(){}},
        failpoint(phase){if(phase===${JSON.stringify(phase)})process.kill(process.pid,'SIGKILL');}});`;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const recovered = recoverMaintenance(f.root, applied.id, { leaseOptions: { assertQuiet() {} } });
    assert.equal(recovered.status, 'rolled_back');
    assert.equal(f.plan().digest, original.digest);
  });
}

test('a crash after the replacement rename but before directory fsync is recoverable', t => {
  const f = fixture(t), original = f.plan();
  const driver = `const fs=require('node:fs');const path=require('node:path');const rename=fs.renameSync;
    const root=${JSON.stringify(f.root)};const m=require(${JSON.stringify(maintenanceModule)});
    fs.renameSync=(from,to)=>{const result=rename(from,to);if(to.endsWith('/.codex/config.toml')){
      const id=fs.readdirSync(root+'/migration').find(n=>n.startsWith('oauth-rekey-')).slice(12);
      fs.writeFileSync(root+'/crash-id.txt',id);process.kill(process.pid,'SIGKILL');}return result;};
    const p=m.createMaintenancePlan(root,['codex']);m.applyMaintenancePlan(p,{confirmDigest:p.digest,leaseOptions:{assertQuiet(){}}});`;
  const child = spawnSync(process.execPath, ['-e', driver], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const recovered = recoverMaintenance(f.root, fs.readFileSync(path.join(f.root, 'crash-id.txt'), 'utf8'), { leaseOptions: { assertQuiet() {} } });
  assert.equal(recovered.status, 'rolled_back');
  assert.equal(f.plan().digest, original.digest);
});

test('a consistent SQLite backup includes committed WAL records left by a killed process', t => {
  const f = fixture(t);
  const driver = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(path.join(f.root, 'app-state.db'))});
    db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;UPDATE model_usage_records SET total_tokens=7777');
    process.kill(process.pid,'SIGKILL');`;
  const child = spawnSync(process.execPath, ['-e', driver], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.ok(fs.statSync(path.join(f.root, 'app-state.db-wal')).size > 0);
  const original = f.plan();
  const result = f.apply(original);
  const backup = new DatabaseSync(path.join(result.backupDirectory, 'database.sqlite'), { readOnly: true });
  try {
    assert.equal(backup.prepare('SELECT total_tokens n FROM model_usage_records').get().n, 7777);
    assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  } finally { backup.close(); }
  assert.equal(recoverMaintenance(f.root, result.id, { rollback: true, leaseOptions: { assertQuiet() {} } }).status, 'rolled_back');
  assert.equal(f.plan().digest, original.digest);
});

test('restoring bytes does not discard restrictive permissions or extended attributes', t => {
  const f = fixture(t);
  fs.chmodSync(f.config, 0o640);
  const { execFileSync } = require('node:child_process');
  const attribute = 'user.aih.step3';
  if (process.platform === 'darwin') execFileSync('/usr/bin/xattr', ['-w', attribute, 'fixture-value', f.config]);
  else if (process.platform === 'linux') execFileSync('python3', ['-c', 'import os,sys;os.setxattr(sys.argv[1],sys.argv[2],b"fixture-value")', f.config, attribute]);
  else { t.skip('metadata adapter is supported only on macOS/Linux'); return; }
  const original = f.plan(), applied = f.apply(original);
  assert.equal(recoverMaintenance(f.root, applied.id, { rollback: true, leaseOptions: { assertQuiet() {} } }).status, 'rolled_back');
  assert.equal(fs.statSync(f.config).mode & 0o777, 0o640);
  const value = process.platform === 'darwin'
    ? execFileSync('/usr/bin/xattr', ['-p', attribute, f.config], { encoding: 'utf8' }).trim()
    : execFileSync('python3', ['-c', 'import os,sys;print(os.getxattr(sys.argv[1],sys.argv[2]).decode())', f.config, attribute], { encoding: 'utf8' }).trim();
  assert.equal(value, 'fixture-value');
});
