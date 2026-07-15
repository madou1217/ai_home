'use strict';

const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const { clearExpiredAccountRuntimeState } = require('./account-runtime-state');

function startRuntimeRecoveryDaemon(state, options = {}) {
  const intervalMs = Math.max(5_000, Number(options.intervalMs) || 15_000);
  const tick = () => {
    const now = Date.now();
    SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
      const accounts = Array.isArray(state && state.accounts && state.accounts[provider]) ? state.accounts[provider] : [];
      accounts.forEach((account) => {
        clearExpiredAccountRuntimeState(account, now);
      });
    });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
    tick
  };
}

module.exports = {
  startRuntimeRecoveryDaemon
};
