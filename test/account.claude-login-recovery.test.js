'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClaudeLoginRecovery } = require('../lib/account/claude-login-recovery');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { createAccountStateService } = require('../lib/account/state-service');
const { buildAuthInvalidRuntimeState } = require('../lib/account/runtime-state-builders');
const { readAccountNativeAuth, writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const { loadServerRuntimeAccounts } = require('../lib/server/accounts');
const { deriveAccountRuntimeStatus } = require('../lib/server/account-runtime-state');
const { chooseServerAccount } = require('../lib/server/router');

function fixture(t) {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-login-recovery-'));
  const aiHomeDir = path.join(root, 'database');
  const hostHomeDir = path.join(root, 'host');
  fs.mkdirSync(path.join(hostHomeDir, '.claude'), { recursive: true });
  const accountStateIndex = createAccountStateIndex({ fs, aiHomeDir });
  const accountStateService = createAccountStateService({ accountStateIndex });
  t.after(() => { accountStateIndex.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const refs = [];
  const uuids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  for (const [index, uuid] of uuids.entries()) {
    const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
      provider: 'claude', cliAccountId: String(index + 9), identitySeed: `oauth:claude:uuid:${uuid}`
    });
    refs.push(accountRef);
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, { credentials: { claudeAiOauth: {
      accessToken: `old-${index}`, refreshToken: `old-refresh-${index}`, expiresAt: now - 1,
      account: { uuid, emailAddress: 'same@example.com' }
    } } });
    accountStateService.recordRuntimeFailure(accountRef, 'claude', {
      ...buildAuthInvalidRuntimeState('auth_invalid_reauth_required', { nowMs: now + 1000 }),
      modelCooldowns: { 'unrelated-model': now + 3600_000 }
    }, { configured: true, authMode: 'oauth', status: 'up' });
  }
  function hostIdentity(uuid = uuids[0]) {
    fs.writeFileSync(path.join(hostHomeDir, '.claude', '.claude.json'), JSON.stringify({
      oauthAccount: { accountUuid: uuid, emailAddress: 'same@example.com' }
    }));
  }
  hostIdentity();
  t.mock.timers.setTime(now + 3000);
  const candidate = { modifiedAtMs: now + 2000, credentials: { claudeAiOauth: {
    accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: now + 3600_000,
    refreshTokenExpiresAt: now + 86400_000
  } } };
  const deps = {
    fs, aiHomeDir, hostHomeDir, accountStateIndex, accountStateService,
    processObj: { platform: 'darwin' },
    checkStatus: () => ({ configured: true, accountName: 'same@example.com' }),
    readClaudeKeychainCredentialRecord: (options) => options.account === 'unknown' ? candidate : null
  };
  const accounts = loadServerRuntimeAccounts(deps).claude;
  return {
    now, refs, uuids, candidate, deps, hostIdentity,
    account: accounts.find((item) => item.accountRef === refs[0]),
    other: accounts.find((item) => item.accountRef === refs[1]),
    read: (ref) => readAccountNativeAuth(fs, aiHomeDir, ref),
    recover: createClaudeLoginRecovery(deps)
  };
}

test('in-session login in legacy unknown Keychain recovers DB and live routing for only the matching UUID', (t) => {
  const f = fixture(t);
  const otherBefore = f.read(f.refs[1]);
  assert.equal(chooseServerAccount([f.account], {}, 'claude', { accountStateIndex: f.deps.accountStateIndex }), null);
  assert.equal(f.recover(f.other).recovered, false, 'same email with a different UUID must not match');
  assert.deepEqual(f.recover(f.account), { recovered: true, source: 'legacy_keychain' });
  assert.equal(f.account.accessToken, 'new-access');
  assert.equal(deriveAccountRuntimeStatus(f.account).status, 'healthy');
  assert.equal(chooseServerAccount([f.account], {}, 'claude', { accountStateIndex: f.deps.accountStateIndex }).accountRef, f.refs[0]);
  const saved = f.read(f.refs[0]).credentials.claudeAiOauth;
  assert.equal(saved.account.uuid, f.uuids[0]);
  assert.equal(saved.accessToken, 'new-access');
  assert.deepEqual(f.read(f.refs[1]), otherBefore);
  assert.equal(f.account.modelCooldowns['unrelated-model'], f.now + 3600_000);
  assert.equal(f.recover(f.account).recovered, false, 'recovery is idempotent');
});

