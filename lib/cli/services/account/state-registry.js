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
      const { createGoRuntimeStateReader } = require('../../../account/go-bridge/go-runtime-state-reader');
      // 运行态文档由 Go 持久化：CLI 只读 aih.db（短 TTL 快照），不再依赖服务端写过的旧列。
      accountStateIndex = createAccountStateIndex({
        aiHomeDir,
        fs,
        runtimeStates: createGoRuntimeStateReader({ aiHomeDir, fs })
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
