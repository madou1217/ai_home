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

// 这些用例只关心 aih 自己的哈希槽；裸槽（插件、终端 claude 读的那个）在文件末尾单独测。
function createManagedSlotReconciler(deps) {
  const read = deps.readClaudeKeychainCredentialRecord;
  const write = deps.writeClaudeKeychainCredentials;
  return createClaudeHostCredentialReconciler({
    ...deps,
    readClaudeKeychainCredentialRecord: (options = {}) => (options.configDir ? read(options) : null),
    writeClaudeKeychainCredentials: (value, options = {}) => (options.configDir ? write(value, options) : { ok: true })
  });
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
  const reconcile = createManagedSlotReconciler({
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
  const reconcile = createManagedSlotReconciler({
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
  const reconcile = createManagedSlotReconciler({
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
  const reconcile = createManagedSlotReconciler({
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
  const reconcile = createManagedSlotReconciler({
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
  const reconcile = createManagedSlotReconciler({
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
  const reconcile = createManagedSlotReconciler({
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
  const reconcile = createManagedSlotReconciler({
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
  const reconcile = createManagedSlotReconciler({
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
  const reconcile = createManagedSlotReconciler({
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
  const reconcile = createManagedSlotReconciler({
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

// 宿主自己刷新/重新登录时，新 token 先落在 ~/.claude/.credentials.json。
// 过去 reconciler 只读 keychain，看不到这份更新，就会拿旧的数据库快照把它盖掉，
// 于是非 aih 的 claude 报 `Login expired · Please run /login`。
test('a newer host credentials file wins over the stale database snapshot', () => {
  const databaseCredentials = credentials('same@example.com', 'stale-db-token');
  const hostFileCredentials = credentials('same@example.com', 'fresh-host-token');
  const databaseWrites = [];
  const keychainWrites = [];
  const reconcile = createManagedSlotReconciler({
    processObj: { platform: 'darwin' },
    hostHomeDir: '/Users/model',
    readClaudeKeychainCredentialRecord: () => ({
      credentials: databaseCredentials,
      modifiedAtMs: 100
    }),
    readClaudeHostCredentialFileRecord: () => ({
      credentials: hostFileCredentials,
      modifiedAtMs: 900
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
  assert.equal(result.source, 'host_file');
  assert.equal(result.reason, 'host_file_newer');
  assert.deepEqual(result.credentials, hostFileCredentials);
  assert.equal(result.databaseUpdated, true);
  // 哈希槽要跟着走，否则下一轮又拿旧 keychain 去比。
  assert.deepEqual(keychainWrites, [hostFileCredentials]);
  assert.equal(databaseWrites.length, 1);
  assert.deepEqual(databaseWrites[0].nativeAuth.credentials, hostFileCredentials);
});

test('an older host credentials file never displaces the database snapshot', () => {
  const databaseCredentials = credentials('same@example.com', 'db-token');
  const keychainWrites = [];
  const databaseWrites = [];
  const reconcile = createManagedSlotReconciler({
    processObj: { platform: 'darwin' },
    hostHomeDir: '/Users/model',
    readClaudeKeychainCredentialRecord: () => null,
    readClaudeHostCredentialFileRecord: () => ({
      credentials: credentials('same@example.com', 'ancient-token'),
      modifiedAtMs: 50
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

  const result = reconcile(credentialRecord(databaseCredentials, 500));

  assert.equal(result.source, 'database');
  assert.deepEqual(databaseWrites, []);
  assert.deepEqual(keychainWrites, [databaseCredentials]);
});

// 宿主文件属于别的账号 = 账号切换，不是同账号 token 轮换，不能回灌。
test('a host credentials file for another account is not adopted', () => {
  const databaseCredentials = credentials('selected@example.com', 'db-token');
  const databaseWrites = [];
  const reconcile = createManagedSlotReconciler({
    processObj: { platform: 'darwin' },
    hostHomeDir: '/Users/model',
    readClaudeKeychainCredentialRecord: () => null,
    readClaudeHostCredentialFileRecord: () => ({
      credentials: credentials('other@example.com', 'other-token'),
      modifiedAtMs: 9000
    }),
    writeClaudeKeychainCredentials: () => ({ ok: true }),
    writeAccountNativeAuth: (_fs, _aiHomeDir, accountRef, nativeAuth) => {
      databaseWrites.push({ accountRef, nativeAuth });
      return true;
    }
  });

  const result = reconcile(credentialRecord(databaseCredentials, 100));

  assert.equal(result.source, 'database');
  assert.deepEqual(databaseWrites, []);
});

// 读不到 mtime 就无法证明宿主更新，保持原有判定，不要瞎猜。
test('a host credentials file without a usable timestamp is ignored', () => {
  const databaseCredentials = credentials('same@example.com', 'db-token');
  const databaseWrites = [];
  const reconcile = createManagedSlotReconciler({
    processObj: { platform: 'darwin' },
    hostHomeDir: '/Users/model',
    readClaudeKeychainCredentialRecord: () => null,
    readClaudeHostCredentialFileRecord: () => ({
      credentials: credentials('same@example.com', 'unstamped-token'),
      modifiedAtMs: 0
    }),
    writeClaudeKeychainCredentials: () => ({ ok: true }),
    writeAccountNativeAuth: (_fs, _aiHomeDir, accountRef, nativeAuth) => {
      databaseWrites.push({ accountRef, nativeAuth });
      return true;
    }
  });

  assert.equal(reconcile(credentialRecord(databaseCredentials, 100)).source, 'database');
  assert.deepEqual(databaseWrites, []);
});

// 裸槽 `Claude Code-credentials`：VSCode 插件和终端里直接敲的 claude 读它。
function createTwoSlotReconciler(slots, extra = {}) {
  const writes = [];
  const databaseWrites = [];
  const slotOf = (options = {}) => (options.configDir ? 'managed' : 'default');
  const reconcile = createClaudeHostCredentialReconciler({
    processObj: { platform: 'darwin' },
    hostHomeDir: '/Users/model',
    readClaudeHostIdentity: () => new Set(extra.hostIdentities || []),
    readClaudeHostCredentialFileRecord: () => null,
    readClaudeKeychainCredentialRecord: (options) => slots[slotOf(options)] || null,
    writeClaudeKeychainCredentials: (value, options) => {
      writes.push({ slot: slotOf(options), value });
      slots[slotOf(options)] = { credentials: value, modifiedAtMs: 900 };
      return { ok: true };
    },
    writeAccountNativeAuth: (_fs, _aiHomeDir, accountRef, nativeAuth) => {
      databaseWrites.push({ accountRef, nativeAuth });
      return true;
    }
  });
  return { reconcile, writes, databaseWrites };
}

test('an envelope Claude Code cannot read in the default slot is replaced by the selected login', () => {
  const selected = credentials('same@example.com', 'db-token');
  // Claude Code 清空了驼峰 token，aih 早先写入的下划线别名仍留着旧值。
  const poisoned = {
    claudeAiOauth: {
      accessToken: '',
      refreshToken: '',
      access_token: 'stale-token',
      refresh_token: 'stale-refresh',
      account: { emailAddress: 'same@example.com' }
    }
  };
  const { reconcile, writes } = createTwoSlotReconciler({
    managed: { credentials: selected, modifiedAtMs: 100 },
    default: { credentials: poisoned, modifiedAtMs: 500 }
  });

  const result = reconcile(credentialRecord(selected, 100));

  assert.equal(result.ok, true);
  assert.equal(result.source, 'database');
  assert.equal(result.defaultSlotUpdated, true);
  assert.equal(result.defaultSlotReason, 'default_slot_unreadable');
  assert.deepEqual(writes, [{ slot: 'default', value: selected }]);
});

test('automatic refresh keeps another account the user logged into outside AIH', () => {
  const selected = credentials('selected@example.com', 'db-token');
  const other = credentials('other@example.com', 'other-token');
  const slots = {
    managed: { credentials: selected, modifiedAtMs: 100 },
    default: { credentials: other, modifiedAtMs: 50 }
  };

  const automatic = createTwoSlotReconciler(slots).reconcile(credentialRecord(selected, 100));
  assert.equal(automatic.defaultSlotUpdated, false);
  assert.equal(automatic.defaultSlotReason, 'default_slot_other_login_preserved');
  assert.deepEqual(slots.default.credentials, other);

  const explicit = createTwoSlotReconciler(slots).reconcile(credentialRecord(selected, 100), { selectedExplicitly: true });
  assert.equal(explicit.defaultSlotUpdated, true);
  assert.equal(explicit.defaultSlotReason, 'default_slot_selected_account');
  assert.deepEqual(slots.default.credentials, selected);
});

test('a token the extension refreshed in the default slot is adopted instead of overwritten', () => {
  const stored = credentialsWithIdentity({ email: 'same@example.com', uuid: 'uuid-1', accessToken: 'db-token' });
  // Claude Code 自己写的信封不带 account；身份由官方 ~/.claude/.claude.json 证明。
  const refreshed = credentials(undefined, 'extension-token');
  const { reconcile, writes, databaseWrites } = createTwoSlotReconciler({
    managed: { credentials: stored, modifiedAtMs: 100 },
    default: { credentials: refreshed, modifiedAtMs: 300 }
  }, { hostIdentities: ['oauth:claude:uuid:uuid-1'] });

  const result = reconcile(credentialRecord(stored, 100));

  assert.equal(result.ok, true);
  assert.equal(result.source, 'default_keychain');
  assert.equal(result.reason, 'default_keychain_newer');
  assert.equal(result.credentials.claudeAiOauth.accessToken, 'extension-token');
  assert.equal(result.credentials.claudeAiOauth.refreshToken, 'extension-token-refresh');
  assert.equal(databaseWrites.length, 1);
  assert.equal(databaseWrites[0].nativeAuth.credentials.claudeAiOauth.refreshToken, 'extension-token-refresh');
  assert.deepEqual(writes.map((write) => write.slot), ['managed', 'default']);
  assert.ok(writes.every((write) => write.value.claudeAiOauth.refreshToken === 'extension-token-refresh'));
});

test('a default-slot token from a different account is never adopted', () => {
  const stored = credentialsWithIdentity({ email: 'same@example.com', uuid: 'uuid-1', accessToken: 'db-token' });
  const other = credentialsWithIdentity({ email: 'other@example.com', uuid: 'uuid-2', accessToken: 'other-token' });
  const { reconcile, databaseWrites } = createTwoSlotReconciler({
    managed: { credentials: stored, modifiedAtMs: 100 },
    default: { credentials: other, modifiedAtMs: 300 }
  });

  const result = reconcile(credentialRecord(stored, 100));

  assert.equal(result.source, 'database');
  assert.deepEqual(databaseWrites, []);
  assert.equal(result.defaultSlotReason, 'default_slot_other_login_preserved');
});

test('an older default-slot token of the same account is rotated to the current one', () => {
  const current = credentials('same@example.com', 'new-token');
  const rotatedAway = credentials('same@example.com', 'old-token');
  const { reconcile, writes } = createTwoSlotReconciler({
    managed: { credentials: current, modifiedAtMs: 400 },
    default: { credentials: rotatedAway, modifiedAtMs: 50 }
  });

  const result = reconcile(credentialRecord(current, 400));

  assert.equal(result.defaultSlotReason, 'default_slot_rotated');
  assert.deepEqual(writes, [{ slot: 'default', value: current }]);
});
