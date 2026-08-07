'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createClaudeHostCredentialReconciler
} = require('../lib/account/claude-host-credentials');

const ACCOUNT_REF = 'acct_1234567890abcdef1234';

function credentials(email, accessToken, refreshToken = `${accessToken}-refresh`) {
  return {
    claudeAiOauth: {
      email,
      accessToken,
      refreshToken
    }
  };
}

function credentialRecord(value, updatedAt) {
  return {
    provider: 'claude',
    accountRef: ACCOUNT_REF,
    nativeAuth: { credentials: value, marker: 'preserved' },
    nativeAuthUpdatedAt: updatedAt
  };
}

test('newer keychain credentials update the same DB account identity', () => {
  const databaseCredentials = credentials('same@example.com', 'db-token');
  const keychainCredentials = credentials('same@example.com', 'keychain-token');
  const databaseWrites = [];
  const keychainWrites = [];
  const reconcile = createClaudeHostCredentialReconciler({
    processObj: { platform: 'darwin' },
    hostHomeDir: '/Users/model',
    readClaudeKeychainCredentialRecord: () => ({
      credentials: keychainCredentials,
      modifiedAtMs: 200
    }),
    writeClaudeKeychainCredentials: (value) => {
      keychainWrites.push(value);
      return { ok: true };
    },
    writeAccountNativeAuth: (_fs, _aiHomeDir, accountRef, nativeAuth) => {
      databaseWrites.push({ accountRef, nativeAuth });
      return true;
    }
  });

  const result = reconcile(credentialRecord(databaseCredentials, 100));

  assert.equal(result.ok, true);
  assert.equal(result.source, 'keychain');
  assert.deepEqual(result.credentials, keychainCredentials);
  assert.deepEqual(keychainWrites, []);
  assert.deepEqual(databaseWrites, [{
    accountRef: ACCOUNT_REF,
    nativeAuth: {
      credentials: keychainCredentials,
      marker: 'preserved'
    }
  }]);
});

test('an unrelated shared keychain identity never overwrites the selected DB account', () => {
  const databaseCredentials = credentials('selected@example.com', 'selected-token');
  const keychainCredentials = credentials('other@example.com', 'other-token');
  const databaseWrites = [];
  const keychainWrites = [];
  const reconcile = createClaudeHostCredentialReconciler({
    processObj: { platform: 'darwin' },
    hostHomeDir: '/Users/model',
    readClaudeKeychainCredentialRecord: () => ({
      credentials: keychainCredentials,
      modifiedAtMs: 999
    }),
    writeClaudeKeychainCredentials: (value) => {
      keychainWrites.push(value);
      return { ok: true };
    },
    writeAccountNativeAuth: (...args) => databaseWrites.push(args)
  });

  const result = reconcile(credentialRecord(databaseCredentials, 100));

  assert.equal(result.ok, true);
  assert.equal(result.source, 'database');
  assert.equal(result.reason, 'keychain_identity_mismatch');
  assert.deepEqual(databaseWrites, []);
  assert.deepEqual(keychainWrites, [databaseCredentials]);
});

test('incomplete keychain OAuth data cannot replace usable DB credentials', () => {
  const databaseCredentials = credentials('same@example.com', 'db-token');
  const keychainCredentials = credentials('same@example.com', 'keychain-token', '');
  const keychainWrites = [];
  const reconcile = createClaudeHostCredentialReconciler({
    processObj: { platform: 'darwin' },
    hostHomeDir: '/Users/model',
    readClaudeKeychainCredentialRecord: () => ({
      credentials: keychainCredentials,
      modifiedAtMs: 999
    }),
    writeClaudeKeychainCredentials: (value) => {
      keychainWrites.push(value);
      return { ok: true };
    },
    writeAccountNativeAuth: () => assert.fail('must not overwrite DB credentials')
  });

  const result = reconcile(credentialRecord(databaseCredentials, 100));

  assert.equal(result.ok, true);
  assert.equal(result.source, 'database');
  assert.equal(result.reason, 'keychain_credentials_incomplete');
  assert.deepEqual(keychainWrites, [databaseCredentials]);
});

test('keychain projection failure fails closed on macOS', () => {
  const databaseCredentials = credentials('selected@example.com', 'selected-token');
  const reconcile = createClaudeHostCredentialReconciler({
    processObj: { platform: 'darwin' },
    hostHomeDir: '/Users/model',
    readClaudeKeychainCredentialRecord: () => null,
    writeClaudeKeychainCredentials: () => ({ ok: false, reason: 'security_failed' }),
    writeAccountNativeAuth: () => true
  });

  const result = reconcile(credentialRecord(databaseCredentials, 100));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'keychain_write_failed');
});

test('host projection targets the default keychain service used by native Claude', () => {
  const databaseCredentials = credentials('selected@example.com', 'selected-token');
  const readOptions = [];
  const writeOptions = [];
  const reconcile = createClaudeHostCredentialReconciler({
    processObj: { platform: 'darwin' },
    hostHomeDir: '/Users/model',
    readClaudeKeychainCredentialRecord: (options) => {
      readOptions.push(options);
      return null;
    },
    writeClaudeKeychainCredentials: (_value, options) => {
      writeOptions.push(options);
      return { ok: true };
    },
    writeAccountNativeAuth: () => assert.fail('must not rewrite DB credentials')
  });

  const result = reconcile(credentialRecord(databaseCredentials, 100));

  assert.equal(result.ok, true);
  assert.equal(result.keychainUpdated, true);
  assert.equal(readOptions.length, 1);
  assert.equal(writeOptions.length, 1);
  assert.equal(Object.hasOwn(readOptions[0], 'configDir'), false);
  assert.equal(Object.hasOwn(writeOptions[0], 'configDir'), false);
});

test('non-macOS hosts keep the DB credentials without touching keychain', () => {
  const databaseCredentials = credentials('selected@example.com', 'selected-token');
  const reconcile = createClaudeHostCredentialReconciler({
    processObj: { platform: 'linux' },
    hostHomeDir: '/home/model',
    readClaudeKeychainCredentialRecord: () => assert.fail('must not read keychain'),
    writeClaudeKeychainCredentials: () => assert.fail('must not write keychain'),
    writeAccountNativeAuth: () => assert.fail('must not rewrite DB')
  });

  const result = reconcile(credentialRecord(databaseCredentials, 100));

  assert.equal(result.ok, true);
  assert.equal(result.source, 'database');
  assert.equal(result.reason, 'keychain_not_applicable');
});
