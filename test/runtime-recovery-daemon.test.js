const test = require('node:test');
const assert = require('node:assert/strict');

const { startRuntimeRecoveryDaemon } = require('../lib/server/runtime-recovery-daemon');

test('runtime recovery daemon clears expired cooldown state on tick', async () => {
  const state = {
    accounts: {
      codex: [{
        id: '1',
        cooldownUntil: Date.now() - 1000,
        rateLimitUntil: Date.now() - 1000,
        lastFailureKind: 'rate_limited',
        consecutiveFailures: 2
      }],
      gemini: [],
      claude: []
    }
  };

  const daemon = startRuntimeRecoveryDaemon(state, { intervalMs: 5000 });
  try {
    daemon.tick();
    assert.equal(state.accounts.codex[0].cooldownUntil, 0);
    assert.equal(state.accounts.codex[0].rateLimitUntil, 0);
    assert.equal(state.accounts.codex[0].consecutiveFailures, 0);
  } finally {
    daemon.stop();
  }
});
