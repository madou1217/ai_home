'use strict';

const path = require('node:path');
const { containsMappedRef } = require('./codex-rekey-reference-policy');

/** Both names are in scope: after a forward migration its new root is still owned. */
function includesAffectedIdentity(text, mapping) {
  const identities = new Map([...mapping].flatMap(([before, after]) => [[before, after], [after, before]]));
  return containsMappedRef(text, identities);
}

/**
 * These two producers persist derived liveness/installation observations, not
 * account identities: account-activity.js and codex-cli-hook.js. Other CLI/App
 * processes can refresh them while an unrelated account is maintained. Only
 * their recognized schema and complete absence of either target identity make
 * content outside this transaction; path/owner/mode/existence remain checked.
 * No general timestamp stripping or 'ignore changed config' rule is introduced.
 */
function isUnrelatedLiveObservation(relative, text, mapping) {
  const key = relative.split(path.sep).join('/');
  if (!['run/account-activity.json', 'run/codex/cli-hook-state.json'].includes(key)) return false;
  let document;
  try { document = JSON.parse(text); } catch (_) { return false; }
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || includesAffectedIdentity(text, mapping) || includesAffectedIdentity(JSON.stringify(document), mapping)) return false;
  const allowed = key === 'run/account-activity.json'
    ? new Set(['updatedAt', 'accounts'])
    : new Set(['version', 'enabled', 'updatedAt', 'targetBinaryPath', 'upstreamBinaryPath', 'reason']);
  if (Object.keys(document).some(field => !allowed.has(field))) return false;
  if (key === 'run/account-activity.json') {
    return Number.isFinite(document.updatedAt) && document.accounts !== null
      && typeof document.accounts === 'object' && !Array.isArray(document.accounts);
  }
  return Number.isInteger(document.version) && typeof document.enabled === 'boolean'
    && typeof document.updatedAt === 'string';
}

function isUnrelatedNativeDiagnostic(relative, kind, mapping) {
  return kind === 'logs' && !includesAffectedIdentity(relative, mapping);
}

module.exports = { includesAffectedIdentity, isUnrelatedLiveObservation, isUnrelatedNativeDiagnostic };
