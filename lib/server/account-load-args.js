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

// 账号运行池的加载参数：账号状态服务与运行态门禁都必须沿 deps 传下去，
// 否则 accounts.js 里的恢复路径只能退回「直接写账号状态服务」（见 account-runtime-gate）。
function withAccountQueryListFns(args = {}, deps = {}) {
  return {
    ...args,
    accountStateService: args.accountStateService || deps.accountStateService,
    accountRuntimeGate: args.accountRuntimeGate || deps.accountRuntimeGate,
    ...createAccountQueryListFns(deps)
  };
}

module.exports = {
  createAccountQueryListFns,
  withAccountQueryListFns
};
