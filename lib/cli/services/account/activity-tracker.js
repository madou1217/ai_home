'use strict';

function createAccountActivityTrackerService() {
  const lastActiveAccountByCli = Object.create(null);

  function markActiveAccount(cliName, accountRef) {
    const provider = String(cliName || '').trim();
    const ref = String(accountRef || '').trim();
    if (!provider || !/^acct_[a-f0-9]{20}$/.test(ref)) return;
    lastActiveAccountByCli[provider] = ref;
  }

  return {
    lastActiveAccountByCli,
    markActiveAccount
  };
}

module.exports = {
  createAccountActivityTrackerService
};
