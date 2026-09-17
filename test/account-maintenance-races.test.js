'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { openAppStateDatabase } = require('../lib/server/app-state-store');
const { maintenanceGatePath } = require('../lib/runtime/account-maintenance-gate');
const { acquireAccountMaintenanceLock, holdAccountProcessLease } = require('../lib/runtime/account-maintenance-lock');
const { acquireRekeyLease } = require('../lib/cli/services/account/rekey-lease');

const lockModule = path.resolve(__dirname, '../lib/runtime/account-maintenance-lock');
const storeModule = path.resolve(__dirname, '../lib/server/app-state-store');
const leaseModule = path.resolve(__dirname, '../lib/cli/services/account/rekey-lease');

function fixture(t, initialized = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-lock-race-'));
  const children = new Set();
  const resources = [];
  if (initialized) openAppStateDatabase(fs, root).close();
  t.after(async () => {
    for (const close of resources.reverse()) close();
    await Promise.all([...children].map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill('SIGKILL');
    })));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, children, resources };
}

function isolatedEnv(root) {
  return { PATH: process.env.PATH, HOME: root, USERPROFILE: root, REAL_HOME: root,
    AIH_HOST_HOME: root, AIH_HOME: root, NODE_NO_WARNINGS: '1' };
}

function attempt(root, body) {
  return spawnSync(process.execPath, ['-e', `
    const fs=require('node:fs'); const {DatabaseSync}=require('node:sqlite');
    const locks=require(${JSON.stringify(lockModule)}); const store=require(${JSON.stringify(storeModule)});
    const root=process.argv[1];
    try { ${body}; process.stdout.write('acquired'); }
    catch(error) { process.stdout.write(error.code || error.message); process.exitCode=2; }
  `, root], { env: isolatedEnv(root), encoding: 'utf8', timeout: 8000 });
}

/** Readiness is acknowledged after the OS lock is held, not after a timer. */
async function worker(f) {
  const child = spawn(process.execPath, ['-e', `
    const fs=require('node:fs'); const locks=require(${JSON.stringify(lockModule)});
    const leases=require(${JSON.stringify(leaseModule)}); const store=require(${JSON.stringify(storeModule)});
    const root=process.argv[1]; let held;
    process.on('message', ({id,action}) => {
      try {
        if (action==='shared') held=locks.acquireAccountMaintenanceLock(fs,root,{timeoutMs:2000});
        else if (action==='process') held=locks.holdAccountProcessLease(fs,root);
        else if (action==='database') held=store.openAppStateDatabase(fs,root);
        else if (action==='exclusive') held=leases.acquireRekeyLease(root,{assertQuiet(){}});
        else if (action==='recover') held=leases.acquireRekeyLease(root,{recover:true,assertQuiet(){}});
        else if (action==='release') { if(held.release) held.release(); else held.close(); held=undefined; }
        else throw new Error('unknown_test_action');
        process.send({id,ok:true});
      } catch(error) { process.send({id,ok:false,error:error.code||error.message}); }
    });
    process.send({ready:true});
  `, f.root], { env: isolatedEnv(f.root), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  f.children.add(child);
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-2000); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker readiness timeout')), 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`worker exited before ready: ${stderr}`)); });
    child.once('message', message => { clearTimeout(timer); message.ready ? resolve() : reject(new Error('invalid readiness')); });
  });
  let sequence = 0;
  return {
    child,
    request(action) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { child.off('message', receive); reject(new Error(`worker request timed out: ${action}`)); }, 6000);
        function receive(message) {
          if (message.id !== id) return;
          clearTimeout(timer); child.off('message', receive); resolve(message);
        }
        child.on('message', receive); child.send({id,action});
      });
    }
  };
}

test('explicit native SQLite constructor injection still participates in the OS lock', t => {
  const f = fixture(t);
  const held = acquireAccountMaintenanceLock(fs, f.root, { exclusive: true });
  f.resources.push(() => held.close());
  const result = attempt(f.root, 'store.openAppStateDatabase(fs,root,{DatabaseSync}).close()');
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /account_maintenance_busy/);
});

