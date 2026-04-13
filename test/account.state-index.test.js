const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAccountStateIndex } = require('../lib/account/state-index');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-state-'));
}

test('account state index upserts and lists merged ids deterministically', () => {
  const root = mkTmpDir();
  try {
    const index = createAccountStateIndex({ aiHomeDir: root, fs });
    index.upsertAccountState('codex', '2', { configured: true, exhausted: false, remainingPct: 12 });
    index.upsertAccountState('codex', '1', { configured: true, exhausted: false, remainingPct: 90 });
    index.upsertAccountState('codex', '3', { configured: true, exhausted: true, remainingPct: 0 });
    assert.deepEqual(index.listAccountIds('codex'), ['1', '2', '3']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('account state index chooses next candidate by remaining usage then id', () => {
  const root = mkTmpDir();
  try {
    const index = createAccountStateIndex({ aiHomeDir: root, fs });
    index.upsertAccountState('codex', '10', { configured: true, exhausted: false, remainingPct: 80 });
    index.upsertAccountState('codex', '2', { configured: true, exhausted: false, remainingPct: 80 });
    index.upsertAccountState('codex', '8', { configured: true, exhausted: true, remainingPct: 99 });
    index.upsertAccountState('codex', '9', { configured: false, exhausted: false, remainingPct: 99 });
    assert.equal(index.getNextCandidateId('codex', ''), '2');
    assert.equal(index.getNextCandidateId('codex', '2'), '10');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('account state index exposes usage/configured/stale selectors', () => {
  const root = mkTmpDir();
  try {
    const index = createAccountStateIndex({ aiHomeDir: root, fs });
    index.upsertAccountState('gemini', '1', { configured: true, apiKeyMode: true, exhausted: false, remainingPct: 90 });
    index.upsertAccountState('gemini', '2', { configured: true, apiKeyMode: false, exhausted: false, remainingPct: 50 });
    index.upsertAccountState('gemini', '3', { configured: false, apiKeyMode: false, exhausted: false, remainingPct: 100 });

    assert.deepEqual(index.listConfiguredIds('gemini'), ['1', '2']);
    assert.deepEqual(index.listUsageCandidateIds('gemini'), ['2']);
    assert.ok(index.listStaleIds('gemini', Date.now() + 60 * 1000, 10).length >= 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('account state index stores and returns display name', () => {
  const root = mkTmpDir();
  try {
    const index = createAccountStateIndex({ aiHomeDir: root, fs });
    index.upsertAccountState('codex', '1', {
      configured: true,
      apiKeyMode: false,
      exhausted: false,
      remainingPct: 90,
      displayName: 'user@example.com'
    });
    const rows = index.listStates('codex');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].displayName, 'user@example.com');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('account state index stores and returns persisted runtime state', () => {
  const root = mkTmpDir();
  try {
    const index = createAccountStateIndex({ aiHomeDir: root, fs });
    index.upsertRuntimeState('codex', '1', {
      authInvalidUntil: 123456,
      lastFailureKind: 'auth_invalid',
      lastFailureReason: 'upstream_401'
    }, {
      configured: true,
      apiKeyMode: false,
      displayName: 'user@example.com'
    });
    const row = index.getAccountState('codex', '1');
    assert.deepEqual(row.runtime_state, {
      authInvalidUntil: 123456,
      lastFailureKind: 'auth_invalid',
      lastFailureReason: 'upstream_401'
    });
    const listRow = index.listStates('codex')[0];
    assert.deepEqual(listRow.runtimeState, {
      authInvalidUntil: 123456,
      lastFailureKind: 'auth_invalid',
      lastFailureReason: 'upstream_401'
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('account state index upsertRuntimeState can clear persisted runtime state', () => {
  const root = mkTmpDir();
  try {
    const index = createAccountStateIndex({ aiHomeDir: root, fs });
    index.upsertRuntimeState('codex', '1', {
      authInvalidUntil: 123456,
      lastFailureKind: 'auth_invalid',
      lastFailureReason: 'upstream_401'
    }, {
      configured: true,
      apiKeyMode: false,
      displayName: 'user@example.com'
    });
    index.upsertRuntimeState('codex', '1', null, {
      configured: true,
      apiKeyMode: false,
      authMode: 'oauth-browser',
      displayName: 'user@example.com'
    });
    const row = index.getAccountState('codex', '1');
    assert.equal(row.runtime_state, null);
    assert.equal(row.auth_mode, 'oauth-browser');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('account state index setExhausted does not create phantom rows', () => {
  const root = mkTmpDir();
  try {
    const index = createAccountStateIndex({ aiHomeDir: root, fs });
    const changed = index.setExhausted('codex', '999', true);
    assert.equal(changed, false);
    assert.deepEqual(index.listAccountIds('codex'), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('account state index prunes missing ids deterministically', () => {
  const root = mkTmpDir();
  try {
    const index = createAccountStateIndex({ aiHomeDir: root, fs });
    index.upsertAccountState('codex', '1', { configured: true, exhausted: false, remainingPct: 50 });
    index.upsertAccountState('codex', '2', { configured: true, exhausted: false, remainingPct: 80 });
    const removed = index.pruneMissingIds('codex', ['2']);
    assert.equal(removed, 1);
    assert.deepEqual(index.listAccountIds('codex'), ['2']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('account state index deletes one account deterministically', () => {
  const root = mkTmpDir();
  try {
    const index = createAccountStateIndex({ aiHomeDir: root, fs });
    index.upsertAccountState('codex', '1', { configured: true, exhausted: false, remainingPct: 50 });
    index.upsertAccountState('codex', '2', { configured: true, exhausted: false, remainingPct: 80 });
    assert.equal(index.deleteAccountState('codex', '1'), true);
    assert.equal(index.deleteAccountState('codex', '1'), false);
    assert.deepEqual(index.listAccountIds('codex'), ['2']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
