'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { openAppStateDatabase } = require('../lib/server/app-state-store');
const { acquireAccountMaintenanceLock } = require('../lib/runtime/account-maintenance-lock');
const { acquireRekeyLease } = require('../lib/cli/services/account/rekey-lease');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-real-rw-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = openAppStateDatabase(fs, root); db.close();
  return root;
}

function childAttempt(root, exclusive) {
  const modulePath = path.resolve(__dirname, '../lib/runtime/account-maintenance-lock');
  const script = `const fs=require('node:fs'); const m=require(${JSON.stringify(modulePath)});
    try {const lease=m.acquireAccountMaintenanceLock(fs,${JSON.stringify(root)},{exclusive:${exclusive},timeoutMs:50});lease.close();process.stdout.write('acquired');}
    catch(error){process.stdout.write(error.message);process.exitCode=2;}`;
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 });
}

test('a real shared connection blocks maintenance until close; concurrent readers remain available', t => {
  const root = fixture(t), db = openAppStateDatabase(fs, root);
  assert.equal(childAttempt(root, false).stdout, 'acquired');
  const blocked = childAttempt(root, true);
  assert.equal(blocked.status, 2); assert.equal(blocked.stdout, 'account_maintenance_busy');
  db.close();
  assert.equal(childAttempt(root, true).stdout, 'acquired');
});

test('an exclusive OS lock blocks a reader even without a gate file', t => {
  const root = fixture(t), lease = acquireAccountMaintenanceLock(fs, root, { exclusive: true });
  try {
    const blocked = childAttempt(root, false);
    assert.equal(blocked.status, 2); assert.equal(blocked.stdout, 'account_maintenance_busy');
  } finally { lease.close(); }
  assert.equal(childAttempt(root, false).stdout, 'acquired');
});

test('process death releases OS ownership but leaves the durable recovery gate', t => {
  const root = fixture(t);
  const modulePath = path.resolve(__dirname, '../lib/cli/services/account/rekey-lease');
  const crashed = spawnSync(process.execPath, ['-e', `const m=require(${JSON.stringify(modulePath)});
    m.acquireRekeyLease(${JSON.stringify(root)},{assertQuiet(){}});process.exit(77);`], { encoding: 'utf8', timeout: 5000 });
  assert.equal(crashed.status, 77, crashed.stderr);
  const recovered = acquireRekeyLease(root, { recover: true, assertQuiet() {} });
  try {
    const competitor = spawnSync(process.execPath, ['-e', `const m=require(${JSON.stringify(modulePath)});
      try {m.acquireRekeyLease(${JSON.stringify(root)},{recover:true,assertQuiet(){}});process.exit(3)}
      catch(error){process.stdout.write(error.message);process.exit(2)}`], { encoding: 'utf8', timeout: 5000 });
    assert.equal(competitor.status, 2); assert.equal(competitor.stdout, 'account_maintenance_busy');
  } finally { recovered.release(); }
});

test('a writer paused before app-state open still excludes a concurrent migration', async t => {
  const root = fixture(t);
  const modulePath = path.resolve(__dirname, '../lib/runtime/account-maintenance-lock');
  const child = spawn(process.execPath, ['-e', `const fs=require('node:fs'); const m=require(${JSON.stringify(modulePath)});
    const lease=m.acquireAccountMaintenanceLock(fs,${JSON.stringify(root)});process.stdout.write('ready\\n');
    process.stdin.once('data',()=>{lease.close();process.exit(0)});`], { stdio: ['pipe','pipe','pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture readiness timeout')), 3000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', reject);
  });
  assert.throws(() => acquireRekeyLease(root, { assertQuiet() {} }), /account_maintenance_busy/);
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdin.end('release'); await exited;
  const lease = acquireRekeyLease(root, { assertQuiet() {} }); lease.release();
});

test('pre-lease detached runtime detection rejects only mapped accounts and never echoes argv', () => {
  const { assertNoMappedRuntimeProcesses } = require('../lib/cli/services/account/rekey-lease');
  const ref='acct_aaaaaaaaaaaaaaaaaaaa';
  assert.throws(() => assertNoMappedRuntimeProcesses([[ref,'unused']],{execFileSync(){return `99999 codex --scope ${ref} --secret hidden\n`;}}), error => error.message === 'rekey_runtime_process_active' && !error.message.includes('hidden'));
  assert.doesNotThrow(() => assertNoMappedRuntimeProcesses([[ref,'unused']],{execFileSync(){return '99999 codex --scope acct_bbbbbbbbbbbbbbbbbbbb\n';}}));
  assert.throws(() => assertNoMappedRuntimeProcesses([[ref,'unused']],{execFileSync(){throw new Error('failed');}}), /quiescence_unverifiable/);
});
