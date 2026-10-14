'use strict';

// 回归：宿主 `cline auth` 登录被后台观察者自动登记、凭据可用、模型能探测出来，账号页却一直挂
// 「授权超时 / 未配置」。
//
// 根因：cline 与 CodeBuddy 家族同理**不在运行时账号池**里（池只装可调度账号，cline 靠
// account_state 与凭据文档在场），而登录态判定的三处消费者都只对家族写了分支：
//   1. `lib/server/webui-account-live.js` 的 `readFastAccountPresence`（账号页快速快照）；
//   2. `lib/cli/services/account/status.js` 的 `checkStatus`（账号页 hydration 与 CLI）。
// 两处都判不出「已登录」时，`auth_mode=oauth` + 未配置会被 oauth-pending-state 判成 pending，
// 5 分钟后渲染成「授权超时」。判定现在统一在 `lib/account/cline-account-status.js`。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { summarizeClineAuth } = require('../lib/account/cline-account-status');
const { createAccountStatusChecker } = require('../lib/cli/services/account/status');
const { readFastAccountPresence } = require('../lib/server/webui-account-live').__private;
const { resolveOauthPendingState } = require('../lib/server/oauth-pending-state');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const {
  readAccountCredentialRecord,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const { NOW, clineAuth, providersDocument } = require('./helpers/cline-credential');

/** Cline Pass 登录的真实形态：CLI 同时写 `cline` 与 `cline-pass` 两个槽位。 */
function clinePassDocument(subject = 'cline-user-1', generation = 1) {
  const doc = providersDocument('cline-pass', clineAuth(subject, generation));
  doc.providers.cline = {
    settings: { auth: clineAuth(subject, generation) },
    updatedAt: new Date(NOW).toISOString()
  };
  return doc;
}

test('Cline Pass 文档判为已登录，账号名取 userInfo.name', () => {
  assert.deepEqual(summarizeClineAuth({ auth: clinePassDocument() }), {
    configured: true,
    apiKeyMode: false,
    accountName: 'User cline-user-1',
    reason: ''
  });
});

test('只有 cline-pass 槽位也算已登录', () => {
  const summary = summarizeClineAuth({ auth: providersDocument('cline-pass', clineAuth('cline-user-1', 1)) });
  assert.equal(summary.configured, true);
  assert.equal(summary.accountName, 'User cline-user-1');
});

test('只有 refresh token 也算已登录（token-refresh-daemon 能把它救回来）', () => {
  const summary = summarizeClineAuth({ auth: providersDocument('cline', { refreshToken: 'refresh-only' }) });
  assert.equal(summary.configured, true);
  assert.equal(summary.apiKeyMode, false);
});

test('槽位里只有 API Key 时是 API Key 账号', () => {
  const doc = { version: '1', providers: { cline: { settings: { apiKey: 'sk-cline-test-key' } } } };
  assert.deepEqual(summarizeClineAuth({ auth: doc }), {
    configured: true,
    apiKeyMode: true,
    accountName: '',
    reason: ''
  });
});

test('文档里只有别的 provider 的槽位时判为未登录', () => {
  const doc = providersDocument('cline', clineAuth('cline-user-1', 1));
  delete doc.providers.cline;
  // 夹具里的 anthropic / openrouter 明文密钥绝不能把账号判成已登录。
  assert.deepEqual(summarizeClineAuth({ auth: doc }), {
    configured: false,
    apiKeyMode: false,
    accountName: '',
    reason: 'no_cline_credential'
  });
});

test('没有原生凭据文档时未登录', () => {
  assert.equal(summarizeClineAuth(null).configured, false);
  assert.equal(summarizeClineAuth({}).configured, false);
  assert.equal(summarizeClineAuth({ auth: {} }).reason, 'no_cline_credential');
});

test('已登录的 Cline 账号在快速快照与 checkStatus 里都不再是 pending/授权超时', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cline-status-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'cline',
    cliAccountId: '1',
    identitySeed: 'cline:cline-user-1@example.invalid'
  });
  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, { auth: clinePassDocument() });

  const checkStatus = createAccountStatusChecker({ fs, BufferImpl: Buffer, aiHomeDir });
  const credentialRecord = readAccountCredentialRecord(fs, aiHomeDir, registration.accountRef);
  const presences = [
    checkStatus('cline', registration.accountRef),
    readFastAccountPresence('cline', credentialRecord)
  ];

  for (const presence of presences) {
    assert.equal(presence.configured, true);
    // 账号页的「授权超时」= oauth 模式下未配置 + pending 已过期；两条链路都必须已配置。
    const pending = resolveOauthPendingState({
      configured: presence.configured,
      apiKeyMode: presence.apiKeyMode,
      authMode: 'oauth',
      updatedAt: Date.now() - 3600_000
    });
    assert.equal(pending.pending, false);
    assert.equal(pending.stale, false);
  }
  assert.equal(presences[0].accountName, 'User cline-user-1');
  assert.equal(presences[1].displayName, 'User cline-user-1');
});
