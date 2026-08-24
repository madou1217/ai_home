'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  ACCOUNT_EGRESS_NO_PROXY,
  resolveAccountEgressRuntimeProxy
} = require('../runtime/account-egress-proxy');

async function resolveRuntimeAccountEgressRequestOptions(input = {}, deps = {}) {
  const accountRef = String(input.accountRef || input.account?.accountRef || '').trim();
  const options = input.options && typeof input.options === 'object'
    ? { ...input.options }
    : {};
  if (!accountRef) return { ok: true, bound: false, options };

  const aiHomeDir = String(input.aiHomeDir || deps.aiHomeDir || '').trim();
  if (!aiHomeDir) {
    return {
      ok: false,
      bound: true,
      error: 'account_egress_unavailable',
      egressError: 'account_egress_context_missing'
    };
  }
  const resolver = typeof deps.resolveAccountEgressRuntimeProxy === 'function'
    ? deps.resolveAccountEgressRuntimeProxy
    : resolveAccountEgressRuntimeProxy;
  let egress;
  try {
    egress = resolver({
      fs: input.fs || deps.fs || fs,
      path: input.path || deps.path || path,
      aiHomeDir,
      accountRef,
      processObj: input.processObj || deps.processObj || process
    });
  } catch (error) {
    return {
      ok: false,
      bound: true,
      error: 'account_egress_unavailable',
      egressError: String(error?.code || error?.message || 'account_egress_runtime_unavailable')
    };
  }
  if (!egress?.bound) return { ok: true, bound: false, options };
  const proxyServer = String(egress.proxyServer || '').trim();
  if (!proxyServer) {
    return {
      ok: false,
      bound: true,
      error: 'account_egress_unavailable',
      egressError: 'account_egress_endpoint_invalid'
    };
  }
  return {
    ok: true,
    bound: true,
    options: {
      ...options,
      proxyUrl: `http://${proxyServer}`,
      noProxy: ACCOUNT_EGRESS_NO_PROXY
    }
  };
}

module.exports = {
  resolveRuntimeAccountEgressRequestOptions
};
