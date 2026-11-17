'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

function refused(reason) {
  return { ok: false, launched: false, reason };
}

// Go owns target admission, profile binding, environment and process creation.
function launchClaudeDesktopAccount(options = {}) {
  const prepared = options.prepared;
  if (!prepared || prepared.ok !== true || prepared.mode !== 'api'
    || prepared.status !== 'api_configured' || prepared.dryRun
    || prepared.recoveryRequired) {
    return refused('desktop_launch_preparation_required');
  }
  const processObj = options.processObj || process;
  const binary = options.goBinary || path.resolve(__dirname, '../../../../bin/native',
    `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'aih-go.exe' : 'aih-go');
  const record = options.selectedRecord || {};
  const input = {
    intent: 'account-api-launch',
    aiHomeDir: options.aiHomeDir,
    hostHomeDir: options.hostHomeDir,
    accountRef: options.accountRef,
    selectedRecord: {
      executablePath: String(record.executablePath || ''),
      bundlePath: String(record.bundlePath || '')
    },
    prepared: { profileDir: prepared.profileDir, configId: prepared.configId },
    planOnly: Boolean(options.planOnly)
  };
  const result = spawnSync(binary, ['__claude-desktop-launch'], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 20000,
    maxBuffer: 128 * 1024, windowsHide: true, env: processObj.env || process.env
  });
  if (result.error || result.status !== 0) {
    const notStarted = ['ENOENT', 'EACCES'].includes(result.error?.code) && !result.pid;
    return notStarted ? refused('desktop_core_unavailable')
      : { ...refused('desktop_launch_outcome_unknown'), outcomeUnknown: true };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (!parsed || Array.isArray(parsed) || typeof parsed.ok !== 'boolean' || typeof parsed.launched !== 'boolean'
      || parsed.planOnly !== input.planOnly
      || parsed.outcomeUnknown !== undefined && typeof parsed.outcomeUnknown !== 'boolean'
      || parsed.outcomeUnknown && parsed.ok
      || !parsed.ok && parsed.launched
      || parsed.ok && (input.planOnly ? parsed.launched : !parsed.launched)
      || !parsed.ok && typeof parsed.reason !== 'string') throw new Error();
    if (parsed.ok) {
      const executable = input.selectedRecord.executablePath;
      const bundle = input.selectedRecord.bundlePath || executable.split('/Contents/MacOS/')[0];
      const command = process.platform === 'darwin' ? '/usr/bin/open' : executable;
      const args = process.platform === 'darwin'
        ? ['-a', bundle, '--env', `CLAUDE_USER_DATA_DIR=${prepared.profileDir}`] : [];
      if (typeof parsed.targetAvailable !== 'boolean' || !input.planOnly && !parsed.targetAvailable
        || parsed.outcomeUnknown || parsed.reason
        || parsed.profileDir !== prepared.profileDir || parsed.userDataDir !== prepared.profileDir
        || parsed.launchHome !== input.hostHomeDir || parsed.command !== command
        || parsed.cwd !== path.dirname(executable)
        || !Array.isArray(parsed.args) || parsed.args.length !== args.length
        || parsed.args.some((argument, index) => argument !== args[index])) throw new Error();
    }
    return parsed;
  } catch (_) {
    return { ...refused('desktop_launch_outcome_unknown'), outcomeUnknown: true };
  }
}

module.exports = { launchClaudeDesktopAccount };
