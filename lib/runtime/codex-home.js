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

function resolveCodexSqliteHome(options = {}) {
  const pathImpl = options.path || path;
  const explicit = readNonEmpty(options.hostHomeDir);
  const hostHomeDir = explicit
    || resolveHostHomeDirFromAiHomeDir(options.aiHomeDir, pathImpl);
  return hostHomeDir ? pathImpl.join(hostHomeDir, '.codex') : '';
}

module.exports = {
  resolveHostHomeDirFromAiHomeDir,
  resolveCodexSqliteHome
};
