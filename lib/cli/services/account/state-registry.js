'use strict';

function createAccountStateRegistryService(options = {}) {
  const {
    fs,
    aiHomeDir
  } = options;

  let accountStateIndex = null;

  function getAccountStateIndex() {
    if (!accountStateIndex) {
      const { createAccountStateIndex } = require('../../../account/state-index');
      accountStateIndex = createAccountStateIndex({
        aiHomeDir,
        fs
      });
    }
    return accountStateIndex;
  }

  return {
    getAccountStateIndex
  };
}

module.exports = {
  createAccountStateRegistryService
};
