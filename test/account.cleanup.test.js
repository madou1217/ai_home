const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fse = require('fs-extra');
const { createAccountCleanupService } = require('../lib/cli/services/account/cleanup');
const { createSessionStoreService } = require('../lib/cli/services/session-store');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const {
  readAccountCredentialRecord,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const {
  resolveAccountRef,
  resolveAccountRefByCliId
} = require('../lib/server/account-ref-store');
const {
  resolveAccountRuntimeDir,
  resolveCodexDesktopRuntimeDir
} = require('../lib/runtime/aih-storage-layout');
const persistentSessionRegistry = require('../lib/runtime/persistent-session-registry');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-cleanup-'));
}

function createService(aiHomeDir, deletedStates = [], overrides = {}) {
  return createAccountCleanupService({
    fs,
    path,
    aiHomeDir,
    accountStateService: {
      deleteAccount: (accountRef) => {
        deletedStates.push(accountRef);
        return true;
      }
    },
    ...overrides
  });
}

function registerAccount(aiHomeDir, provider, cliAccountId) {
  const accountRef = registerAccountIdentity(fs, aiHomeDir, {
    provider,
    cliAccountId,
    identitySeed: `oauth:${provider}:${cliAccountId}@example.com`
  }).accountRef;
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, { auth: { token: cliAccountId } });
  return accountRef;
}

function createRealSessionReconciler(aiHomeDir, hostHomeDir, fseImpl = fse) {
  return createSessionStoreService({
    fs,
    fse: fseImpl,
    path,
    processObj: process,
    aiHomeDir,
    hostHomeDir,
    cliConfigs: {
      agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' },
      codex: { globalDir: '.codex' },
      opencode: { globalDir: '.config/opencode' }
    },
    getProfileDir: (provider, accountRef) => resolveAccountRuntimeDir(aiHomeDir, provider, accountRef),
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  }).ensureSessionStoreLinks;
}

test('parseDeleteSelectorTokens supports ids comma lists and ranges', () => {
  const service = createService('/tmp/aih-cleanup-test');
  assert.deepEqual(service.parseDeleteSelectorTokens(['3,1', '2-4', '4']), ['1', '2', '3', '4']);
  assert.throws(() => service.parseDeleteSelectorTokens(['4-2']), /invalid_delete_selector:4-2/);
  assert.throws(() => service.parseDeleteSelectorTokens(['abc']), /invalid_delete_selector:abc/);
});

test('deleteAccountsForCli removes requested accounts and reports missing ids', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const account1Ref = registerAccount(root, 'codex', '1');
  const account3Ref = registerAccount(root, 'codex', '3');
  const account1RuntimeDir = resolveAccountRuntimeDir(root, 'codex', account1Ref);
  const account1DesktopRuntimeDir = resolveCodexDesktopRuntimeDir(root, account1Ref);
  fs.mkdirSync(account1RuntimeDir, { recursive: true });
  fs.mkdirSync(account1DesktopRuntimeDir, { recursive: true });
  fs.writeFileSync(path.join(account1RuntimeDir, 'auth.json'), 'runtime');
  fs.writeFileSync(path.join(account1DesktopRuntimeDir, 'auth.json'), 'desktop');
  const deletedStates = [];
  const service = createService(root, deletedStates, {
    ensureSessionStoreLinks: () => ({ migrated: 0, linked: 0 })
  });

  const result = service.deleteAccountsForCli('codex', ['1', '2', '3']);

  assert.deepEqual(result.deletedIds, ['1', '3']);
  assert.deepEqual(result.missingIds, ['2']);
  assert.equal(readAccountCredentialRecord(fs, root, account1Ref), null);
  assert.equal(readAccountCredentialRecord(fs, root, account3Ref), null);
  assert.equal(fs.existsSync(account1RuntimeDir), false);
  assert.equal(fs.existsSync(account1DesktopRuntimeDir), false);
  assert.deepEqual(deletedStates, [account1Ref, account3Ref]);
});

