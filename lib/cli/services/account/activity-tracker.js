'use strict';

function createAccountActivityTrackerService() {
  const lastActiveAccountByCli = Object.create(null);

  function markActiveAccount(cliName, id) {
    const provider = String(cliName || '').trim();
    const accountId = String(id || '').trim();
    if (!provider || !/^\d+$/.test(accountId)) return;
    lastActiveAccountByCli[provider] = accountId;
  }

  return {
    lastActiveAccountByCli,
    markActiveAccount
  };
}

module.exports = {
  createAccountActivityTrackerService
};
