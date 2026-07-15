const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAccountStateIndex } = require('../lib/account/state-index');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { openAppStateDatabase } = require('../lib/server/app-state-store');

function createFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-state-'));
  const index = createAccountStateIndex({ aiHomeDir, fs });
  assert.equal(fs.statSync(path.join(aiHomeDir, 'app-state.db')).mode & 0o777, 0o600);
  t.after(() => {
    index.close();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  return {
    index,
    register(provider, cliAccountId) {
      return registerAccountIdentity(fs, aiHomeDir, {
        provider,
        cliAccountId,
        identitySeed: `oauth:${provider}:state-${cliAccountId}@example.com`
      }).accountRef;
    }
  };
}

test('account state index upserts and lists account refs deterministically', (t) => {
  const { index, register } = createFixture(t);
  const refs = ['2', '1', '3'].map((cliAccountId) => register('codex', cliAccountId));
  index.upsertAccountState(refs[0], 'codex', { configured: true, remainingPct: 12 });
  index.upsertAccountState(refs[1], 'codex', { configured: true, remainingPct: 90 });
  index.upsertAccountState(refs[2], 'codex', { configured: true, remainingPct: 0 });
  assert.deepEqual(index.listAccountRefs('codex'), refs.toSorted());
});

test('account state index chooses next candidate by remaining usage then account ref', (t) => {
  const { index, register } = createFixture(t);
  const ref10 = register('codex', '10');
  const ref2 = register('codex', '2');
  const ref8 = register('codex', '8');
  const ref9 = register('codex', '9');
  index.upsertAccountState(ref10, 'codex', { configured: true, remainingPct: 80 });
  index.upsertAccountState(ref2, 'codex', { configured: true, remainingPct: 80 });
  index.upsertAccountState(ref8, 'codex', { configured: true, remainingPct: 99 });
  index.upsertAccountState(ref9, 'codex', { configured: false, remainingPct: 99 });
  assert.equal(index.getNextCandidateRef('codex'), ref8);
  assert.equal(index.getNextCandidateRef('codex', ref8), [ref10, ref2].toSorted()[0]);
});

test('account state index excludes runtime-blocked candidates before CLI switching', (t) => {
  const { index, register } = createFixture(t);
  const blockedRef = register('codex', '8');
  const availableRef = register('codex', '2');
  const blockedUntil = Date.now() + 60_000;
  index.upsertAccountState(blockedRef, 'codex', { configured: true, remainingPct: 99 });
  index.upsertAccountState(availableRef, 'codex', { configured: true, remainingPct: 80 });
  index.upsertRuntimeState(blockedRef, 'codex', {
    cooldownUntil: blockedUntil,
    rateLimitUntil: blockedUntil,
    lastFailureKind: 'rate_limited',
    lastFailureReason: 'usage_limit_reached'
  }, {
    configured: true,
    apiKeyMode: false
  });

  assert.equal(index.getNextCandidateRef('codex'), availableRef);
});

test('account state index exposes usage, configured, and stale ref selectors', (t) => {
  const { index, register } = createFixture(t);
  const configuredRef = register('gemini', '1');
  const downRef = register('gemini', '2');
  const unconfiguredRef = register('gemini', '3');
  index.upsertAccountState(configuredRef, 'gemini', { configured: true, apiKeyMode: true, remainingPct: 90 });
  index.upsertAccountState(downRef, 'gemini', { status: 'down', configured: true, apiKeyMode: false, remainingPct: 50 });
  index.upsertAccountState(unconfiguredRef, 'gemini', { configured: false, apiKeyMode: false, remainingPct: 100 });

  assert.deepEqual(index.listConfiguredRefs('gemini'), [configuredRef]);
  assert.deepEqual(index.listUsageCandidateRefs('gemini'), []);
  assert.deepEqual(
    index.listStaleRefs('gemini', Date.now() + 60_000, 10).toSorted(),
    [configuredRef, downRef, unconfiguredRef].toSorted()
  );
});

test('account state index defaults status to up and allows toggling down', (t) => {
  const { index, register } = createFixture(t);
  const accountRef = register('codex', '1');
  index.upsertAccountState(accountRef, 'codex', { configured: true });
  assert.equal(index.getAccountState(accountRef).status, 'up');
  assert.equal(index.setStatus(accountRef, 'down'), true);
  assert.equal(index.getAccountState(accountRef).status, 'down');
  assert.equal(index.getNextCandidateRef('codex'), null);
});

test('account state index preserves down status when account upsert omits status', (t) => {
  const { index, register } = createFixture(t);
  const accountRef = register('codex', '1');
  index.upsertAccountState(accountRef, 'codex', {
      status: 'down',
      configured: true,
      remainingPct: 20
  });
  index.upsertAccountState(accountRef, 'codex', {
      configured: true,
      remainingPct: 80
  });
  const row = index.getAccountState(accountRef);
  assert.equal(row.accountRef, accountRef);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'account_ref'), false);
  assert.equal(row.status, 'down');
  assert.equal(row.remainingPct, 80);
});

test('account state index keeps null remaining usage as unknown instead of exhausted', (t) => {
  const { index, register } = createFixture(t);
  const accountRef = register('codex', '1');
  index.upsertAccountState(accountRef, 'codex', {
      configured: true,
      apiKeyMode: false,
      remainingPct: 80
  });
  index.upsertAccountState(accountRef, 'codex', {
      configured: true,
      apiKeyMode: false,
      remainingPct: null
  });
  assert.equal(index.getAccountState(accountRef).remainingPct, null);
});