test('deleteAllAccountsForCli deletes DB-registered provider accounts', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  registerAccount(root, 'gemini', '1');
  registerAccount(root, 'gemini', '2');
  const service = createService(root);

  const result = service.deleteAllAccountsForCli('gemini');

  assert.deepEqual(result.deletedIds, ['1', '2']);
  assert.equal(result.totalBeforeDelete, 2);
  assert.equal(resolveAccountRefByCliId(fs, root, 'gemini', '1'), null);
  assert.equal(resolveAccountRefByCliId(fs, root, 'gemini', '2'), null);
});

test('deleteAccountByRef does not depend on the CLI alias', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accountRef = registerAccount(root, 'opencode', '4');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(root, 'app-state.db'));
  try {
    db.prepare('DELETE FROM account_cli_aliases WHERE account_ref = ?').run(accountRef);
  } finally {
    db.close();
  }

  const result = createService(root).deleteAccountByRef('opencode', accountRef);

  assert.equal(result.deleted, true);
  assert.equal(result.accountRef, accountRef);
  assert.equal(Object.hasOwn(result, 'cliAccountId'), false);
  assert.equal(resolveAccountRef(fs, root, accountRef), null);
  assert.equal(readAccountCredentialRecord(fs, root, accountRef), null);
});

test('deleteAccountByRef reconciles provider state before removing its projection', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accountRef = registerAccount(root, 'agy', '5');
  const runtimeDir = resolveAccountRuntimeDir(root, 'agy', accountRef);
  const resourcePath = path.join(runtimeDir, '.gemini', 'antigravity-cli', 'new-resource.txt');
  fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
  fs.writeFileSync(resourcePath, 'resource', 'utf8');
  let reconciledWhilePresent = false;

  const result = createService(root, [], {
    ensureSessionStoreLinks(provider, resolvedRef) {
      assert.equal(provider, 'agy');
      assert.equal(resolvedRef, accountRef);
      reconciledWhilePresent = fs.existsSync(resourcePath);
    }
  }).deleteAccountByRef('agy', accountRef);

  assert.equal(result.deleted, true);
  assert.equal(reconciledWhilePresent, true);
  assert.equal(fs.existsSync(runtimeDir), false);
});

test('deleteAccountByRef refuses to remove a runtime projection without a reconciler', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accountRef = registerAccount(root, 'agy', '4');
  const runtimeDir = resolveAccountRuntimeDir(root, 'agy', accountRef);
  const resourcePath = path.join(runtimeDir, '.gemini', 'antigravity-cli', 'resource.txt');
  fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
  fs.writeFileSync(resourcePath, 'resource', 'utf8');

  assert.throws(
    () => createService(root).deleteAccountByRef('agy', accountRef),
    (error) => error && error.code === 'provider_resource_reconcile_unavailable'
  );
  assert.notEqual(resolveAccountRef(fs, root, accountRef), null);
  assert.equal(fs.readFileSync(resourcePath, 'utf8'), 'resource');
});

test('deleteAccountByRef keeps AGY brain Git and untracked resources in the native provider root', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const hostHomeDir = path.join(root, 'home');
  const accountRef = registerAccount(aiHomeDir, 'agy', '6');
  const runtimeDir = resolveAccountRuntimeDir(aiHomeDir, 'agy', accountRef);
  const guestSessionDir = path.join(
    runtimeDir,
    '.gemini',
    'antigravity-cli',
    'brain',
    '287e94b0-5944-4d05-a614-d906797222dc'
  );
  const nativeSessionDir = path.join(
    hostHomeDir,
    '.gemini',
    'antigravity-cli',
    'brain',
    '287e94b0-5944-4d05-a614-d906797222dc'
  );
  fs.mkdirSync(path.join(guestSessionDir, '.git', 'objects', 'aa'), { recursive: true });
  fs.writeFileSync(path.join(guestSessionDir, '.git', 'objects', 'aa', 'object'), 'git-object', 'utf8');
  fs.writeFileSync(path.join(guestSessionDir, 'real_phoenix.jpg'), 'untracked-image', 'utf8');

  const result = createService(aiHomeDir, [], {
    hostHomeDir,
    ensureSessionStoreLinks: createRealSessionReconciler(aiHomeDir, hostHomeDir)
  }).deleteAccountByRef('agy', accountRef);

  assert.equal(result.deleted, true);
  assert.equal(fs.existsSync(runtimeDir), false);
  assert.equal(fs.readFileSync(path.join(nativeSessionDir, '.git', 'objects', 'aa', 'object'), 'utf8'), 'git-object');
  assert.equal(fs.readFileSync(path.join(nativeSessionDir, 'real_phoenix.jpg'), 'utf8'), 'untracked-image');
});

