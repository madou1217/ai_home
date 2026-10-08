'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  getOauthArtifactPath,
  hasOauthCompletionArtifacts,
  readOauthArtifactSignature
} = require('../lib/server/web-account-auth-oauth-tokens');
const { createAuthJobManager } = require('../lib/server/web-account-auth');
const { listAccountCredentialRecords, readAccountNativeAuth } = require('../lib/server/account-credential-store');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-web-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  return {
    root,
    job: { provider: 'kiro', runtimeDir, configDir: path.join(runtimeDir, '.kiro') }
  };
}

function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS auth_kv(key TEXT PRIMARY KEY, value TEXT)');
  return db;
}

function writeToken(db, access = 'access-one', refresh = 'refresh-one') {
  db.prepare('INSERT OR REPLACE INTO auth_kv(key, value) VALUES(?, ?)').run(
    'kirocli:odic:token',
    JSON.stringify({ access_token: access, refresh_token: refresh, region: 'us-east-1' })
  );
}

test('Kiro OAuth reads the account database at the runtime root, separate from KIRO_HOME', t => {
  const { job } = fixture(t);
  assert.equal(getOauthArtifactPath(job), path.join(job.runtimeDir, 'data.sqlite3'));
  const db = openDatabase(path.join(job.runtimeDir, 'data.sqlite3'));
  writeToken(db);
  db.close();
  assert.equal(hasOauthCompletionArtifacts(job, fs), true);
});

test('Kiro OAuth rejects empty, corrupt, and refresh-only databases', t => {
  const { job } = fixture(t);
  const file = path.join(job.runtimeDir, 'data.sqlite3');
  let db = openDatabase(file);
  db.close();
  assert.equal(hasOauthCompletionArtifacts(job, fs), false);
  db = openDatabase(file);
  writeToken(db, '', 'refresh-only');
  db.close();
  assert.equal(hasOauthCompletionArtifacts(job, fs), false);
  fs.writeFileSync(file, 'not a SQLite database');
  assert.equal(hasOauthCompletionArtifacts(job, fs), false);
});

test('Kiro OAuth freshness tracks the logical token, including committed WAL updates', t => {
  const { job } = fixture(t);
  const file = path.join(job.runtimeDir, 'data.sqlite3');
  const db = openDatabase(file);
  t.after(() => db.close());
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
  writeToken(db);
  job._requireFreshOauthArtifacts = true;
  job._oauthArtifactSignatureAtStart = readOauthArtifactSignature(job, fs);
  assert.ok(job._oauthArtifactSignatureAtStart);
  assert.equal(hasOauthCompletionArtifacts(job, fs), false);

  db.exec('CREATE TABLE settings(key TEXT, value TEXT); INSERT INTO settings VALUES(\'theme\', \'dark\')');
  assert.equal(readOauthArtifactSignature(job, fs), job._oauthArtifactSignatureAtStart);
  assert.equal(hasOauthCompletionArtifacts(job, fs), false, 'settings are not a new authorization');
  writeToken(db, 'access-two', 'refresh-two');
  assert.equal(fs.existsSync(`${file}-wal`), true);
  assert.equal(hasOauthCompletionArtifacts(job, fs), true);
});

test('a successful Kiro CLI login becomes a verified WebUI account, with polling safe during verification', async t => {
  const { root } = fixture(t);
  let onExit;
  let spawnCall;
  let respond;
  const replies = [];
  const manager = createAuthJobManager({
    fs,
    aiHomeDir: path.join(root, 'aih'),
    processObj: {
      env: { HOME: root, USERPROFILE: root, AIH_HOST_HOME: root, PATH: '' },
      platform: process.platform,
      cwd: () => root,
      kill() {}
    },
    resolveCliPathImpl: () => path.join(root, 'bin', 'kiro-cli'),
    ptyImpl: {
      spawn(command, args, options) {
        spawnCall = { command, args, options };
        return { pid: 12345, onData() {}, onExit(handler) { onExit = handler; }, kill() {} };
      }
    },
    fetchImpl: () => new Promise(resolve => { respond = resolve; }),
    onOauthJobFinished: job => replies.push(job.accountRef)
  });
  const started = manager.startOauthJob('kiro', 'oauth-browser');
  const job = manager.getJob(started.jobId);
  assert.equal(spawnCall.options.env.KIRO_TEST_DB_PATH, path.join(job.runtimeDir, 'data.sqlite3'));
  assert.equal(job.status, 'running');
  const db = openDatabase(spawnCall.options.env.KIRO_TEST_DB_PATH);
  writeToken(db);
  db.close();
  onExit({ exitCode: 0 });
  assert.equal(manager.getJob(started.jobId).status, 'running');
  assert.equal(listAccountCredentialRecords(fs, path.join(root, 'aih'), 'kiro').length, 0);
  assert.equal(typeof respond, 'function');
  respond(new Response(JSON.stringify({ userInfo: { userId: 'verified-builder-user' } })));
  await job._identityVerification;
  assert.equal(job.status, 'succeeded', job.error);
  assert.equal(job.authProgressState, 'completed');
  assert.equal(readAccountNativeAuth(fs, path.join(root, 'aih'), job.accountRef).auth.access_token, 'access-one');
  assert.deepEqual(replies, [job.accountRef]);
});
