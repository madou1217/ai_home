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

function credentialsWithIdentity({ email, uuid, accessToken, refreshToken = `${accessToken}-refresh` }) {
  return {
    claudeAiOauth: {
      email,
      accessToken,
      refreshToken,
      ...(uuid ? { account: { emailAddress: email, uuid } } : {})
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

test('selected DB account projects over an unrelated shared keychain identity', () => {
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
  assert.equal(result.reason, 'database_selected_account');
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

test('incomplete keychain credentials from another account are replaced by the selected DB account', () => {
  const databaseCredentials = credentialsWithIdentity({
    email: 'selected@example.com',
    uuid: 'selected-uuid',
    accessToken: 'selected-token'
  });
  const keychainWrites = [];
  const reconcile = createClaudeHostCredentialReconciler({
    processObj: { platform: 'darwin' },
    fs: {
      readFileSync: () => JSON.stringify({
        oauthAccount: { accountUuid: 'other-uuid', emailAddress: 'other@example.com' }
      })
    },
    hostHomeDir: '/Users/model',
    readClaudeKeychainCredentialRecord: () => ({
      credentials: {
        claudeAiOauth: {
          accessToken: 'other-token',
          refreshToken: ''
        }
      },
      modifiedAtMs: 999
    }),
    writeClaudeKeychainCredentials: (value) => {
      keychainWrites.push(value);
      return { ok: true };
    }
  });

  const result = reconcile(credentialRecord(databaseCredentials, 100));

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'database_selected_account');
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

test('host projection targets the hashed keychain service used by AIH Claude', () => {
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
  assert.equal(readOptions[0].configDir, '/Users/model/.claude');
  assert.equal(readOptions[0].includeDefaultService, false);
  assert.equal(writeOptions[0].configDir, '/Users/model/.claude');
  assert.equal(writeOptions[0].includeDefaultService, false);
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

test('keychain envelope without account identity is accepted when host OAuth identity matches', () => {
  const uuid = '1fb09d73-fc89-49ee-96a6-bd1260ab9ef5';
  const databaseCredentials = credentialsWithIdentity({
    email: 'same@example.com', uuid, accessToken: 'db-token'
  });
  const keychainCredentials = credentials('same@example.com', 'keychain-token');
  const databaseWrites = [];
  const reconcile = createClaudeHostCredentialReconciler({
    processObj: { platform: 'darwin' },
    fs: {
      readFileSync: () => JSON.stringify({
        oauthAccount: { accountUuid: uuid, emailAddress: 'same@example.com' }
      })
    },
    hostHomeDir: '/Users/model',
    readClaudeKeychainCredentialRecord: () => ({
      credentials: keychainCredentials,
      modifiedAtMs: 200
    }),
    writeClaudeKeychainCredentials: () => ({ ok: true }),
    writeAccountNativeAuth: (_fs, _dir, accountRef, nativeAuth) => {
      databaseWrites.push({ accountRef, nativeAuth });
    }
  });

  const result = reconcile(credentialRecord(databaseCredentials, 100));

  assert.equal(result.ok, true);
  assert.equal(result.source, 'keychain');
  assert.equal(result.credentials.claudeAiOauth.accessToken, keychainCredentials.claudeAiOauth.accessToken);
  assert.equal(result.credentials.claudeAiOauth.account.uuid, uuid);
  assert.equal(databaseWrites.length, 1);
});

test('host identity mismatch does not block an explicitly selected DB account', () => {
  const databaseCredentials = credentialsWithIdentity({
    email: 'selected@example.com',
    uuid: 'selected-uuid',
    accessToken: 'selected-token'
  });
  const keychainWrites = [];
  const reconcile = createClaudeHostCredentialReconciler({
    processObj: { platform: 'darwin' },
    fs: {
      readFileSync: () => JSON.stringify({
        oauthAccount: { accountUuid: 'other-uuid', emailAddress: 'other@example.com' }
      })
    },
    hostHomeDir: '/Users/model',
    readClaudeKeychainCredentialRecord: () => ({
      credentials: credentialsWithIdentity({
        email: 'other@example.com',
        uuid: 'other-uuid',
        accessToken: 'other-token'
      }),
      modifiedAtMs: 200
    }),
    writeClaudeKeychainCredentials: (value) => {
      keychainWrites.push(value);
      return { ok: true };
    }
  });

  const result = reconcile(credentialRecord(databaseCredentials, 100));

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'database_selected_account');
  assert.deepEqual(keychainWrites, [databaseCredentials]);
});

test('unknown identities never write the database snapshot back to shared keychain', () => {
  const databaseCredentials = {
    claudeAiOauth: {
      accessToken: 'selected-token',
      refreshToken: 'selected-refresh'
    }
  };
  const keychainWrites = [];
  const reconcile = createClaudeHostCredentialReconciler({
    processObj: { platform: 'darwin' },
    hostHomeDir: '/Users/model',
    readClaudeKeychainCredentialRecord: () => ({
      credentials: credentials('other@example.com', 'other-token'),
      modifiedAtMs: 999
    }),
    writeClaudeKeychainCredentials: (value) => {
      keychainWrites.push(value);
      return { ok: true };
    }
  });

  const result = reconcile(credentialRecord(databaseCredentials, 100));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'database_identity_unverified');
  assert.deepEqual(keychainWrites, []);
});

test('unknown keychain timestamp cannot retain a conflicting account', () => {
  const databaseCredentials = credentialsWithIdentity({
    email: 'selected@example.com',
    uuid: 'selected-uuid',
    accessToken: 'selected-token'
  });
  const keychainWrites = [];
  const reconcile = createClaudeHostCredentialReconciler({
    processObj: { platform: 'darwin' },
    fs: {
      readFileSync: () => JSON.stringify({
        oauthAccount: { accountUuid: 'other-uuid', emailAddress: 'other@example.com' }
      })
    },
    hostHomeDir: '/Users/model',
    readClaudeKeychainCredentialRecord: () => ({
      credentials: credentialsWithIdentity({
        email: 'other@example.com',
        uuid: 'other-uuid',
        accessToken: 'other-token'
      }),
      modifiedAtMs: 0
    }),
    writeClaudeKeychainCredentials: (value) => {
      keychainWrites.push(value);
      return { ok: true };
    }
  });

  const result = reconcile(credentialRecord(databaseCredentials, 100));

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'database_selected_account');
  assert.deepEqual(keychainWrites, [databaseCredentials]);
});
