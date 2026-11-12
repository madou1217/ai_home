'use strict';

// 额度快照读路径以 Go 为存储真相：app_kv 只保留采集暂存与本地缓存。
// 同一条快照两边都有时取采集时间较新的那份，保证「刚采集、还没同步」的数据不丢。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { writeJsonValue } = require('../lib/server/app-state-store');
const { readAccountUsageSnapshot, loadAccountUsageSnapshotReader } = require('../lib/account/usage-snapshot-store');

const REF_A = 'acct_aaaaaaaaaaaaaaaaaaaa';
const REF_B = 'acct_bbbbbbbbbbbbbbbbbbbb';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-usage-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeGoDocuments(dir, documents) {
  const db = new DatabaseSync(path.join(dir, 'aih.db'));
  db.exec('CREATE TABLE account_usage_snapshots (account_ref TEXT PRIMARY KEY, payload_json TEXT NOT NULL)');
  const statement = db.prepare('INSERT INTO account_usage_snapshots (account_ref, payload_json) VALUES (?, ?)');
  for (const [accountRef, payload] of Object.entries(documents)) {
    statement.run(accountRef, JSON.stringify(payload));
  }
  db.close();
}

test('a newer Go document wins over the local snapshot', (t) => {
  const dir = tmp(t);
  writeJsonValue(fs, dir, `account:usage:${REF_A}`, { kind: 'codex_oauth_status', capturedAt: 1000, marker: 'local' });
  writeJsonValue(fs, dir, `account:usage:${REF_B}`, { kind: 'codex_oauth_status', capturedAt: 3000, marker: 'local' });
  writeGoDocuments(dir, {
    [REF_A]: { kind: 'codex_oauth_status', capturedAt: 2000, marker: 'go' },
    [REF_B]: { kind: 'codex_oauth_status', capturedAt: 1000, marker: 'go' }
  });

  assert.equal(readAccountUsageSnapshot(fs, dir, REF_A).marker, 'go');
  assert.equal(readAccountUsageSnapshot(fs, dir, REF_B).marker, 'local');

  const reader = loadAccountUsageSnapshotReader(fs, dir);
  assert.equal(reader(REF_A).marker, 'go');
  assert.equal(reader(REF_B).marker, 'local');
});

test('without a Go database the local snapshot still works', (t) => {
  const dir = tmp(t);
  writeJsonValue(fs, dir, `account:usage:${REF_A}`, { kind: 'codex_oauth_status', capturedAt: 1000, marker: 'local' });
  assert.equal(readAccountUsageSnapshot(fs, dir, REF_A).marker, 'local');
  assert.equal(loadAccountUsageSnapshotReader(fs, dir)(REF_A).marker, 'local');
});

test('an invalid account ref reads as absent', (t) => {
  const dir = tmp(t);
  assert.equal(readAccountUsageSnapshot(fs, dir, 'not-a-ref'), null);
});