test('account state index stores and returns display name', (t) => {
  const { index, register } = createFixture(t);
  const accountRef = register('codex', '1');
  index.upsertAccountState(accountRef, 'codex', {
      configured: true,
      apiKeyMode: false,
      remainingPct: 90,
      displayName: 'user@example.com'
  });
  const rows = index.listStates('codex');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].displayName, 'user@example.com');
});

test('account state index preserves down status when runtime upsert omits status', (t) => {
  const { index, register } = createFixture(t);
  const accountRef = register('codex', '1');
  index.upsertAccountState(accountRef, 'codex', {
      status: 'down',
      configured: true,
      apiKeyMode: false,
      remainingPct: 20,
      displayName: 'user@example.com'
  });
  index.upsertRuntimeState(accountRef, 'codex', {
      authInvalidUntil: 123456,
      lastFailureKind: 'auth_invalid'
  }, {
      configured: true,
      apiKeyMode: false,
      displayName: 'user@example.com'
  });
  const row = index.getAccountState(accountRef);
  assert.equal(row.status, 'down');
  assert.deepEqual(row.runtimeState, {
    authInvalidUntil: 123456,
    lastFailureKind: 'auth_invalid'
  });
});

test('account state index stores and returns persisted runtime state', (t) => {
  const { index, register } = createFixture(t);
  const accountRef = register('codex', '1');
  index.upsertRuntimeState(accountRef, 'codex', {
      authInvalidUntil: 123456,
      lastFailureKind: 'auth_invalid',
      lastFailureReason: 'upstream_401'
  }, {
      configured: true,
      apiKeyMode: false,
      displayName: 'user@example.com'
  });
  const expectedRuntimeState = {
    authInvalidUntil: 123456,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'upstream_401'
  };
  assert.deepEqual(index.getAccountState(accountRef).runtimeState, expectedRuntimeState);
  assert.deepEqual(index.listStates('codex')[0].runtimeState, expectedRuntimeState);
});

test('account state index upsertRuntimeState can clear persisted runtime state', (t) => {
  const { index, register } = createFixture(t);
  const accountRef = register('codex', '1');
  index.upsertRuntimeState(accountRef, 'codex', {
      authInvalidUntil: 123456,
      lastFailureKind: 'auth_invalid',
      lastFailureReason: 'upstream_401'
  }, {
      configured: true,
      apiKeyMode: false,
      displayName: 'user@example.com'
  });
  index.upsertRuntimeState(accountRef, 'codex', null, {
      configured: true,
      apiKeyMode: false,
      authMode: 'oauth-browser',
      displayName: 'user@example.com'
  });
  const row = index.getAccountState(accountRef);
  assert.equal(row.runtimeState, null);
  assert.equal(row.authMode, 'oauth-browser');
});

test('account state index setStatus does not create phantom rows', (t) => {
  const { index, register } = createFixture(t);
  const accountRef = register('codex', '999');
  assert.equal(index.setStatus(accountRef, 'down'), false);
  assert.deepEqual(index.listAccountRefs('codex'), []);
});

test('account state index prunes missing refs deterministically', (t) => {
  const { index, register } = createFixture(t);
  const removedRef = register('codex', '1');
  const retainedRef = register('codex', '2');
  index.upsertAccountState(removedRef, 'codex', { configured: true, remainingPct: 50 });
  index.upsertAccountState(retainedRef, 'codex', { configured: true, remainingPct: 80 });
  assert.equal(index.pruneMissingRefs('codex', [retainedRef]), 1);
  assert.deepEqual(index.listAccountRefs('codex'), [retainedRef]);
});

test('account state index deletes one account deterministically', (t) => {
  const { index, register } = createFixture(t);
  const deletedRef = register('codex', '1');
  const retainedRef = register('codex', '2');
  index.upsertAccountState(deletedRef, 'codex', { configured: true, remainingPct: 50 });
  index.upsertAccountState(retainedRef, 'codex', { configured: true, remainingPct: 80 });
  assert.equal(index.deleteAccountState(deletedRef), true);
  assert.equal(index.deleteAccountState(deletedRef), false);
  assert.deepEqual(index.listAccountRefs('codex'), [retainedRef]);
});

test('account state index rejects legacy account_id schema without mutating it', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-state-schema-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: 'oauth:codex:legacy-state@example.com'
  });
  const db = openAppStateDatabase(fs, aiHomeDir);
  try {
    db.exec(`
      CREATE TABLE account_state (
        account_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.prepare(`
      INSERT INTO account_state (account_id, provider, status, updated_at)
      VALUES (?, ?, ?, ?)
    `).run('1', 'codex', 'up', 456);
  } finally {
    db.close();
  }

  assert.throws(
    () => createAccountStateIndex({ aiHomeDir, fs }),
    /account_state_schema_invalid/
  );

  const { DatabaseSync } = require('node:sqlite');
  const inspectionDb = new DatabaseSync(path.join(aiHomeDir, 'app-state.db'));
  try {
    assert.deepEqual(
      inspectionDb.prepare('PRAGMA table_info(account_state)').all().map((row) => row.name),
      ['account_id', 'provider', 'status', 'updated_at']
    );
    assert.deepEqual(
      inspectionDb.prepare('SELECT * FROM account_state').all().map((row) => ({ ...row })),
      [{ account_id: '1', provider: 'codex', status: 'up', updated_at: 456 }]
    );
  } finally {
    inspectionDb.close();
  }
});
