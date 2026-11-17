'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isAccountRef } = require('../../../account/public-account-ref');
const { resolveClientPlatform } = require('../../../runtime/client-platform');
const { resolvePlatformPath } = require('../../../runtime/platform-path');

const CLAUDE_DESKTOP_MODES = Object.freeze(['web', 'api']);
function failure(reason) {
  return { ok: false, status: 'failed', reason };
}

function validateProfileScope(profileDir, accountRef) {
  const normalizedProfile = path.resolve(String(profileDir || ''));
  const normalizedRef = String(accountRef || '').trim();
  return Boolean(
    isAccountRef(normalizedRef)
    && path.basename(normalizedProfile) === normalizedRef
    && path.basename(path.dirname(normalizedProfile)) === 'claude'
    && path.basename(path.dirname(path.dirname(normalizedProfile))) === 'desktop-clients'
  );
}

function resolveDefaultCredentialHelperPath() {
  return path.resolve(__dirname, '../../../../bin/claude-desktop-credential.js');
}

function invokeClaudeDesktopCore(input, options = {}) {
  const binary = options.goBinary || path.resolve(__dirname, '../../../../bin/native', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'aih-go.exe' : 'aih-go');
  const managedGateway = input.intent === 'managed-gateway';
  const typedRequest = managedGateway || input.intent === 'account-mode';
  const env = typedRequest ? {
    ...(options.env || (options.processObj || process).env || process.env),
    AIH_ROOT: path.resolve(__dirname, '../../../..')
  } : undefined;
  const result = spawnSync(binary, ['__claude-desktop-config'], { input: JSON.stringify(input), encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true,
    ...(typedRequest ? { env } : {}) });
  if (result.error || result.status !== 0) {
    const noStart = ['ENOENT', 'EACCES'].includes(result.error?.code) && !result.pid;
    return { ...failure(noStart ? 'desktop_core_unavailable' : 'desktop_core_outcome_unknown'),
      ...(noStart ? { changed: false } : { outcomeUnknown: true, recoveryRequired: true }) };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (!parsed || typeof parsed.ok !== 'boolean' || parsed.mode !== (managedGateway ? 'api' : input.mode)) throw new Error();
    return parsed;
  } catch (_) { return { ...failure('desktop_core_invalid_response'), outcomeUnknown: true, recoveryRequired: true }; }
}

function configureClaudeDesktopMode(options = {}) {
  const mode = String(options.mode || '').trim().toLowerCase();
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const accountRef = String(options.accountRef || '').trim();
  const profileDir = String(options.profileDir || '');
  if (!validateProfileScope(profileDir, accountRef)) return failure('invalid_account_scope');
  if (!CLAUDE_DESKTOP_MODES.includes(mode)) return failure('invalid_desktop_mode');
  if (!path.isAbsolute(profileDir)) return failure('invalid_profile_scope');
  if (!path.isAbsolute(aiHomeDir) || aiHomeDir.includes('\0') || profileDir.includes('\0')
    || path.resolve(profileDir) !== path.join(aiHomeDir, 'desktop-clients', 'claude', accountRef)) {
    return failure('invalid_account_scope');
  }
  return invokeClaudeDesktopCore({ intent: 'account-mode', aiHomeDir, accountRef, mode, dryRun: Boolean(options.dryRun) }, options);
}

function resolveClaudeDesktopGatewayProfileDir(options = {}) {
  const platform = resolveClientPlatform(options);
  const env = options.env || (options.processObj || process).env;
  const p = resolvePlatformPath(platform, options.path || path);
  const home = String(options.hostHomeDir || env.HOME || env.USERPROFILE || '').trim();
  if (!home) return '';
  if (platform === 'macos') return p.join(home, 'Library', 'Application Support', 'Claude-3p');
  if (platform === 'windows') return p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'Claude-3p');
  return '';
}

function configureClaudeDesktopGateway(options = {}) {
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  if (!path.isAbsolute(aiHomeDir) || !path.isAbsolute(hostHomeDir)) return failure('invalid_gateway_scope');
  return invokeClaudeDesktopCore({ intent: 'managed-gateway', aiHomeDir, hostHomeDir, dryRun: Boolean(options.dryRun) }, options);
}

module.exports = {
  CLAUDE_DESKTOP_MODES,
  configureClaudeDesktopMode,
  configureClaudeDesktopGateway,
  resolveClaudeDesktopGatewayProfileDir,
  resolveDefaultCredentialHelperPath,
  validateProfileScope
};
