'use strict';

const { allocateCliAccountId } = require('../../../account/account-id-allocator');

function createProfileAccountService(options = {}) {
  const {
    fs,
    aiHomeDir
  } = options;

  function getNextId(cliName) {
    return allocateCliAccountId(fs, aiHomeDir, cliName);
  }

  function createAccount(cliName, id) {
    const provider = String(cliName || '').trim().toLowerCase();
    const cliAccountId = String(id || '').trim();
    if (!provider || !/^\d+$/.test(cliAccountId)) return false;
    console.log(`\x1b[36m[aih]\x1b[0m Prepared login for \x1b[33m${provider}\x1b[0m (Account ID: \x1b[32m${cliAccountId}\x1b[0m)`);
    return true;
  }

  return {
    getNextId,
    createAccount
  };
}

module.exports = {
  createProfileAccountService
};
