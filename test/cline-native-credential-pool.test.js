'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountNativeAuth, writeAccountCredentials } = require('../lib/server/account-credential-store');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { createAccountStateService } = require('../lib/account/state-service');
const { loadServerRuntimeAccounts } = require('../lib/server/accounts');
const { createClineNativeCredentialSync } = require('../lib/account/cline-native-credential-sync');
const { CLINE_CREDENTIAL_PATH, clineAuth, providersDocument } = require('./helpers/cline-credential');

/**
 * 账号投影里的凭据文件只有在账号**启动过**之后才会存在，所以自动识别登记出来的账号
 * （宿主 `cline auth` 登录 → 3s 观察循环入库）在第一次启动前投影是空的、状态服务报
 * 「未配置」。池必须用库里那份已登记的凭据兜住它，否则账号页/网关都看不见它，
 * 要等到用户手动跑一次 CLI 才可用 —— 与 codebuddy 家族的既有语义一致。
 */
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cline-pool-'));
  const aiHomeDir = path.join(root, 'aih');
  const hostHomeDir = path.join(root, 'home');
  const hostFile = path.join(hostHomeDir, ...CLINE_CREDENTIAL_PATH);
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.mkdirSync(path.dirname(hostFile), { recursive: true });
  fs.writeFileSync(hostFile, JSON.stringify(providersDocument('cline-pass', clineAuth('cline-user-1', 1))));
  const accountStateIndex = createAccountStateIndex({ fs, aiHomeDir });
  const accountStateService = createAccountStateService({ fs, accountStateIndex });
  // 先放掉自己开的 SQLite 句柄再删目录：Windows 上删「打开中」的 app-state.db 会 EBUSY
  // （POSIX 允许 unlink 打开中的文件，所以只有 win32 需要这层兜底，见 plugin-gateway-harness）。
  t.after(() => {
    try { accountStateIndex.close(); } catch (_closeError) {}
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      if (!(process.platform === 'win32' && error.code === 'EBUSY')) throw error;
    }
  });
  const deps = {
    fs,
    aiHomeDir,
    hostHomeDir,
    accountStateIndex,
    accountStateService,
    // 投影还没物化：状态服务对「没启动过的账号」就是这个回答。
    checkStatus: () => ({ configured: options.configured === true }),
    getProfileDir: () => '',
    serverPort: 19527
  };
  return { ...deps, deps, aiHomeDir, hostHomeDir, hostFile, writeHost: doc => fs.writeFileSync(hostFile, JSON.stringify(doc)) };
}

test('an auto-detected Cline login is pooled before its projection is ever materialized', t => {
  const f = fixture(t);
  const registered = createClineNativeCredentialSync({ fs, aiHomeDir: f.aiHomeDir, hostHomeDir: f.hostHomeDir }).scan();
  assert.equal(registered.updated.length, 1);
  const [account] = loadServerRuntimeAccounts(f.deps).cline;
  assert.ok(account, '自动识别出来的账号必须立刻进池');
  assert.equal(account.accountRef, registered.updated[0].accountRef);
  assert.equal(account.authType, 'oauth');
  assert.match(account.accessToken, /^workos:/);
  assert.equal(account.openaiBaseUrl, 'https://api.cline.bot/api/v1');
  assert.equal(account.displayName, 'User cline-user-1');
  assert.equal(account.tokenExpiresAt > Date.now(), true);
});

test('a record without any stored credential stays out of the pool', t => {
  const f = fixture(t, { configured: true });
  // 状态服务说「已配置」，但库里没有任何凭据：不能凭空进池。
  const ref = registerAccountIdentity(fs, f.aiHomeDir, { provider: 'cline', identitySeed: 'oauth:cline:user:empty' }).accountRef;
  writeAccountNativeAuth(fs, f.aiHomeDir, ref, { auth: { version: '1', providers: {} } });
  assert.deepEqual(loadServerRuntimeAccounts(f.deps).cline, []);
});

test('a manually disabled account stays out even with a stored credential', t => {
  const f = fixture(t);
  const registered = createClineNativeCredentialSync({ fs, aiHomeDir: f.aiHomeDir, hostHomeDir: f.hostHomeDir }).scan();
  assert.equal(loadServerRuntimeAccounts(f.deps).cline.length, 1);
  f.accountStateIndex.upsertRuntimeState(registered.updated[0].accountRef, 'cline', {}, {
    configured: true, status: 'down', apiKeyMode: false, authMode: 'oauth'
  });
  assert.deepEqual(loadServerRuntimeAccounts(f.deps).cline, []);
});

test('an API-key Cline account keeps pooling as before', t => {
  const f = fixture(t);
  const ref = registerAccountIdentity(fs, f.aiHomeDir, { provider: 'cline', identitySeed: 'api_key:cline:key' }).accountRef;
  writeAccountCredentials(fs, f.aiHomeDir, ref, { CLINE_API_KEY: 'cline-key' });
  const [account] = loadServerRuntimeAccounts(f.deps).cline;
  assert.equal(account.authType, 'api-key');
  assert.equal(account.accessToken, 'cline-key');
});
