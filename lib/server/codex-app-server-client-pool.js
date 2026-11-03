'use strict';

const { ensureCodexAppServerEndpoint } = require('./codex-app-server-endpoint');
const { createAppServerClient } = require('./codex-app-server-json-rpc-client');

const CLIENTS = new Map();

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function codedError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function getAppServerClient(options = {}) {
  return getAppServerClientEntry(options).client;
}

function acquireAppServerClient(options = {}) {
  const runtimeScope = normalizeString(options.runtimeScope);
  const entry = getAppServerClientEntry(options);
  entry.leaseCount += 1;
  let released = false;
  return Object.freeze({
    client: entry.client,
    release() {
      if (released) return false;
      released = true;
      entry.leaseCount = Math.max(0, entry.leaseCount - 1);
      closeIdleClient(runtimeScope, entry);
      return true;
    }
  });
}

function getAppServerClientEntry(options = {}) {
  const runtimeScope = normalizeString(options.runtimeScope);
  const runtimeFingerprint = normalizeString(options.runtimeFingerprint);
  const target = clientTarget(options);
  requireAccountIdentityValidator(target, options.accountIdentityValidator);

  let clientEntry = CLIENTS.get(runtimeScope);
  if (
    clientEntry
    && sameClientRuntime(clientEntry, runtimeFingerprint)
    && sameClientTarget(clientEntry.target, target)
  ) {
    return clientEntry;
  }
  if (clientEntry && hasResidentOwners(clientEntry)) {
    throw replacementConflict(clientEntry.target, target);
  }
  if (clientEntry) clientEntry.client.destroy();

  clientEntry = createClientEntry({
    options,
    runtimeFingerprint,
    runtimeScope,
    target
  });
  CLIENTS.set(runtimeScope, clientEntry);
  return clientEntry;
}

function requireAccountIdentityValidator(target, validator) {
  if (target.accountRef && !target.gateway && typeof validator !== 'function') {
    throw codedError(
      'codex_account_identity_validator_required',
      'account-scoped Codex app-server requires identity validation'
    );
  }
}

function replacementConflict(currentTarget, requestedTarget) {
  if (!sameClientTarget(currentTarget, requestedTarget)) {
    return codedError(
      'codex_client_target_conflict',
      'Codex resident client target changed while it is still owned'
    );
  }
  return codedError(
    'codex_runtime_refresh_conflict',
    '默认 Codex runtime 已变化，但同账号仍有会话持有该 runtime'
  );
}

function createClientEntry({ options, runtimeFingerprint, runtimeScope, target }) {
  const entry = { client: null, leaseCount: 0, runtimeFingerprint, target };
  entry.client = createAppServerClient({
    wsImpl: options.wsImpl,
    accountIdentityValidator: options.accountIdentityValidator,
    onIdle: () => closeIdleClient(runtimeScope, entry),
    resolveEndpoint: () => resolveClientEndpoint(options)
  });
  return entry;
}

async function resolveClientEndpoint(options) {
  const injectedEndpoint = normalizeString(options.endpoint);
  if (injectedEndpoint) return injectedEndpoint;
  const { port } = await ensureCodexAppServerEndpoint(options);
  return `ws://127.0.0.1:${port}`;
}

function closeIdleClient(runtimeScope, entry) {
  if (!entry || entry.leaseCount > 0 || hasActiveTurns(entry.client)) return false;
  entry.client.destroy();
  if (CLIENTS.get(runtimeScope) === entry) CLIENTS.delete(runtimeScope);
  return true;
}

function sameClientRuntime(entry, fingerprint) {
  return !fingerprint || entry.runtimeFingerprint === fingerprint;
}

function clientTarget(options = {}) {
  return Object.freeze({
    accountRef: normalizeString(options.accountRef),
    gateway: options.gateway === true
  });
}

function sameClientTarget(left = {}, right = {}) {
  return left.accountRef === right.accountRef && left.gateway === right.gateway;
}

function hasResidentOwners(entry) {
  return Boolean(entry && (entry.leaseCount > 0 || hasActiveTurns(entry.client)));
}

function hasActiveTurns(client) {
  return Boolean(client && typeof client.hasActiveTurns === 'function' && client.hasActiveTurns());
}

function __resetClientsForTest() {
  for (const [, clientEntry] of CLIENTS) {
    try {
      if (clientEntry.client && typeof clientEntry.client.destroy === 'function') {
        clientEntry.client.destroy();
      }
    } catch (_error) { /* ignore */ }
  }
  CLIENTS.clear();
}

module.exports = {
  acquireAppServerClient,
  getAppServerClient,
  __resetClientsForTest
};