test('deleteAccountByRef migrates OpenCode bridge state before removing auth projection', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const hostHomeDir = path.join(root, 'home');
  const accountRef = registerAccount(aiHomeDir, 'opencode', '7');
  const runtimeDir = resolveAccountRuntimeDir(aiHomeDir, 'opencode', accountRef);
  const bridgeDir = path.join(runtimeDir, '.local', 'share', 'aih-opencode-runtime', 'opencode');
  const accountDataDir = path.join(runtimeDir, '.local', 'share', 'opencode');
  const projectedConfigDir = path.join(runtimeDir, '.config', 'opencode');
  fs.mkdirSync(path.join(bridgeDir, 'storage'), { recursive: true });
  fs.mkdirSync(accountDataDir, { recursive: true });
  fs.mkdirSync(projectedConfigDir, { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, 'storage', 'message.json'), '{"message":"kept"}\n', 'utf8');
  fs.writeFileSync(path.join(bridgeDir, 'opencode.db'), 'sqlite-state', 'utf8');
  fs.writeFileSync(path.join(accountDataDir, 'auth.json.corrupted.bak'), 'private backup\n', 'utf8');
  fs.writeFileSync(path.join(accountDataDir, 'legacy-state.json'), '{"legacy":true}\n', 'utf8');
  fs.writeFileSync(path.join(projectedConfigDir, 'auth.json.backup'), 'config private backup\n', 'utf8');
  fs.writeFileSync(path.join(projectedConfigDir, 'opencode.json'), '{"theme":"system"}\n', 'utf8');

  const result = createService(aiHomeDir, [], {
    hostHomeDir,
    ensureSessionStoreLinks: createRealSessionReconciler(aiHomeDir, hostHomeDir)
  }).deleteAccountByRef('opencode', accountRef);

  const nativeDataDir = path.join(hostHomeDir, '.local', 'share', 'opencode');
  assert.equal(result.deleted, true);
  assert.equal(fs.existsSync(runtimeDir), false);
  assert.equal(fs.readFileSync(path.join(nativeDataDir, 'storage', 'message.json'), 'utf8'), '{"message":"kept"}\n');
  assert.equal(fs.readFileSync(path.join(nativeDataDir, 'opencode.db'), 'utf8'), 'sqlite-state');
  assert.equal(fs.readFileSync(path.join(nativeDataDir, 'legacy-state.json'), 'utf8'), '{"legacy":true}\n');
  assert.equal(fs.existsSync(path.join(nativeDataDir, 'auth.json.corrupted.bak')), false);
  assert.equal(
    fs.readFileSync(path.join(hostHomeDir, '.config', 'opencode', 'opencode.json'), 'utf8'),
    '{"theme":"system"}\n'
  );
  assert.equal(fs.existsSync(path.join(hostHomeDir, '.config', 'opencode', 'auth.json.backup')), false);
});