test('host credentials without verified identity cannot clear an auth block', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.deps.hostHomeDir, '.claude', '.claude.json'), '{}');
  assert.equal(f.recover(f.account).recovered, false);
  assert.equal(f.read(f.refs[0]).credentials.claudeAiOauth.accessToken, 'old-0');
});

test('a normal username-scoped Keychain login recovers without the legacy entry', (t) => {
  const f = fixture(t);
  const recover = createClaudeLoginRecovery({ ...f.deps,
    readClaudeKeychainCredentialRecord: (options) => {
      assert.equal(options.configDir, path.join(f.deps.hostHomeDir, '.claude'));
      assert.equal(options.includeDefaultService, false);
      return options.account === 'unknown' ? null : f.candidate;
    } });
  assert.deepEqual(recover(f.account), { recovered: true, source: 'keychain' });
  assert.equal(f.account.accessToken, 'new-access');
});

test('a disabled account cannot adopt host credentials or clear its runtime block', (t) => {
  const f = fixture(t);
  f.deps.accountStateService.setOperationalStatus(f.refs[0], 'claude', 'down');
  assert.equal(f.recover(f.account).reason, 'not_active');
  assert.equal(f.read(f.refs[0]).credentials.claudeAiOauth.accessToken, 'old-0');
  assert.equal(deriveAccountRuntimeStatus(f.account).status, 'auth_invalid');
});

test('recovery clears live auth state when durable recovery leaves no model state', (t) => {
  const f = fixture(t);
  f.deps.accountStateService.recordRuntimeFailure(f.refs[0], 'claude',
    buildAuthInvalidRuntimeState('auth_invalid_reauth_required', { nowMs: f.now + 1000 }));
  assert.equal(f.recover(f.account).recovered, true);
  assert.equal(f.deps.accountStateIndex.getAccountState(f.refs[0]).runtimeState, null);
  assert.equal(deriveAccountRuntimeStatus(f.account).status, 'healthy');
  assert.equal(chooseServerAccount([f.account], {}, 'claude', { accountStateIndex: f.deps.accountStateIndex }).accountRef, f.refs[0]);
});

test('newer timestamp alone, expired credentials, and credentials older than the failure never clear auth', (t) => {
  const f = fixture(t);
  const oauth = f.candidate.credentials.claudeAiOauth;
  oauth.accessToken = 'old-0';
  assert.equal(f.recover(f.account).recovered, false);
  oauth.accessToken = 'new-access';
  oauth.expiresAt = f.now - 1;
  assert.equal(f.recover(f.account).recovered, false);
  oauth.expiresAt = f.now + 3600_000;
  f.candidate.modifiedAtMs = f.now;
  assert.equal(f.recover(f.account).recovered, false);
  assert.equal(deriveAccountRuntimeStatus(f.account).status, 'auth_invalid');
});

test('credential UUID conflict overrides matching email and matching host identity', (t) => {
  const f = fixture(t);
  f.candidate.credentials.claudeAiOauth.account = { uuid: f.uuids[1], emailAddress: 'same@example.com' };
  assert.equal(f.recover(f.account).recovered, false);
  assert.equal(f.read(f.refs[0]).credentials.claudeAiOauth.accessToken, 'old-0');
});

test('file-backed login recovery works without Keychain and does not modify host credentials', (t) => {
  const f = fixture(t);
  const filePath = path.join(f.deps.hostHomeDir, '.claude', '.credentials.json');
  const contents = JSON.stringify(f.candidate.credentials);
  fs.writeFileSync(filePath, contents);
  fs.utimesSync(filePath, new Date(f.now + 2000), new Date(f.now + 2000));
  const recover = createClaudeLoginRecovery({ ...f.deps, processObj: { platform: 'win32' },
    readClaudeKeychainCredentialRecord: () => { throw new Error('must not read Keychain'); } });
  assert.deepEqual(recover(f.account), { recovered: true, source: 'host_file' });
  assert.equal(fs.readFileSync(filePath, 'utf8'), contents);
});

test('a rejected runtime clear keeps live routing blocked and can complete on the next attempt', (t) => {
  const f = fixture(t);
  const reject = createClaudeLoginRecovery({ ...f.deps, accountStateService: { clearRuntimeBlock: () => false } });
  assert.equal(reject(f.account).reason, 'runtime_clear_rejected');
  assert.equal(deriveAccountRuntimeStatus(f.account).status, 'auth_invalid');
  assert.equal(f.account.accessToken, 'old-0');
  assert.equal(f.recover(f.account).recovered, true);
  assert.equal(f.account.accessToken, 'new-access');
});
