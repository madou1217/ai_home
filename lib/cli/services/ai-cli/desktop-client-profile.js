'use strict';

const nodePath = require('node:path');
const { isAccountRef } = require('../../../account/public-account-ref');
const { providerCatalog } = require('../../../provider-catalog');

const DESKTOP_CLIENTS_DIR = 'desktop-clients';
const PRIVATE_DIRECTORY_MODE = 0o700;

function resolveDesktopClientProfileDir(aiHomeDir, provider, accountRef, pathImpl = nodePath) {
  const root = String(aiHomeDir || '').trim();
  const normalizedProvider = providerCatalog.normalize(provider);
  const normalizedRef = String(accountRef || '').trim();
  if (!root || !normalizedProvider || !isAccountRef(normalizedRef)) return '';
  return pathImpl.join(root, DESKTOP_CLIENTS_DIR, normalizedProvider, normalizedRef);
}

function prepareDesktopClientProfile(options = {}) {
  const fs = options.fs;
  const profileDir = resolveDesktopClientProfileDir(
    options.aiHomeDir,
    options.provider,
    options.accountRef,
    options.path || nodePath
  );
  if (!profileDir || !fs || typeof fs.mkdirSync !== 'function') return '';
  fs.mkdirSync(profileDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (typeof fs.chmodSync === 'function') {
    fs.chmodSync(profileDir, PRIVATE_DIRECTORY_MODE);
  }
  return profileDir;
}

module.exports = {
  DESKTOP_CLIENTS_DIR,
  prepareDesktopClientProfile,
  resolveDesktopClientProfileDir
};
