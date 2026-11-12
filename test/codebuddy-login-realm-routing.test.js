'use strict';

// 回归守卫（2026-10-31 真机）：`aih codebuddy login` 时在 CLI 首启的站点菜单里选了
// 「国内站」，OAuth 授权成功，却报
//   Login completed but account identity could not be persisted (missing_projection)
//
// 根因：`@tencent-ai/codebuddy-code` 国内站与国际站是同一个二进制，站点由用户在
// CLI 首启菜单里选；aih 却拿「用户敲的是 aih codebuddy 还是 aih codebuddycn」当作
// 站点归属去校验 realm。国内站 token 的 iss 是 copilot.tencent.com，按国际站校验
// 必然 credential_realm_mismatch，而这个内部原因又被吞成了笼统的 missing_projection。
//
// 约定：**归属只由 token 的 realm 判定**（见 provider-storage-policy 里对
// CODEBUDDY_INTL_SHARED_AUTH_PATH 的注释）。登记时必须按 realm 换档，并把真实
// Provider 回给调用方。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  registerProviderAuthProjection
} = require('../lib/account/native-auth-projection');
const { listAccountCredentialRecords } = require('../lib/server/account-credential-store');

const INTL_ISSUER = 'https://www.codebuddy.ai/auth/realms/copilot';
const CN_ISSUER = 'https://www.codebuddy.cn/auth/realms/copilot';
const ENTERPRISE_ISSUER = 'https://copilot.example-corp.com/auth/realms/copilot';

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(issuer, uid) {
  const now = Math.floor(Date.now() / 1000);
  return [
    encode({ alg: 'none' }),
    encode({ iss: issuer, sub: uid, iat: now, exp: now + 3600 }),
    'sig'
  ].join('.');
}

function credential(issuer, uid) {
  return {
    auth: {
      accessToken: token(issuer, uid),
      refreshToken: token(issuer, uid),
      domain: new URL(issuer).hostname,
      lastRefreshTime: Date.now()
    },
    account: { uid, nickname: 'realm-test' }
  };
}

// 独立分发的 CLI 无论选哪个站点都写这一个文件（host id 相同），站点只能从 token 里看。
function writeIntlFile(runtimeDir, value) {
  const dir = path.join(runtimeDir, 'Library', 'Application Support',
    'CodeBuddyExtension', 'Data', 'Public', 'auth');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Tencent-Cloud.coding-copilot.info'), JSON.stringify(value));
}

function withTemp(t, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cb-realm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, 'ai-home');
  const runtimeDir = path.join(root, 'login-runtime');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  return fn({ aiHomeDir, runtimeDir });
}

test('国内站 token 落在国际站文件里：按 codebuddycn 登记，而不是报 missing_projection', (t) => withTemp(t, ({ aiHomeDir, runtimeDir }) => {
  writeIntlFile(runtimeDir, credential(CN_ISSUER, 'uid-cn-1'));

  const registration = registerProviderAuthProjection(fs, runtimeDir, 'codebuddy', { aiHomeDir });

  assert.equal(registration.registered, true);
  assert.equal(registration.provider, 'codebuddycn');
  assert.ok(registration.accountRef);
  assert.equal(listAccountCredentialRecords(fs, aiHomeDir, 'codebuddycn').length, 1);
  assert.equal(listAccountCredentialRecords(fs, aiHomeDir, 'codebuddy').length, 0);
}));

test('国际站 token：仍登记为 codebuddy（不因为新增改档逻辑而漂移）', (t) => withTemp(t, ({ aiHomeDir, runtimeDir }) => {
  writeIntlFile(runtimeDir, credential(INTL_ISSUER, 'uid-intl-1'));

  const registration = registerProviderAuthProjection(fs, runtimeDir, 'codebuddy', { aiHomeDir });

  assert.equal(registration.registered, true);
  assert.equal(registration.provider, 'codebuddy');
  assert.equal(listAccountCredentialRecords(fs, aiHomeDir, 'codebuddy').length, 1);
}));

test('codebuddycn 登录拿到国际站 token：同样按 realm 改档到 codebuddy', (t) => withTemp(t, ({ aiHomeDir, runtimeDir }) => {
  writeIntlFile(runtimeDir, credential(INTL_ISSUER, 'uid-intl-2'));

  const registration = registerProviderAuthProjection(fs, runtimeDir, 'codebuddycn', { aiHomeDir });

  assert.equal(registration.registered, true);
  assert.equal(registration.provider, 'codebuddy');
  assert.equal(listAccountCredentialRecords(fs, aiHomeDir, 'codebuddy').length, 1);
}));

test('企业域名（未知 realm）不再报笼统 missing_projection，而是给出真实原因', (t) => withTemp(t, ({ aiHomeDir, runtimeDir }) => {
  writeIntlFile(runtimeDir, credential(ENTERPRISE_ISSUER, 'uid-corp-1'));

  const registration = registerProviderAuthProjection(fs, runtimeDir, 'codebuddy', { aiHomeDir });

  assert.equal(registration.registered, false);
  assert.equal(registration.reason, 'unrecognized_credential_realm');
}));

test('CLI 没写出凭据：原因是 credential_file_missing，不是 missing_projection', (t) => withTemp(t, ({ aiHomeDir, runtimeDir }) => {
  const registration = registerProviderAuthProjection(fs, runtimeDir, 'codebuddy', { aiHomeDir });

  assert.equal(registration.registered, false);
  assert.equal(registration.reason, 'credential_file_missing');
}));

test('同一身份重复登录不产生第二个账号', (t) => withTemp(t, ({ aiHomeDir, runtimeDir }) => {
  writeIntlFile(runtimeDir, credential(CN_ISSUER, 'uid-cn-2'));
  const first = registerProviderAuthProjection(fs, runtimeDir, 'codebuddy', { aiHomeDir });
  const second = registerProviderAuthProjection(fs, runtimeDir, 'codebuddy', { aiHomeDir });

  assert.equal(second.provider, 'codebuddycn');
  assert.equal(second.accountRef, first.accountRef);
  assert.equal(listAccountCredentialRecords(fs, aiHomeDir, 'codebuddycn').length, 1);
}));
