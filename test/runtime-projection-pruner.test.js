'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerAccountIdentity } = require('../lib/account/account-registration');
const { pruneStaleAccountRuntimeProjections } = require('../lib/account/runtime-projection-pruner');
const {
  resolveAccountRuntimeDir,
  resolveAihRunPath,
  resolveCodexDesktopRuntimeDir
} = require('../lib/runtime/aih-storage-layout');
const { appServerStatePath, writeAppServerState } = require('../lib/server/codex-app-server-endpoint');
const { pruneStaleCodexAppServerStates } = require('../lib/server/codex-app-server-state-pruner');
const { createAccountStateIndex } = require('../lib/account/state-index');

function makeDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, 'projection'), 'runtime', 'utf8');
}

test('runtime projection pruner keeps registered accountRefs and removes stale entries', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-prune-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const codex = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    identitySeed: 'oauth:codex:runtime-prune@example.com'
  });
  const gemini = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'gemini',
    identitySeed: 'oauth:gemini:runtime-prune@example.com'
  });
  const staleRef = 'acct_ffffffffffffffffffff';

  const keptCodexDir = resolveAccountRuntimeDir(aiHomeDir, 'codex', codex.accountRef);
  const keptGeminiDir = resolveAccountRuntimeDir(aiHomeDir, 'gemini', gemini.accountRef);
  const staleCodexDir = resolveAccountRuntimeDir(aiHomeDir, 'codex', staleRef);
  const invalidAccountDir = path.join(resolveAihRunPath(aiHomeDir, 'auth-projections'), 'codex', '1');
  const unknownProviderDir = path.join(resolveAihRunPath(aiHomeDir, 'auth-projections'), 'unknown', staleRef);
  const keptDesktopDir = resolveCodexDesktopRuntimeDir(aiHomeDir, codex.accountRef);
  const staleDesktopDir = resolveCodexDesktopRuntimeDir(aiHomeDir, staleRef);
  [
    keptCodexDir,
    keptGeminiDir,
    staleCodexDir,
    invalidAccountDir,
    unknownProviderDir,
    keptDesktopDir,
    staleDesktopDir
  ].forEach(makeDir);

  const reconciled = [];
  const result = pruneStaleAccountRuntimeProjections({
    fs,
    path,
    aiHomeDir,
    ensureSessionStoreLinks(provider, accountRef) {
      reconciled.push(`${provider}/${accountRef}`);
      return { migrated: 0, linked: 0 };
    }
  });

  assert.deepEqual(result, { removed: 2, kept: 3, failed: 2 });
  assert.equal(fs.existsSync(keptCodexDir), true);
  assert.equal(fs.existsSync(keptGeminiDir), true);
  assert.equal(fs.existsSync(keptDesktopDir), true);
  assert.equal(fs.existsSync(staleCodexDir), false);
  assert.equal(fs.existsSync(invalidAccountDir), true);
  assert.equal(fs.existsSync(unknownProviderDir), true);
  assert.equal(fs.existsSync(staleDesktopDir), false);
  assert.deepEqual(reconciled, [
    `codex/${staleRef}`,
    `codex/${staleRef}`
  ]);
});

test('runtime projection pruner keeps stale resources when reconciliation is incomplete', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-prune-unresolved-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const staleRef = 'acct_eeeeeeeeeeeeeeeeeeee';
  const staleDir = resolveAccountRuntimeDir(aiHomeDir, 'gemini', staleRef);
  makeDir(staleDir);

  const result = pruneStaleAccountRuntimeProjections({
    fs,
    path,
    aiHomeDir,
    ensureSessionStoreLinks: () => ({ unresolved: ['tmp'] })
  });

  assert.deepEqual(result, { removed: 0, kept: 0, failed: 1 });
  assert.equal(fs.existsSync(staleDir), true);
});