test('deleteAccountByRef keeps OpenCode DB conflicts observable in the provider recovery root', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const hostHomeDir = path.join(root, 'home');
  const accountRef = registerAccount(aiHomeDir, 'opencode', '11');
  const runtimeDir = resolveAccountRuntimeDir(aiHomeDir, 'opencode', accountRef);
  const bridgeDir = path.join(runtimeDir, '.local', 'share', 'aih-opencode-runtime', 'opencode');
  const nativeDataDir = path.join(hostHomeDir, '.local', 'share', 'opencode');
  const conflictPath = path.join(
    nativeDataDir,
    '.aih-migration-conflicts',
    accountRef,
    'bridge-data',
    'opencode.db'
  );
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.mkdirSync(nativeDataDir, { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, 'opencode.db'), 'account-db', 'utf8');
  fs.writeFileSync(path.join(nativeDataDir, 'opencode.db'), 'canonical-db', 'utf8');
  const reconcile = createRealSessionReconciler(aiHomeDir, hostHomeDir);

  const reconciliation = reconcile('opencode', accountRef);
  assert.deepEqual(reconciliation.conflicts, [conflictPath]);
  assert.equal(fs.readFileSync(conflictPath, 'utf8'), 'account-db');

  const result = createService(aiHomeDir, [], {
    hostHomeDir,
    ensureSessionStoreLinks: reconcile
  }).deleteAccountByRef('opencode', accountRef);

  assert.equal(result.deleted, true);
  assert.equal(fs.existsSync(runtimeDir), false);
  assert.equal(fs.readFileSync(path.join(nativeDataDir, 'opencode.db'), 'utf8'), 'canonical-db');
  assert.equal(fs.readFileSync(conflictPath, 'utf8'), 'account-db');
});

test('deleteAccountByRef fails closed when provider resources remain unreconciled', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const hostHomeDir = path.join(root, 'home');
  const accountRef = registerAccount(aiHomeDir, 'agy', '8');
  const runtimeDir = resolveAccountRuntimeDir(aiHomeDir, 'agy', accountRef);
  const resourcePath = path.join(
    runtimeDir,
    '.gemini',
    'antigravity-cli',
    'brain',
    'session',
    'late-resource.jpg'
  );
  fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
  fs.mkdirSync(path.join(hostHomeDir, '.gemini', 'antigravity-cli', 'brain'), { recursive: true });
  fs.writeFileSync(resourcePath, 'must-survive', 'utf8');
  const deletedStates = [];
  const failingFse = Object.create(fse);
  failingFse.moveSync = () => {
    const error = new Error('simulated move failure');
    error.code = 'EIO';
    throw error;
  };
  const service = createService(aiHomeDir, deletedStates, {
    hostHomeDir,
    ensureSessionStoreLinks: createRealSessionReconciler(aiHomeDir, hostHomeDir, failingFse)
  });

  assert.throws(
    () => service.deleteAccountByRef('agy', accountRef),
    (error) => error && error.code === 'EIO'
  );
  assert.notEqual(resolveAccountRef(fs, aiHomeDir, accountRef), null);
  assert.equal(fs.readFileSync(resourcePath, 'utf8'), 'must-survive');
  assert.deepEqual(deletedStates, []);
});

test('deleteAccountByRef fails closed when provider resource enumeration returns EIO', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const hostHomeDir = path.join(root, 'home');
  const accountRef = registerAccount(aiHomeDir, 'agy', '10');
  const runtimeDir = resolveAccountRuntimeDir(aiHomeDir, 'agy', accountRef);
  const guestRoot = path.join(runtimeDir, '.gemini', 'antigravity-cli');
  const resourcePath = path.join(guestRoot, 'late-resource.txt');
  fs.mkdirSync(guestRoot, { recursive: true });
  fs.writeFileSync(resourcePath, 'must-survive-eio', 'utf8');

  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property !== 'readdirSync') return Reflect.get(target, property);
      return (dirPath, options) => {
        if (path.resolve(dirPath) === path.resolve(guestRoot)) {
          const error = new Error('simulated readdir failure');
          error.code = 'EIO';
          throw error;
        }
        return target.readdirSync(dirPath, options);
      };
    }
  });
  const ensureSessionStoreLinks = createSessionStoreService({
    fs: failingFs,
    fse,
    path,
    processObj: process,
    aiHomeDir,
    hostHomeDir,
    cliConfigs: { agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' } },
    getProfileDir: (provider, resolvedRef) => resolveAccountRuntimeDir(aiHomeDir, provider, resolvedRef),
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  }).ensureSessionStoreLinks;

  assert.throws(
    () => createService(aiHomeDir, [], { hostHomeDir, ensureSessionStoreLinks })
      .deleteAccountByRef('agy', accountRef),
    (error) => error && error.code === 'EIO'
  );
  assert.notEqual(resolveAccountRef(fs, aiHomeDir, accountRef), null);
  assert.equal(fs.readFileSync(resourcePath, 'utf8'), 'must-survive-eio');
});

