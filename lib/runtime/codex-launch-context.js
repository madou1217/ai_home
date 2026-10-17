'use strict';

const { setCodexFlag, readCodexFlag, clearCodexFlag } = require('./codex-flags');

function markCodexManagedLaunch(env = {}) {
  return setCodexFlag(env, 'managedLaunch', '1');
}

function isCodexManagedLaunch(env = {}) {
  return String(readCodexFlag(env, 'managedLaunch')) === '1';
}

function consumeCodexManagedLaunch(env = {}) {
  if (!isCodexManagedLaunch(env)) return false;
  clearCodexFlag(env, 'managedLaunch');
  return true;
}

module.exports = {
  markCodexManagedLaunch,
  isCodexManagedLaunch,
  consumeCodexManagedLaunch
};