test('Codex app-server pruner invalidates states for deleted accounts in every namespace', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-state-prune-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const registered = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    identitySeed: 'oauth:codex:state-prune@example.com'
  });
  const stale = 'acct_ffffffffffffffffffff';
  const staleChatScope = `chat-${stale}`;
  writeAppServerState(aiHomeDir, registered.accountRef, {
    accountRef: registered.accountRef,
    runtimeScope: registered.accountRef,
    multiplexer: 'tmux',
    port: 43131,
    socket: `aih-codexapp-${registered.accountRef.slice(5)}`
  });
  writeAppServerState(aiHomeDir, stale, {
    accountRef: stale,
    runtimeScope: stale,
    multiplexer: 'tmux',
    port: 43132,
    socket: `aih-codexapp-${stale.slice(5)}`
  });
  writeAppServerState(aiHomeDir, staleChatScope, {
    accountRef: stale,
    runtimeScope: staleChatScope,
    multiplexer: 'tmux',
    port: 43133,
    socket: `aih-codexchat-${stale.slice(5)}`
  });
  const calls = [];
  const result = pruneStaleCodexAppServerStates({
    fs,
    path,
    aiHomeDir,
    invalidateCodexAppServerEndpoint(options) {
      calls.push(options);
      fs.unlinkSync(appServerStatePath(aiHomeDir, options.runtimeNamespace === 'chat'
        ? `chat-${options.accountRef}`
        : options.accountRef));
      return { invalidated: true };
    }
  });

  assert.deepEqual(result, { removed: 2, kept: 1, failed: 0 });
  assert.deepEqual(calls.map((entry) => entry.runtimeNamespace), [undefined, 'chat']);
  assert.equal(fs.existsSync(appServerStatePath(aiHomeDir, registered.accountRef)), true);
  assert.equal(fs.existsSync(appServerStatePath(aiHomeDir, stale)), false);
  assert.equal(fs.existsSync(appServerStatePath(aiHomeDir, staleChatScope)), false);
});

test('Codex app-server pruner invalidates resident states for disabled accounts', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-disabled-state-prune-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const account = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    identitySeed: 'oauth:codex:disabled-state-prune@example.com'
  });
  const accountStateIndex = createAccountStateIndex({ fs, aiHomeDir });
  t.after(() => accountStateIndex.close());
  accountStateIndex.upsertAccountState(account.accountRef, 'codex', {
    status: 'down',
    configured: true,
    authMode: 'oauth'
  });
  const chatScope = `chat-${account.accountRef}`;
  writeAppServerState(aiHomeDir, account.accountRef, {
    accountRef: account.accountRef,
    runtimeScope: account.accountRef,
    multiplexer: 'tmux',
    port: 43141,
    socket: `aih-codexapp-${account.accountRef.slice(5)}`
  });
  writeAppServerState(aiHomeDir, chatScope, {
    accountRef: account.accountRef,
    runtimeScope: chatScope,
    multiplexer: 'tmux',
    port: 43142,
    socket: `aih-codexchat-${account.accountRef.slice(5)}`
  });
  const calls = [];
  const result = pruneStaleCodexAppServerStates({
    fs,
    path,
    aiHomeDir,
    accountStateIndex,
    invalidateCodexAppServerEndpoint(options) {
      calls.push(options);
      fs.unlinkSync(appServerStatePath(aiHomeDir, options.runtimeNamespace === 'chat'
        ? `chat-${options.accountRef}`
        : options.accountRef));
      return { invalidated: true };
    }
  });

  assert.deepEqual(result, { removed: 2, kept: 0, failed: 0 });
  assert.deepEqual(calls.map((entry) => entry.runtimeNamespace), [undefined, 'chat']);
  assert.equal(fs.existsSync(appServerStatePath(aiHomeDir, account.accountRef)), false);
  assert.equal(fs.existsSync(appServerStatePath(aiHomeDir, chatScope)), false);
});

test('runtime projection pruner aborts before deletion when account schema is invalid', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-prune-schema-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(aiHomeDir, 'app-state.db'));
  db.exec('CREATE TABLE account_refs (account_ref TEXT PRIMARY KEY, provider TEXT NOT NULL)');
  db.close();
  const runtimeDir = resolveAccountRuntimeDir(
    aiHomeDir,
    'codex',
    'acct_ffffffffffffffffffff'
  );
  makeDir(runtimeDir);

  assert.throws(
    () => pruneStaleAccountRuntimeProjections({ fs, path, aiHomeDir }),
    /account_ref_schema_invalid/
  );
  assert.equal(fs.existsSync(runtimeDir), true);
});
