'use strict';

const os = require('node:os');
const path = require('node:path');

function readNonEmpty(value) {
  const text = String(value || '').trim();
  return text ? text : '';
}

function stripNestedAiHomeProfile(homeDir) {
  const input = readNonEmpty(homeDir);
  if (!input) return '';
  const normalized = input.replace(/\\/g, '/');
  const marker = '/.ai_home/profiles/';
  const idx = normalized.indexOf(marker);
  if (idx <= 0) return input;
  const root = normalized.slice(0, idx);
  return root || input;
}

function resolveHostHomeDir(options = {}) {
  const env = options.env || process.env;
  const platform = String(options.platform || process.platform);
  const osImpl = options.os || os;

  const explicit = readNonEmpty(env.AIH_HOST_HOME);
  if (explicit) return explicit;

  if (platform === 'win32') {
    const userProfile = readNonEmpty(env.USERPROFILE);
    if (userProfile) return stripNestedAiHomeProfile(userProfile);

    const homeDrive = readNonEmpty(env.HOMEDRIVE);
    const homePath = readNonEmpty(env.HOMEPATH);
    if (homeDrive && homePath) return path.join(homeDrive, homePath);
  }

  const home = readNonEmpty(env.HOME);
  if (home) return stripNestedAiHomeProfile(home);

  try {
    const userInfo = osImpl.userInfo();
    if (userInfo && userInfo.homedir) return stripNestedAiHomeProfile(String(userInfo.homedir));
  } catch (_error) {
    // fallback below
  }
  return stripNestedAiHomeProfile(osImpl.homedir());
}

module.exports = {
  resolveHostHomeDir
};
