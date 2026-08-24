'use strict';

const OFFICIAL_PACKAGE_MANAGER = 'official';
const LIFECYCLE_ACTIONS = Object.freeze(['install', 'update', 'uninstall']);
const ACTION_LABELS = Object.freeze({
  install: '安装',
  update: '更新',
  uninstall: '卸载'
});

function shellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "'\\''")}'`;
}

function powershellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "''")}'`;
}

function buildShellPlan(action, label, script) {
  return {
    action,
    label: `${ACTION_LABELS[action]} ${label}`,
    packageManager: OFFICIAL_PACKAGE_MANAGER,
    file: '/bin/sh',
    args: ['-c', `set -eu\n${String(script || '').trim()}`]
  };
}

function resolvePowerShell(context = {}) {
  const env = context.env || {};
  const processEnv = context.processObj && context.processObj.env || {};
  const systemRoot = String(env.SystemRoot || env.SYSTEMROOT || processEnv.SystemRoot || processEnv.SYSTEMROOT || '').trim();
  return systemRoot && context.path
    ? context.path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
}

function buildPowerShellPlan(action, label, script, context = {}) {
  return {
    action,
    label: `${ACTION_LABELS[action]} ${label}`,
    packageManager: OFFICIAL_PACKAGE_MANAGER,
    file: resolvePowerShell(context),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        String(script || '').trim()
      ].join('\n')
    ]
  };
}

function buildOfficialShellPlans(label, scripts = {}) {
  return LIFECYCLE_ACTIONS.map((action) => buildShellPlan(action, label, scripts[action]));
}

function buildOfficialPowerShellPlans(label, scripts = {}, context = {}) {
  return LIFECYCLE_ACTIONS.map((action) => buildPowerShellPlan(action, label, scripts[action], context));
}

module.exports = {
  OFFICIAL_PACKAGE_MANAGER,
  buildOfficialPowerShellPlans,
  buildOfficialShellPlans,
  powershellQuote,
  shellQuote
};
