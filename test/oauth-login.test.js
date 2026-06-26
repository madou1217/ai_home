const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ERROR_CODES,
  executeOAuthFlow,
  resolveOAuthFlow
} = require('../lib/auth/oauth-login');

test('resolveOAuthFlow maps provider to provider-specific OAuth action', () => {
  const codex = resolveOAuthFlow({ cli: 'codex', account_id: '7' });
  assert.equal(codex.ok, true);
  assert.equal(codex.value.oauth_action, 'login');
  assert.deepEqual(codex.value.args, ['codex', '7', 'login']);

  const gemini = resolveOAuthFlow({ cli: 'google', account_id: 'acct_1' });
  assert.equal(gemini.ok, true);
  assert.equal(gemini.value.cli, 'gemini');
  assert.equal(gemini.value.oauth_action, 'auth');
  assert.deepEqual(gemini.value.args, ['gemini', 'acct_1', 'auth']);
});

test('resolveOAuthFlow returns machine-readable errors for invalid input', () => {
  const badProvider = resolveOAuthFlow({ cli: 'unknown', account_id: '7' });
  assert.equal(badProvider.ok, false);
  assert.equal(badProvider.error.code, ERROR_CODES.UNKNOWN_PROVIDER);

  const badAccount = resolveOAuthFlow({ cli: 'codex', account_id: 'bad id' });
  assert.equal(badAccount.ok, false);
  assert.equal(badAccount.error.code, ERROR_CODES.INVALID_ACCOUNT_ID);
});

test('executeOAuthFlow returns normalized success payload', async () => {
  const result = await executeOAuthFlow(
    { cli: 'claude', account_id: '12' },
    async (flow) => {
      assert.equal(flow.oauth_action, 'login');
      assert.deepEqual(flow.args, ['claude', '12', 'login']);
      return { exitCode: 0, stdout: 'done', stderr: '' };
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.value.cli, 'claude');
  assert.equal(result.value.account_id, '12');
  assert.equal(result.value.oauth_action, 'login');
  assert.equal(result.value.exit_code, 0);
});

test('executeOAuthFlow returns deterministic failure/throw errors', async () => {
  const failed = await executeOAuthFlow(
    { cli: 'codex', account_id: '2' },
    async () => ({ exitCode: 9, stderr: 'network error' })
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, ERROR_CODES.OAUTH_EXECUTION_FAILED);
  assert.equal(failed.error.details.exit_code, 9);

  const thrown = await executeOAuthFlow(
    { cli: 'gemini', account_id: '2' },
    async () => {
      throw new Error('socket disconnected');
    }
  );
  assert.equal(thrown.ok, false);
  assert.equal(thrown.error.code, ERROR_CODES.OAUTH_EXECUTION_THROWN);
});
