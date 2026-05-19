'use strict';

const path = require('node:path');

function readNonEmpty(value) {
  const text = String(value || '').trim();
  return text ? text : '';
}

function resolveHostHomeDirFromAiHomeDir(aiHomeDir, pathImpl = path) {
  const root = readNonEmpty(aiHomeDir);
  if (!root) return '';
  const base = pathImpl.basename(root);
  if (base === '.ai_home' || base === 'ai_home') {
    return pathImpl.dirname(root);
  }
  return pathImpl.dirname(root);
}

function resolveHostHomeDirFromProfileDir(profileDir, pathImpl = path) {
  const profile = readNonEmpty(profileDir);
  if (!profile) return '';
  const providerDir = pathImpl.dirname(profile);
  const profilesDir = pathImpl.dirname(providerDir);
  if (pathImpl.basename(profilesDir) !== 'profiles') return '';
  const aiHomeDir = pathImpl.dirname(profilesDir);
  const aiHomeBase = pathImpl.basename(aiHomeDir);
  if (aiHomeBase !== '.ai_home' && aiHomeBase !== 'ai_home') return '';
  return pathImpl.dirname(aiHomeDir);
}

function resolveCodexSqliteHome(options = {}) {
  const pathImpl = options.path || path;
  const explicit = readNonEmpty(options.hostHomeDir);
  const hostHomeDir = explicit
    || resolveHostHomeDirFromAiHomeDir(options.aiHomeDir, pathImpl)
    || resolveHostHomeDirFromProfileDir(options.profileDir, pathImpl);
  return hostHomeDir ? pathImpl.join(hostHomeDir, '.codex') : '';
}

module.exports = {
  resolveHostHomeDirFromAiHomeDir,
  resolveHostHomeDirFromProfileDir,
  resolveCodexSqliteHome
};
