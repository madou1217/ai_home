'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isAccountRef } = require('../../../account/public-account-ref');
const { readServerConfig } = require('../../../server/server-config-store');
const { DEFAULT_SERVER_API_KEY } = require('../../../server/server-defaults');

function resolveClaudeDesktopProfileScope(profileDir) {
  const normalizedProfile = path.resolve(String(profileDir || ''));
  const accountRef = path.basename(normalizedProfile);
  const providerDir = path.dirname(normalizedProfile);
  const desktopClientsDir = path.dirname(providerDir);
  const aiHomeDir = path.dirname(desktopClientsDir);
  if (
    !isAccountRef(accountRef)
    || path.basename(providerDir) !== 'claude'
    || path.basename(desktopClientsDir) !== 'desktop-clients'
  ) {
    return null;
  }
  return { accountRef, aiHomeDir, profileDir: normalizedProfile };
}

function resolveClaudeDesktopGatewayCredential(options = {}) {
  const scope = resolveClaudeDesktopProfileScope(
    options.profileDir || process.env.CLAUDE_USER_DATA_DIR
  );
  if (!scope) throw new Error('invalid_claude_desktop_profile');
  const readConfig = options.readServerConfig || readServerConfig;
  const config = readConfig({ fs: options.fs || fs, aiHomeDir: scope.aiHomeDir }) || {};
  return {
    token: String(config.apiKey || '').trim() || DEFAULT_SERVER_API_KEY
  };
}

module.exports = {
  resolveClaudeDesktopGatewayCredential,
  resolveClaudeDesktopProfileScope
};
