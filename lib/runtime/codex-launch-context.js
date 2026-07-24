'use strict';

const CODEX_MANAGED_LAUNCH_ENV = 'AIH_CODEX_MANAGED_LAUNCH';
const CODEX_MANAGED_LAUNCH_VALUE = '1';

function markCodexManagedLaunch(env = {}) {
  env[CODEX_MANAGED_LAUNCH_ENV] = CODEX_MANAGED_LAUNCH_VALUE;
  return env;
}

function isCodexManagedLaunch(env = {}) {
  return String(env && env[CODEX_MANAGED_LAUNCH_ENV] || '') === CODEX_MANAGED_LAUNCH_VALUE;
}

function consumeCodexManagedLaunch(env = {}) {
  if (!isCodexManagedLaunch(env)) return false;
  delete env[CODEX_MANAGED_LAUNCH_ENV];
  return true;
}

module.exports = {
  CODEX_MANAGED_LAUNCH_ENV,
  CODEX_MANAGED_LAUNCH_VALUE,
  markCodexManagedLaunch,
  isCodexManagedLaunch,
  consumeCodexManagedLaunch
};
