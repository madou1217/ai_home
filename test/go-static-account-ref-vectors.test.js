'use strict';

// contracts/go-bridge/static-account-ref-vectors.json 是 Go/Node 静态身份公式的
// 共享向量；Go 侧由 core/accounts/{codex,claude} 的测试守卫，这里守卫 Node 预测器。
// 2026-11-04 起两端统一用 sha256 十六进制前 16 位（Node 旧公式）。

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const { goStaticAccountIdentity } = require('../lib/account/go-bridge/go-static-account-ref');

const vectors = require(path.join(__dirname, '..', 'contracts/go-bridge/static-account-ref-vectors.json')).vectors;

test('Node predictor matches every valid Go static identity vector', () => {
  for (const vector of vectors) {
    const identity = goStaticAccountIdentity(
      vector.provider,
      vector.kind,
      vector.secret,
      vector.base_url
    );
    if (!vector.expect.valid) {
      assert.equal(identity, null, `${vector.provider}/${vector.kind}/${vector.secret} should be invalid`);
      continue;
    }
    assert.ok(identity, `${vector.provider}/${vector.kind}/${vector.secret} should be valid`);
    assert.equal(identity.accountRef, vector.expect.account_ref);
    assert.equal(identity.baseUrl, vector.expect.base_url);
    const fingerprint = crypto.createHash('sha256').update(vector.secret).digest('hex').slice(0, 16);
    assert.equal(
      identity.seed,
      `${vector.kind}:${vector.provider}:${vector.expect.base_url}:${fingerprint}`,
      'seed must use the 16-char fingerprint and canonical base URL'
    );
  }
});
