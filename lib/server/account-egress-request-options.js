'use strict';

// 账号网络消费者只依赖这个中性边界。延迟加载底层编排服务，避免通用 HTTP
// 工具与账号存储在 CommonJS 初始化阶段互相 require。
async function resolveAccountEgressRequestOptions(input = {}) {
  const egressService = require('./zcode-egress-service');
  return egressService.resolveAccountEgressRequestOptions(input);
}

async function resolveProviderAccountEgressRequestOptions(input = {}) {
  const account = input.account && typeof input.account === 'object' ? input.account : {};
  const options = input.options && typeof input.options === 'object' ? input.options : {};
  const deps = input.deps && typeof input.deps === 'object' ? input.deps : {};
  const provider = String(input.provider || account.provider || '').trim().toLowerCase();
  const accountRef = String(account.accountRef || input.accountRef || '').trim();
  const resolver = typeof deps.resolveAccountEgressRequestOptions === 'function'
    ? deps.resolveAccountEgressRequestOptions
    : resolveAccountEgressRequestOptions;

  try {
    return await resolver({
      fs: deps.fs,
      aiHomeDir: deps.aiHomeDir || options.aiHomeDir,
      processObj: deps.processObj,
      provider,
      accountRef,
      options,
      deps: deps.accountEgressDeps || {}
    });
  } catch (error) {
    return {
      ok: false,
      bound: true,
      error: 'account_egress_unavailable',
      egressError: 'egress_resolve_failed',
      reason: String(error?.message || error || 'unknown')
    };
  }
}

function describeAccountEgressFailure(result) {
  return {
    reason: 'account_egress_unavailable',
    detail: [
      String(result?.error || ''),
      String(result?.egressError || ''),
      String(result?.reason || '')
    ].filter(Boolean).join(':') || 'account_egress_unavailable'
  };
}

module.exports = {
  describeAccountEgressFailure,
  resolveAccountEgressRequestOptions,
  resolveProviderAccountEgressRequestOptions
};
