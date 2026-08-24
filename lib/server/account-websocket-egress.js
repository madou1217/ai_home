'use strict';

const WebSocket = require('ws');
const {
  resolveProviderAccountEgressRequestOptions
} = require('./account-egress-request-options');
const { createHttpConnectAgent } = require('./websocket-http-connect');

function accountEgressUnavailable(result = {}, cause) {
  const error = new Error('account_egress_unavailable', cause ? { cause } : undefined);
  error.code = 'account_egress_unavailable';
  error.egressError = String(result.egressError || result.error || 'egress_resolve_failed');
  if (result.reason) error.reason = String(result.reason);
  return error;
}

async function resolveAccountWebSocketEgress(input = {}, deps = {}) {
  const account = input.account && typeof input.account === 'object' ? input.account : {};
  const provider = String(input.provider || account.provider || '').trim().toLowerCase();
  const requestOptions = input.requestOptions && typeof input.requestOptions === 'object'
    ? input.requestOptions
    : {};
  const resolver = typeof deps.resolveProviderAccountEgressRequestOptions === 'function'
    ? deps.resolveProviderAccountEgressRequestOptions
    : resolveProviderAccountEgressRequestOptions;
  let resolved;
  try {
    resolved = await resolver({
      provider,
      account,
      options: requestOptions,
      deps: {
        fs: input.fs || deps.fs,
        aiHomeDir: input.aiHomeDir || deps.aiHomeDir,
        processObj: input.processObj || deps.processObj,
        resolveAccountEgressRequestOptions: deps.resolveAccountEgressRequestOptions,
        accountEgressDeps: deps.accountEgressDeps || deps
      }
    });
  } catch (error) {
    throw accountEgressUnavailable({}, error);
  }
  if (!resolved?.ok || !resolved.options) {
    throw accountEgressUnavailable(resolved || {});
  }
  if (resolved.bound !== true) {
    return { bound: false, webSocketOptions: {} };
  }

  const proxyUrl = String(resolved.options.proxyUrl || '').trim();
  if (!proxyUrl) throw accountEgressUnavailable({ egressError: 'proxy_url_missing' });
  let upstream;
  try {
    upstream = new URL(String(input.upstreamUrl || '').trim());
  } catch (error) {
    throw accountEgressUnavailable({ egressError: 'invalid_websocket_upstream' }, error);
  }
  const createAgent = typeof deps.createHttpConnectAgent === 'function'
    ? deps.createHttpConnectAgent
    : createHttpConnectAgent;
  let agent;
  try {
    agent = createAgent(proxyUrl, {
      secureTarget: upstream.protocol === 'wss:',
      timeoutMs: input.connectTimeoutMs,
      ...(deps.webSocketConnectDeps || {})
    });
  } catch (error) {
    throw accountEgressUnavailable({ egressError: String(error?.code || 'proxy_connector_invalid') }, error);
  }
  return {
    bound: true,
    webSocketOptions: {
      agent
    }
  };
}

async function createAccountWebSocket(input = {}, deps = {}) {
  const egress = await resolveAccountWebSocketEgress(input, deps);
  const WebSocketClass = deps.WebSocket || WebSocket;
  return new WebSocketClass(String(input.upstreamUrl || ''), {
    ...(input.webSocketOptions || {}),
    ...egress.webSocketOptions
  });
}

module.exports = {
  createAccountWebSocket,
  resolveAccountWebSocketEgress
};
