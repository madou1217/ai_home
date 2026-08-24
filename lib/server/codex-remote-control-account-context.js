'use strict';

const path = require('node:path');

function resolveRemoteControlAiHomeDir(stateFile, pathImpl = path) {
  const filePath = String(stateFile || '').trim();
  if (!filePath || pathImpl.basename(filePath) !== 'desktop-hook-state.json') return '';
  const codexDir = pathImpl.dirname(filePath);
  const runDir = pathImpl.dirname(codexDir);
  if (pathImpl.basename(codexDir) !== 'codex' || pathImpl.basename(runDir) !== 'run') return '';
  return pathImpl.dirname(runDir);
}

function buildRemoteControlProcessObject(processObj, state, stateFile, deps = {}) {
  const childProcessObj = Object.create(processObj || null);
  const env = { ...((processObj && processObj.env) || {}) };
  const accountRef = String(state && state.desktopAccountRef || '').trim();
  const aiHomeDir = resolveRemoteControlAiHomeDir(stateFile, deps.path || path);
  if (accountRef) env.AIH_REMOTE_CONTROL_ACCOUNT_REF = accountRef;
  if (aiHomeDir) env.AIH_REMOTE_CONTROL_AI_HOME = aiHomeDir;
  childProcessObj.env = env;
  return childProcessObj;
}

module.exports = {
  buildRemoteControlProcessObject,
  resolveRemoteControlAiHomeDir
};
