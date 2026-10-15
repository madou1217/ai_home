'use strict';

// Cline CLI 的 `providers.json` **类型契约**回归。
//
// 2026-10-15 实测（单变量对照，宿主可用文档只改一个字段即复现）：
//   * `version: "1"`（字符串）  → CLI 把账号判成未登录 → `Unauthorized … re-authenticate`
//   * `auth.expiresAt: "…"`（字符串）→ 同上
//   * 两者都是**毫秒数字**（CLI 自己的落盘形态）时才正常。
// 我们此前的写入/投影正好两处都写成字符串，于是「自动同步来的登录态」在沙箱里用不了。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CLINE_DOCUMENT_VERSION,
  applyClineCredentialToDocument,
  sanitizeClineProvidersDocument
} = require('../lib/account/cline-credentials');
const { clineAuth, providersDocument } = require('./helpers/cline-credential');

function clinePassDocument() {
  const doc = providersDocument('cline-pass', clineAuth('cline-user-1', 1));
  doc.providers.cline = { settings: { provider: 'cline', auth: clineAuth('cline-user-1', 1) } };
  return doc;
}

test('文档版本号是数字：字符串会被 CLI 判成未登录', () => {
  assert.equal(typeof CLINE_DOCUMENT_VERSION, 'number');
  assert.equal(sanitizeClineProvidersDocument({ version: '1', providers: {} }).version, 1);
  assert.equal(sanitizeClineProvidersDocument({ version: 2, providers: {} }).version, 2);
  assert.equal(sanitizeClineProvidersDocument({ providers: {} }).version, CLINE_DOCUMENT_VERSION);
});

test('expiresAt 归一化成毫秒数字（字符串同样会被 CLI 判成未登录）', () => {
  const doc = clinePassDocument();
  doc.providers['cline-pass'].settings.auth.expiresAt = String(doc.providers['cline-pass'].settings.auth.expiresAt);
  const sanitized = sanitizeClineProvidersDocument(doc);
  const auth = sanitized.providers['cline-pass'].settings.auth;
  assert.equal(typeof auth.expiresAt, 'number');
  assert.equal(auth.expiresAt, Number(doc.providers['cline-pass'].settings.auth.expiresAt));
});

test('刷新写回落盘的是数字（版本号与 expiresAt 都是）', () => {
  const doc = sanitizeClineProvidersDocument(clinePassDocument());
  const next = applyClineCredentialToDocument(doc, {
    accessToken: 'workos:header.payload.signature',
    refreshToken: 'refresh-new',
    expiresAt: 1_792_031_999_000
  }, 1_792_030_000_000);
  assert.equal(typeof next.version, 'number');
  for (const slot of ['cline', 'cline-pass']) {
    const auth = next.providers[slot].settings.auth;
    assert.equal(typeof auth.expiresAt, 'number', `${slot} 的 expiresAt 必须是数字`);
    assert.equal(auth.expiresAt, 1_792_031_999_000);
    assert.equal(auth.refreshToken, 'refresh-new');
  }
});

test('投影到沙箱的文档必须是 CLI 落盘形态（数字 version / 数字 expiresAt / 只留 cline 槽位）', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cline-projection-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const { registerAccountIdentity } = require('../lib/account/account-registration');
  const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
  const { materializeProviderAuth } = require('../lib/account/native-auth-projection');
  const { resolveAccountRuntimeDir } = require('../lib/runtime/aih-storage-layout');

  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'cline',
    cliAccountId: '1',
    identitySeed: 'cline:cline-user-1@example.invalid'
  });
  // 故意写一份「老形态」记录：字符串 version + 字符串 expiresAt（历史数据就是这样）。
  const legacyDoc = clinePassDocument();
  legacyDoc.version = '1';
  legacyDoc.providers['cline-pass'].settings.auth.expiresAt = String(legacyDoc.providers['cline-pass'].settings.auth.expiresAt);
  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, { auth: legacyDoc });

  const runtimeDir = resolveAccountRuntimeDir(aiHomeDir, 'cline', registration.accountRef);
  const projection = materializeProviderAuth(fs, runtimeDir, 'cline', { path, aiHomeDir, accountRef: registration.accountRef });
  assert.equal(projection.missing, false);
  const written = JSON.parse(fs.readFileSync(path.join(runtimeDir, '.cline', 'data', 'settings', 'providers.json'), 'utf8'));
  assert.equal(typeof written.version, 'number');
  assert.deepEqual(Object.keys(written.providers).sort(), ['cline', 'cline-pass']);
  for (const slot of Object.keys(written.providers)) {
    assert.equal(typeof written.providers[slot].settings.auth.expiresAt, 'number');
  }
});
