'use strict';

const nodePath = require('node:path');
const { listAccountRefRecords, isAccountRef } = require('./account-ref-store');
const { resolveAihRunPath } = require('../runtime/aih-storage-layout');
const { invalidateCodexAppServerEndpoint } = require('./codex-app-server-endpoint');

function readStateTarget(name, state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const runtimeScope = name.slice(0, -'.json'.length);
  const runtimeNamespace = runtimeScope.startsWith('chat-') ? 'chat' : '';
  const accountRef = runtimeNamespace ? runtimeScope.slice('chat-'.length) : runtimeScope;
  if (!isAccountRef(accountRef)
    || (state.accountRef && state.accountRef !== accountRef)
    || (state.runtimeScope && state.runtimeScope !== runtimeScope)) return null;
  return { accountRef, ...(runtimeNamespace ? { runtimeNamespace } : {}) };
}

function pruneStaleCodexAppServerStates(options = {}) {
  const { fs, aiHomeDir, spawnSyncImpl, accountStateIndex } = options;
  const path = options.path || nodePath;
  if (!fs || !String(aiHomeDir || '').trim()) {
    throw new Error('codex_app_server_prune_missing_context');
  }
  // Chat harnesses serve every provider. Read the complete canonical registry
  // before stopping anything; a corrupt schema must never look like deletion.
  const registeredRefs = new Set(listAccountRefRecords(fs, aiHomeDir)
    .map((record) => record.accountRef));
  const invalidate = options.invalidateCodexAppServerEndpoint || invalidateCodexAppServerEndpoint;
  const result = { removed: 0, kept: 0, failed: 0 };
  const stateDir = resolveAihRunPath(aiHomeDir, 'codex-app-server');
  let entries;
  try {
    entries = fs.readdirSync(stateDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return result;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    if (entry.name === 'gateway.json' || entry.name === 'chat-gateway.json') {
      result.kept += 1;
      continue;
    }
    const statePath = path.join(stateDir, entry.name);
    try {
      const target = readStateTarget(entry.name, JSON.parse(fs.readFileSync(statePath, 'utf8')));
      if (!target) {
        result.failed += 1;
        continue;
      }
      const registered = registeredRefs.has(target.accountRef);
      const persisted = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
        ? accountStateIndex.getAccountState(target.accountRef)
        : null;
      // A disabled account remains in account_refs so its history can be
      // inspected, but its resident app-server must not survive the lifecycle
      // transition. Otherwise a later resume can keep talking to the old
      // upstream even though every normal selector excludes the account.
      const disabled = registered && persisted && String(persisted.status || '').trim().toLowerCase() !== 'up';
      if (registered && !disabled) {
        result.kept += 1;
        continue;
      }
      // The endpoint lifecycle owns socket/port cleanup and state removal. Do
      // not unlink state directly when the owning process cannot be verified.
      invalidate({ ...target, aiHomeDir, spawnSyncImpl });
      if (fs.existsSync(statePath)) result.failed += 1;
      else result.removed += 1;
    } catch (_error) {
      result.failed += 1;
    }
  }
  return result;
}

module.exports = { pruneStaleCodexAppServerStates };
