'use strict';

function createAccountQueryListFns(deps = {}) {
  const accountQueryService = deps.accountQueryService;
  return {
    listUsageCandidateRefs(provider) {
      if (!accountQueryService || typeof accountQueryService.listUsageCandidateAccountRefs !== 'function') return [];
      return accountQueryService.listUsageCandidateAccountRefs(provider);
    },
    listConfiguredRefs(provider) {
      if (!accountQueryService || typeof accountQueryService.listConfiguredAccountRefs !== 'function') return [];
      return accountQueryService.listConfiguredAccountRefs(provider);
    }
  };
}

function withAccountQueryListFns(args = {}, deps = {}) {
  return {
    ...args,
    accountStateService: args.accountStateService || deps.accountStateService,
    ...createAccountQueryListFns(deps)
  };
}

module.exports = {
  createAccountQueryListFns,
  withAccountQueryListFns
};