test('failed process lease registration is removed and cannot become an unlocked cached success', t => {
  const f = fixture(t);
  const processObj = new EventEmitter();
  f.resources.push(() => processObj.emit('exit'));
  const gate = maintenanceGatePath(f.root); fs.mkdirSync(gate);
  assert.throws(() => holdAccountProcessLease(fs, f.root, processObj), /maintenance_in_progress/);
  fs.rmdirSync(gate);
  holdAccountProcessLease(fs, f.root, processObj);
  const result = attempt(f.root, 'const h=locks.acquireAccountMaintenanceLock(fs,root,{exclusive:true,timeoutMs:50});h.close()');
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /account_maintenance_busy/);
});

test('a closed old process handle cannot delete a later lease registration', t => {
  const f = fixture(t);
  const processObj = new EventEmitter();
  f.resources.push(() => processObj.emit('exit'));
  const first = holdAccountProcessLease(fs, f.root, processObj);
  first.close();
  const second = holdAccountProcessLease(fs, f.root, processObj);
  first.close();
  assert.equal(holdAccountProcessLease(fs, f.root, processObj), second);
});

test('a failing native connection close does not release its maintenance exclusion early', t => {
  const f = fixture(t);
  let failClose = true;
  class FailsOnce extends DatabaseSync {
    close() {
      if (failClose) throw new Error('fixture_connection_still_open');
      return super.close();
    }
  }
  const db = openAppStateDatabase(fs, f.root, { DatabaseSync: FailsOnce });
  f.resources.push(() => { failClose = false; try { db.close(); } catch (_) {} });
  assert.throws(() => db.close(), /fixture_connection_still_open/);
  const result = attempt(f.root, 'const h=locks.acquireAccountMaintenanceLock(fs,root,{exclusive:true,timeoutMs:50});h.close()');
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /account_maintenance_busy/);
  failClose = false; db.close();
  assert.equal(attempt(f.root, 'const h=locks.acquireAccountMaintenanceLock(fs,root,{exclusive:true,timeoutMs:50});h.close()').status, 0);
});

