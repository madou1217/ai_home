'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { WORKSPACE_ERRORS, resolveCodexWorkspace } = require('../lib/account/codex-workspace');

const vectorsPath = path.join(__dirname, '..', 'contracts', 'go-bridge', 'codex-workspace-vectors.json');
const { vectors } = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));

const ERROR_CLASS = Object.freeze({
  [WORKSPACE_ERRORS.invalidIdToken]: 'invalid_id_token',
  [WORKSPACE_ERRORS.invalidAccountId]: 'invalid_account_id',
  [WORKSPACE_ERRORS.accountIdMismatch]: 'account_id_mismatch'
});

// 与 core/accounts/codex/workspace_contract_test.go 读取同一份样例：两端任一漂移都会失败。
for (const vector of vectors) {
  test(`codex workspace contract: ${vector.name}`, () => {
    const idToken = vector.id_token
      || `h.${Buffer.from(JSON.stringify(vector.claims)).toString('base64url')}.s`;
    const tokens = { id_token: idToken, access_token: 'access-token', refresh_token: 'refresh-token' };
    if (vector.explicit_account_id !== undefined) tokens.account_id = vector.explicit_account_id;

    const result = resolveCodexWorkspace({ auth_mode: 'chatgpt', tokens });

    if (!vector.expect.ok) {
      assert.equal(result.ok, false);
      assert.equal(ERROR_CLASS[result.error], vector.expect.error);
      return;
    }
    assert.equal(result.ok, true, result.error);
    assert.equal(result.workspaceId, vector.expect.workspace_id);
    assert.equal(result.upstreamAccountId, vector.expect.upstream_account_id);
  });
}
