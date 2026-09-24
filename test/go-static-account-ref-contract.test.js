'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { goStaticAccountIdentity } = require('../lib/account/go-bridge/go-static-account-ref');

const { vectors } = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'contracts', 'go-bridge', 'static-account-ref-vectors.json'), 'utf8'
));

// 期望值由 Go 生成，并由 internal/adapters/accounts/gobridgecontract 同时断言。
for (const vector of vectors) {
  test(`Go static account ref contract: ${vector.provider}/${vector.kind} ${JSON.stringify(vector.base_url)}`, () => {
    const identity = goStaticAccountIdentity(vector.provider, vector.kind, vector.secret, vector.base_url);
    if (!vector.expect.valid) {
      assert.equal(identity, null);
      return;
    }
    assert.ok(identity, 'Node must reproduce an identity Go accepts');
    assert.equal(identity.accountRef, vector.expect.account_ref);
    assert.equal(identity.baseUrl, vector.expect.base_url);
  });
}
