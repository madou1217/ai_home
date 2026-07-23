'use strict';

const { resolvePlatformPath } = require('../../../runtime/platform-path');

const ELEVATED_RESTART_ENV = 'AIH_SERVER_ELEVATED_RESTART';

function quotePowerShellLiteral(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function quoteWindowsArgument(value) {
  return `"${String(value || '').replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function createWindowsRestartElevation(deps = {}) {
  const processObj = deps.processObj || process;
  const pathImpl = resolvePlatformPath(processObj.platform, deps.path);
  const spawnSync = deps.spawnSync;
  const entryFilePath = String(deps.entryFilePath || '').trim();
  const aiHomeDir = String(deps.aiHomeDir || '').trim();

  return function elevateServerRestart() {
    if (processObj.platform !== 'win32') {
      return { ok: false, reason: 'unsupported_platform' };
    }
    if (String(processObj.env && processObj.env[ELEVATED_RESTART_ENV] || '') === '1') {
      return { ok: false, reason: 'already_elevated_attempt' };
    }
    if (typeof spawnSync !== 'function' || !entryFilePath) {
      return { ok: false, reason: 'elevation_unavailable' };
    }

    const nodeExecPath = String(processObj.execPath || process.execPath);
    const workingDirectory = pathImpl.dirname(entryFilePath);
    const restartArguments = [entryFilePath, 'server', 'restart']
      .map(quoteWindowsArgument)
      .join(' ');
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      `$env:${ELEVATED_RESTART_ENV} = '1'`,
      ...(aiHomeDir ? [`$env:AIH_HOME = ${quotePowerShellLiteral(aiHomeDir)}`] : []),
      `$restartProcess = Start-Process -FilePath ${quotePowerShellLiteral(nodeExecPath)} -ArgumentList ${quotePowerShellLiteral(restartArguments)} -WorkingDirectory ${quotePowerShellLiteral(workingDirectory)} -Verb RunAs -PassThru`,
      '$restartProcess.WaitForExit()',
      'exit $restartProcess.ExitCode'
    ].join('; ');
    const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedCommand
    ], {
      stdio: 'inherit',
      windowsHide: true,
      env: processObj.env
    });

    if (result && result.error) {
      return { ok: false, reason: 'elevation_failed', error: result.error };
    }
    const status = result && typeof result.status === 'number' ? result.status : null;
    return status === 0
      ? { ok: true, elevated: true }
      : { ok: false, reason: 'elevated_restart_failed', status };
  };
}

module.exports = {
  ELEVATED_RESTART_ENV,
  createWindowsRestartElevation
};
