'use strict';

const os = require('node:os');
const path = require('node:path');
const { decodeEncodedWindowsPath } = require('./windows-path-encoding');

function readNonEmpty(value) {
  const text = String(value || '').trim();
  return text ? text : '';
}

function stripNestedCodexHome(homeDir) {
  const input = readNonEmpty(homeDir);
  if (!input) return '';
  const normalized = input.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized.toLowerCase().endsWith('/.codex')) return input;
  const root = normalized.slice(0, -'/.codex'.length);
  return root || input;
}

function normalizeHostHomeCandidate(homeDir) {
  const decoded = decodeEncodedWindowsPath(homeDir);
  return stripNestedCodexHome(decoded);
}

function resolveHostHomeDir(options = {}) {
  const env = options.env || process.env;
  const platform = String(options.platform || process.platform);
  const osImpl = options.os || os;

  const explicit = readNonEmpty(env.AIH_HOST_HOME);
  if (explicit) return normalizeHostHomeCandidate(explicit);

  if (platform === 'win32') {
    const userProfile = readNonEmpty(env.USERPROFILE);
    if (userProfile) return normalizeHostHomeCandidate(userProfile);

    const homeDrive = readNonEmpty(env.HOMEDRIVE);
    const homePath = readNonEmpty(env.HOMEPATH);
    if (homeDrive && homePath) return normalizeHostHomeCandidate(path.join(homeDrive, homePath));
  }

  const home = readNonEmpty(env.HOME);
  if (home) return normalizeHostHomeCandidate(home);

  try {
    const userInfo = osImpl.userInfo();
    if (userInfo && userInfo.homedir) return normalizeHostHomeCandidate(String(userInfo.homedir));
  } catch (_error) {
    // fallback below
  }
  return normalizeHostHomeCandidate(osImpl.homedir());
}

module.exports = {
  resolveHostHomeDir
};
