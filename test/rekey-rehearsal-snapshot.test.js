'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const { snapshotReadonlyDatabase } = require('../lib/cli/services/account/rekey-readonly-snapshot');
const { copyRehearsalScope } = require('../lib/cli/services/account/rekey-rehearsal-copy');
const { createMaintenancePlan, applyMaintenancePlan } = require('../lib/cli/services/account/oauth-identity-maintenance');
const { hashBackup } = require('../lib/cli/services/account/rekey-backup');
const { fixture } = require('./helpers/rekey-fixture');

function workspace(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aih-snapshot-contract-')));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), copy = path.join(root, 'copy');
  fs.mkdirSync(source, { mode: 0o700 }); fs.mkdirSync(copy, { mode: 0o700 });
  return { root, source, copy };
}

test('readonly snapshot preserves real committed WAL pages and exact integer/blob values', async t => {
  const f = workspace(t), original = path.join(f.source, 'app-state.db'), target = path.join(f.copy, 'app-state.db');
  const driver = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(original)});
    db.exec("PRAGMA journal_mode=WAL;CREATE TABLE data(id INTEGER PRIMARY KEY,n INTEGER,b BLOB);INSERT INTO data VALUES(1,9223372036854775807,X'001122ff')");process.exit(0);`;
  const child = spawnSync(process.execPath, ['-e', driver], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const before = [original, original+'-wal'].map(file => hashBackup(file));
  const receipt = await snapshotReadonlyDatabase(original, target, { aihDatabase: true });
  assert.equal(receipt.sourceReadOnly, true);
  // Read-only SQLite can update SHM reader coordination when OS permissions
  // allow it. The actual account DB and WAL content must stay unchanged. Live
  // rehearsal additionally denies all source writes in an OS sandbox.
  assert.deepEqual([original, original+'-wal'].map(file => hashBackup(file)), before);
  assert.deepEqual(fs.readdirSync(f.copy), ['app-state.db']);
  const db = new DatabaseSync(target); const statement=db.prepare('SELECT n,hex(b) b FROM data');statement.setReadBigInts(true);
  assert.deepEqual({ ...statement.get() }, { n: 9223372036854775807n, b: '001122FF' }); db.close();
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test('snapshot rejects links, non-private output directories, and existing destinations', async t => {
  const f=workspace(t), original=path.join(f.source,'app-state.db'), target=path.join(f.copy,'app-state.db');
  const db=new DatabaseSync(original);db.exec('CREATE TABLE data(id INTEGER)');db.close();
  const link=path.join(f.source,'link.db');fs.symlinkSync(original,link);
  await assert.rejects(snapshotReadonlyDatabase(link,target), /source_database_unsafe/);
  await assert.rejects(snapshotReadonlyDatabase(link,target,{aihDatabase:true}), /database_name_mismatch/);
  fs.chmodSync(f.copy,0o755);
  await assert.rejects(snapshotReadonlyDatabase(original,target), /parent_not_private/);
  fs.chmodSync(f.copy,0o700);fs.writeFileSync(target,'keep');
  await assert.rejects(snapshotReadonlyDatabase(original,target), /destination_exists/);
  assert.equal(fs.readFileSync(target,'utf8'),'keep');
});

test('scope copy never follows shared history and records only internal absolute link relocation', async t => {
  const f=workspace(t);fs.mkdirSync(path.join(f.source,'run/account'),{recursive:true});
  fs.mkdirSync(path.join(f.source,'run/account/sessions'));fs.writeFileSync(path.join(f.source,'run/account/sessions/history'),'unchanged');
  fs.mkdirSync(path.join(f.root,'outside'));fs.writeFileSync(path.join(f.root,'outside/private'),'do not traverse');
  fs.symlinkSync(path.join(f.root,'outside'),path.join(f.source,'run/external'));
  fs.symlinkSync(path.join(f.source,'run/account'),path.join(f.source,'run/internal'));
  fs.writeFileSync(path.join(f.source,'run/account/config.json'),'{}');
  const receipt=await copyRehearsalScope(f.source,f.copy);
  assert.equal(receipt.externalLinksFollowed,0);
  assert.equal(fs.readlinkSync(path.join(f.copy,'run/external')),path.join(f.root,'outside'));
  assert.equal(fs.readlinkSync(path.join(f.copy,'run/internal')),path.join(f.copy,'run/account'));
  assert.deepEqual(fs.readdirSync(path.join(f.copy,'run/account/sessions')),[]);
  assert.equal(receipt.records.filter(row=>row.relocated).length,1);
});

test('copy requires disjoint empty private destinations and enforces size budgets', async t => {
  const f=workspace(t);fs.mkdirSync(path.join(f.source,'run'));fs.writeFileSync(path.join(f.source,'run/config.json'),'123456789');
  await assert.rejects(copyRehearsalScope(f.source,f.source), /overlap/);
  await assert.rejects(copyRehearsalScope(f.source,f.copy,{maxBytes:2}), /byte_budget/);
  await assert.rejects(copyRehearsalScope(f.source,f.copy), /root_not_empty/);
});

test('an actual SQLite schema snapshot does not erase an unknown native database blocker or fake migration success', async t => {
  const f=fixture(t), copy=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'aih-blocked-rehearsal-')));fs.chmodSync(copy,0o700);
  t.after(()=>fs.rmSync(copy,{recursive:true,force:true}));
  const nativePath=path.join(f.runtime,'.codex/state_5.sqlite');
  const db=new DatabaseSync(nativePath);db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES(?,?)').run('native-session',path.join(f.runtime,'.codex/sessions/session.jsonl'));db.close();
  await snapshotReadonlyDatabase(path.join(f.root,'app-state.db'),path.join(copy,'app-state.db'),{aihDatabase:true});
  const receipt=await copyRehearsalScope(f.root,copy);
  assert.equal(receipt.records.filter(row=>row.type==='native-sqlite').length,1);
  const plan=createMaintenancePlan(copy,['codex']);
  assert.ok(plan.blockers.some(blocker=>blocker.reason==='rekey_unclassified_file_reference'));
  const before=hashBackup(path.join(copy,'app-state.db'));
  assert.throws(()=>applyMaintenancePlan(plan,{confirmDigest:plan.digest}), /plan_has_blockers/);
  assert.equal(hashBackup(path.join(copy,'app-state.db')),before);
  assert.equal(fs.existsSync(path.join(copy,'run/maintenance/oauth-rekey.lock')),false);
});

test('native file-set snapshot recovers WAL inside the copy without opening or changing source SQL files', async t => {
  const f=workspace(t),original=path.join(f.source,'state_5.sqlite'),target=path.join(f.copy,'state_5.sqlite');
  const driver=`const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(original)});
  db.exec("PRAGMA journal_mode=WAL;CREATE TABLE threads(id TEXT,rollout_path TEXT);INSERT INTO threads VALUES('thread','/original/old/session.jsonl')");process.exit(0);`;
  assert.equal(spawnSync(process.execPath,['-e',driver]).status,0);
  // Removing the throwaway fixture SHM forces recovery in the destination only.
  fs.unlinkSync(original+'-shm');
  const before=[original,original+'-wal'].map(file=>hashBackup(file));
  const {snapshotNativeSqliteFiles}=require('../lib/cli/services/account/rekey-native-snapshot');
  const receipt=await snapshotNativeSqliteFiles(original,target);
  assert.equal(receipt.sourceSqlOpened,false);assert.equal(receipt.sourceFileVersionsUnchanged,true);
  assert.deepEqual([original,original+'-wal'].map(file=>hashBackup(file)),before);
  assert.equal(fs.existsSync(original+'-shm'),false);
  const db=new DatabaseSync(target,{readOnly:true});
  assert.equal(db.prepare('SELECT rollout_path FROM threads').get().rollout_path,'/original/old/session.jsonl');db.close();
});

test('native snapshot refuses a file that changes during copying instead of publishing a false stable receipt', async t => {
  const f=workspace(t),original=path.join(f.source,'state_5.sqlite'),target=path.join(f.copy,'state_5.sqlite');
  const db=new DatabaseSync(original);db.exec('CREATE TABLE threads(id TEXT)');db.close();
  const copy=fs.copyFileSync;let injected=false;
  fs.copyFileSync=(source,destination,flags)=>{copy(source,destination,flags);if(source===original&&!injected){injected=true;fs.utimesSync(original,new Date(),new Date(Date.now()+5000));}};
  try {
    const {snapshotNativeSqliteFiles}=require('../lib/cli/services/account/rekey-native-snapshot');
    await assert.rejects(snapshotNativeSqliteFiles(original,target),/native_source_changed/);
  } finally {fs.copyFileSync=copy;}
  assert.equal(fs.existsSync(target),false);
});

test('snapshot security metadata is captured with the current file, not taken from an older plan', async t => {
  const f=workspace(t);fs.mkdirSync(path.join(f.source,'run'));
  const original=path.join(f.source,'run/config.json');fs.writeFileSync(original,'{"current":true}',{mode:0o600});
  const receipt=await copyRehearsalScope(f.source,f.copy,{metadataPaths:['run/config.json']});
  const row=receipt.records.find(row=>row.path==='run/config.json');
  assert.equal(row.byteDigest,hashBackup(path.join(f.copy,'run/config.json')));
  assert.match(row.metadataDigest,/^[a-f0-9]{64}$/);
});

test('native rollback journals are refused instead of copying an uncommitted main file', async t => {
  const f=workspace(t),original=path.join(f.source,'native.sqlite');
  const db=new DatabaseSync(original);db.exec('CREATE TABLE threads(id TEXT)');db.close();
  fs.writeFileSync(original+'-journal','potential hot journal');
  const {snapshotNativeSqliteFiles}=require('../lib/cli/services/account/rekey-native-snapshot');
  await assert.rejects(snapshotNativeSqliteFiles(original,path.join(f.copy,'native.sqlite')), /rollback_journal_unsupported/);
  assert.deepEqual(fs.readdirSync(f.copy),[]);
});

test('snapshot rejects symlinked native sidecars and path traversal in metadata selectors', async t => {
  const f=workspace(t),original=path.join(f.source,'native.sqlite');
  const db=new DatabaseSync(original);db.exec('CREATE TABLE threads(id TEXT)');db.close();
  const outside=path.join(f.root,'outside');fs.writeFileSync(outside,'unchanged');
  fs.symlinkSync(outside,original+'-wal');
  const {snapshotNativeSqliteFiles}=require('../lib/cli/services/account/rekey-native-snapshot');
  await assert.rejects(snapshotNativeSqliteFiles(original,path.join(f.copy,'native.sqlite')), /native_file_unsafe/);
  await assert.rejects(copyRehearsalScope(f.source,f.copy,{metadataPaths:['../outside']}), /edit_path_invalid/);
  assert.equal(fs.readFileSync(outside,'utf8'),'unchanged');
});

test('OS-enforced readonly native capture needs no source SHM creation or production write permission', {
  skip: process.platform !== 'darwin'
}, t => {
  // The full safety harness is itself sandboxed. macOS refuses to install a
  // second sandbox in that process; report this specific OS limitation rather
  // than weakening file protection or pretending the native experiment ran.
  const capability=spawnSync('/usr/bin/sandbox-exec',['-p','(version 1)(allow default)',process.execPath,'-e','process.exit(0)'],{encoding:'utf8',timeout:5000});
  if(capability.status===71 && /sandbox_apply: Operation not permitted/.test(capability.stderr)) {
    t.skip('Host sandbox prohibits nested sandbox installation; verified in the native focused run');
    return;
  }
  assert.equal(capability.status,0,capability.stderr);
  const f=workspace(t),original=path.join(f.source,'native.sqlite'),target=path.join(f.copy,'native.sqlite');
  const writer=`const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(original)});
    db.exec("PRAGMA journal_mode=WAL;CREATE TABLE threads(id TEXT);INSERT INTO threads VALUES('source-thread')");process.exit(0);`;
  assert.equal(spawnSync(process.execPath,['-e',writer]).status,0);
  fs.unlinkSync(original+'-shm');
  const before=[original,original+'-wal'].map(file=>hashBackup(file));
  const driver=`const fs=require('node:fs');const {snapshotNativeSqliteFiles}=require(${JSON.stringify(path.resolve(__dirname,'../lib/cli/services/account/rekey-native-snapshot'))});
    (async()=>{let denied=false;try{const fd=fs.openSync(${JSON.stringify(original)},'r+');fs.closeSync(fd);}catch(e){denied=['EPERM','EACCES'].includes(e.code);}
    if(!denied)throw new Error('source_write_guard_missing');const receipt=await snapshotNativeSqliteFiles(${JSON.stringify(original)},${JSON.stringify(target)});
    process.stdout.write(JSON.stringify({sourceSqlOpened:receipt.sourceSqlOpened,stable:receipt.sourceFileVersionsUnchanged}));})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});`;
  const policy=`(version 1)(allow default)(deny network*)(deny file-write* (subpath ${JSON.stringify(f.source)}))`;
  const child=spawnSync('/usr/bin/sandbox-exec',['-p',policy,process.execPath,'-e',driver],{encoding:'utf8',timeout:15000});
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout),{sourceSqlOpened:false,stable:true});
  assert.deepEqual([original,original+'-wal'].map(file=>hashBackup(file)),before);
  assert.equal(fs.existsSync(original+'-shm'),false);
});
