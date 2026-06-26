'use strict';

function createAccountQueryListFns(deps = {}) {
  const accountQueryService = deps.accountQueryService;
  return {
    listUsageCandidateIds(provider) {
      if (!accountQueryService || typeof accountQueryService.listUsageCandidateAccountIds !== 'function') return [];
      return accountQueryService.listUsageCandidateAccountIds(provider);
    },
    listConfiguredIds(provider) {
      if (!accountQueryService || typeof accountQueryService.listConfiguredAccountIds !== 'function') return [];
      return accountQueryService.listConfiguredAccountIds(provider);
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