test('deleteAccountByRef fails closed when Codex desktop resources remain unreconciled', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const hostHomeDir = path.join(root, 'home');
  const accountRef = registerAccount(aiHomeDir, 'codex', '9');
  const runtimeDir = resolveAccountRuntimeDir(aiHomeDir, 'codex', accountRef);
  const desktopDir = resolveCodexDesktopRuntimeDir(aiHomeDir, accountRef);
  const resourcePath = path.join(desktopDir, 'sessions', 'late-session.jsonl');
  fs.mkdirSync(path.join(runtimeDir, '.codex'), { recursive: true });
  fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
  fs.mkdirSync(path.join(hostHomeDir, '.codex', 'sessions'), { recursive: true });
  fs.writeFileSync(resourcePath, '{"must":"survive"}\n', 'utf8');
  const failingFse = Object.create(fse);
  failingFse.moveSync = () => {
    const error = new Error('simulated desktop move failure');
    error.code = 'EIO';
    throw error;
  };
  const service = createService(aiHomeDir, [], {
    hostHomeDir,
    ensureSessionStoreLinks: createRealSessionReconciler(aiHomeDir, hostHomeDir, failingFse)
  });

  assert.throws(
    () => service.deleteAccountByRef('codex', accountRef),
    (error) => error && error.code === 'EIO'
  );
  assert.notEqual(resolveAccountRef(fs, aiHomeDir, accountRef), null);
  assert.equal(fs.readFileSync(resourcePath, 'utf8'), '{"must":"survive"}\n');
});

test('deleteAccountByRef refuses to remove an account with persistent session writers', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accountRef = registerAccount(root, 'codex', '11');
  persistentSessionRegistry.writeEntry(root, {
    provider: 'codex',
    runtimeScope: accountRef,
    accountRef,
    socket: `aih-codex-${accountRef}`,
    session: 'p-project-deadbeef',
    cwd: root
  }, { fs });
  const service = createService(root, [], {
    ensureSessionStoreLinks: () => ({ migrated: 0, linked: 0 })
  });

  assert.throws(
    () => service.deleteAccountByRef('codex', accountRef),
    (error) => error && error.code === 'account_runtime_active'
  );
  assert.notEqual(resolveAccountRef(fs, root, accountRef), null);
});

test('deleteAccountByRef keeps the account when runtime projection removal fails', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accountRef = registerAccount(root, 'agy', '12');
  const runtimeDir = resolveAccountRuntimeDir(root, 'agy', accountRef);
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'runtime-state.json'), '{}\n', 'utf8');
  const deletedStates = [];
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'rmSync') {
        return (targetPath, options) => {
          if (path.resolve(targetPath) === path.resolve(runtimeDir)) {
            const error = new Error('simulated runtime projection removal failure');
            error.code = 'EIO';
            throw error;
          }
          return target.rmSync(targetPath, options);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const service = createService(root, deletedStates, {
    fs: failingFs,
    ensureSessionStoreLinks: () => ({ migrated: 0, linked: 0 })
  });

  assert.throws(
    () => service.deleteAccountByRef('agy', accountRef),
    (error) => error && error.code === 'EIO'
  );
  assert.notEqual(resolveAccountRef(fs, root, accountRef), null);
  assert.notEqual(readAccountCredentialRecord(fs, root, accountRef), null);
  assert.equal(fs.existsSync(runtimeDir), true);
  assert.deepEqual(deletedStates, []);
});