test('two recoveries serialize owner changes and a competing normal database open stays excluded', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const crash = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(leaseModule)}).acquireRekeyLease(process.argv[1],{assertQuiet(){}});process.exit(77);`, f.root],
    { env: isolatedEnv(f.root), encoding: 'utf8', timeout: 5000 });
  assert.equal(crash.status, 77, crash.stderr);
  const first = await worker(f), second = await worker(f), normal = await worker(f);
  assert.equal((await first.request('recover')).ok, true);
  const ownerBefore = fs.readFileSync(path.join(maintenanceGatePath(f.root), 'owner.json'));
  const rejected = await second.request('recover');
  assert.equal(rejected.ok, false); assert.match(rejected.error, /account_maintenance_busy/);
  assert.deepEqual(fs.readFileSync(path.join(maintenanceGatePath(f.root), 'owner.json')), ownerBefore);
  assert.equal((await normal.request('database')).ok, false);
  assert.equal((await first.request('release')).ok, true);
  assert.equal((await second.request('recover')).ok, true);
  assert.equal((await second.request('release')).ok, true);
  assert.equal((await normal.request('database')).ok, true);
  assert.equal((await normal.request('release')).ok, true);
});

test('a process lease outlives individual database calls and excludes migration until process exit', { timeout: 15000 }, async t => {
  const f = fixture(t), normal = await worker(f);
  assert.equal((await normal.request('process')).ok, true);
  const before = attempt(f.root, 'const h=locks.acquireAccountMaintenanceLock(fs,root,{exclusive:true,timeoutMs:50});h.close()');
  assert.equal(before.status, 2);
  const exited = new Promise(resolve => normal.child.once('exit', resolve));
  normal.child.kill('SIGKILL'); await exited;
  const after = acquireRekeyLease(f.root, { assertQuiet() {} }); after.release();
});

test('first-use concurrent readers can initialize one lock store without missing a lease row', { timeout: 20000 }, async t => {
  const f = fixture(t, false);
  const readers = await Promise.all(Array.from({length:4}, () => worker(f)));
  const results = await Promise.all(readers.map(reader => reader.request('shared')));
  for (const result of results) assert.equal(result.ok, true, result.error);
  const excluded = attempt(f.root, 'const h=locks.acquireAccountMaintenanceLock(fs,root,{exclusive:true,timeoutMs:50});h.close()');
  assert.equal(excluded.status, 2);
  for (const reader of readers) assert.equal((await reader.request('release')).ok, true);
  const acquired = acquireAccountMaintenanceLock(fs, f.root, { exclusive:true }); acquired.close();
});

test('SIGKILL preserves the recovery gate and simultaneous recoveries have exactly one winner', { timeout: 20000 }, async t => {
  const f = fixture(t), owner = await worker(f);
  assert.equal((await owner.request('exclusive')).ok, true);
  const exited = new Promise(resolve => owner.child.once('exit', resolve));
  owner.child.kill('SIGKILL'); await exited;
  // The kernel releases its lock; that is not proof that data migration ended.
  assert.throws(() => openAppStateDatabase(fs, f.root), /maintenance_in_progress/);
  const first = await worker(f), second = await worker(f);
  const results = await Promise.all([first.request('recover'), second.request('recover')]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => !result.ok && /account_maintenance_busy/.test(result.error)).length, 1);
  const winner = results[0].ok ? first : second;
  assert.equal((await winner.request('release')).ok, true);
  openAppStateDatabase(fs, f.root).close();
});

test('regular CLI fails before account writes during exclusive maintenance; dedicated lease entry has no self-upgrade', t => {
  const f = fixture(t), lease = acquireRekeyLease(f.root, { assertQuiet() {} });
  const before = fs.readFileSync(path.join(f.root, 'app-state.db'));
  try {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/ai-home.js'), '--help'], {
      env: isolatedEnv(f.root), encoding: 'utf8', timeout: 10000
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /account_maintenance_in_progress|account_maintenance_busy/);
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'app-state.db')), before);
  } finally { lease.release(); }
  const result = spawnSync(process.execPath, ['-e', `
    const m=require(${JSON.stringify(leaseModule)});
    const h=m.acquireRekeyLease(process.argv[1],{assertQuiet(){}});h.release();
    if(require.cache[${JSON.stringify(path.resolve(__dirname, '../lib/cli/app.js'))}])process.exit(3);
  `, f.root], { env: isolatedEnv(f.root), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
});

test('failed real SQLite construction releases its preliminary lock and can be retried', t => {
  const f = fixture(t);
  class ConstructorFailure extends DatabaseSync {
    constructor(file) { throw new Error('fixture_constructor_failed'); }
  }
  assert.throws(() => openAppStateDatabase(fs, f.root, { DatabaseSync: ConstructorFailure }), /fixture_constructor_failed/);
  const lease = acquireAccountMaintenanceLock(fs, f.root, { exclusive: true }); lease.close();
  openAppStateDatabase(fs, f.root).close();
});

test('fresh HOME readonly checks stay side-effect free, and explicit close removes the exit listener', t => {
  const f = fixture(t, false), root = path.join(f.root, 'not-created');
  const processObj = new EventEmitter();
  const held = holdAccountProcessLease(fs, root, processObj);
  f.resources.push(() => held.close());
  assert.equal(fs.existsSync(root), false);
  assert.equal(openAppStateDatabase(fs, root, { createIfMissing:false }), null);
  assert.equal(fs.existsSync(root), false);
  assert.equal(processObj.listenerCount('exit'), 1);
  held.close(); held.close();
  assert.equal(processObj.listenerCount('exit'), 0);
});

test('invalid timeout/lock mode and foreign lock files fail without rewriting them', t => {
  const f = fixture(t);
  for (const options of [{timeoutMs:-1}, {timeoutMs:'0; DROP TABLE lease'}, {timeoutMs:Infinity}, {exclusive:'yes'}]) {
    assert.throws(() => acquireAccountMaintenanceLock(fs,f.root,options), /maintenance_lock_options_invalid/);
  }
  const file = path.join(f.root,'run/maintenance/access.sqlite');
  const db = new DatabaseSync(file); db.exec('DROP TABLE lease; CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES(\'keep\')'); db.close();
  assert.throws(() => acquireAccountMaintenanceLock(fs,f.root), /maintenance_lock_schema_invalid/);
  const check = new DatabaseSync(file,{readOnly:true});
  try { assert.equal(check.prepare('SELECT value FROM unrelated').get().value,'keep'); }
  finally { check.close(); }
});

test('portable normal read locking does not require fsync on a directory', t => {
  const f = fixture(t);
  const io = Object.create(fs);
  io.fsyncSync = () => { throw new Error('directory_fsync_not_supported'); };
  const lease = acquireAccountMaintenanceLock(io, f.root);
  lease.close();
});
