'use strict';

function createAccountStateRegistryService(options = {}) {
  const {
    fs,
    aiHomeDir,
    getProfileDir
  } = options;

  let accountStateIndex = null;
  let accountStateService = null;
  let accountQueryService = null;

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

  function getAccountStateService() {
    if (!accountStateService) {
      const { createAccountStateService } = require('../../../account/state-service');
      accountStateService = createAccountStateService({
        fs,
        getAccountStateIndex,
        getProfileDir,
        stateIndexClient: options.stateIndexClient
      });
    }
    return accountStateService;
  }

  function getAccountQueryService() {
    if (!accountQueryService) {
      const { createAccountQueryService } = require('../../../account/query-service');
      accountQueryService = createAccountQueryService({
        getAccountStateIndex
      });
    }
    return accountQueryService;
  }

  return {
    getAccountStateIndex,
    getAccountStateService,
    getAccountQueryService
  };
}

module.exports = {
  createAccountStateRegistryService
};
