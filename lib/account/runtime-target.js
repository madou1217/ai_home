'use strict';

const { isAccountRef } = require('./public-account-ref');

const GATEWAY_RUNTIME_SCOPE = 'gateway';

function resolveRuntimeTarget(input = {}) {
  if (input.gateway === true) {
    return {
      gateway: true,
      accountRef: '',
      runtimeScope: GATEWAY_RUNTIME_SCOPE
    };
  }
  const accountRef = String(input.accountRef || '').trim();
  if (!isAccountRef(accountRef)) return null;
  return {
    gateway: false,
    accountRef,
    runtimeScope: accountRef
  };
}

function serializeRuntimeTarget(target) {
  if (!target) return {};
  return target.gateway
    ? { gateway: true }
    : { accountRef: target.accountRef };
}

module.exports = {
  GATEWAY_RUNTIME_SCOPE,
  resolveRuntimeTarget,
  serializeRuntimeTarget
};
