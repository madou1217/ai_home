'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCodexSessionOwnershipIndex } = require('../lib/usage/codex-session-ownership');

const ACCOUNT_A = 'acct_0123456789abcdef0123';
const ACCOUNT_B = 'acct_1123456789abcdef0123';
const THREAD_A = '019f698a-a7b0-7041-b4a2-41cfb5f0de48';
const THREAD_B = '019f698a-a7b0-7041-b4a2-41cfb5f0de49';
const THREAD_AMBIGUOUS = '019f698a-a7b0-7041-b4a2-41cfb5f0de50';

test('Codex session ownership uses only unique account-scoped registry entries', () => {
  const index = createCodexSessionOwnershipIndex({
    aiHomeDir: '/tmp/aih-test',
    registry: {
      listEntries() {
        return [
          { provider: 'codex', accountRef: ACCOUNT_A, nativeSessionId: THREAD_A },
          { provider: 'codex', accountRef: ACCOUNT_B, forwardArgs: ['resume', THREAD_B] },
          { provider: 'codex', accountRef: ACCOUNT_A, nativeSessionId: THREAD_AMBIGUOUS },
          { provider: 'codex', accountRef: ACCOUNT_B, nativeSessionId: THREAD_AMBIGUOUS },
          { provider: 'codex', gateway: true, accountRef: '', nativeSessionId: '019f698a-a7b0-7041-b4a2-41cfb5f0de51' }
        ];
      }
    }
  });

  assert.equal(index.resolveAccountRef(THREAD_A), ACCOUNT_A);
  assert.equal(index.resolveAccountRef(THREAD_B), ACCOUNT_B);
  assert.equal(index.resolveAccountRef(THREAD_AMBIGUOUS), '');
  assert.equal(index.resolveAccountRef('missing'), '');
});
