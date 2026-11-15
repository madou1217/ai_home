'use strict';

// Legacy Node entrypoints retain their synchronous contract but delegate all
// persistent edits to Go. A missing/incompatible binary is a visible failure,
// never permission to re-enable the old truncating writer.
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function mutateProviderHooks(action, provider, options = {}) {
  const binary = options.goBinary || path.resolve(__dirname, '../../bin/native', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'aih-go.exe' : 'aih-go');
  const homeDir = path.resolve(options.homeDir || options.hostHomeDir || os.homedir());
  const env = options.env || process.env;
  const input = { action, provider, homeDir, receiverUrl: options.receiverUrl || options.serverUrl || '', codexVersion: options.codexVersion || '', dryRun: Boolean(options.dryRun),
    events: options.events || [], hookName: options.hookName || '', timeoutSeconds: Number(options.timeoutSeconds) || 0, timeoutMs: Number(options.timeoutMs) || 0, senderExecPath: options.senderExecPath || '',
    env: { HOME: homeDir, AIH_HOST_HOME: homeDir, PATH: env.PATH || process.env.PATH || '', OPENCODE_CONFIG_DIR: env.OPENCODE_CONFIG_DIR || '', XDG_CONFIG_HOME: env.XDG_CONFIG_HOME || '' } };
  const result = (options.spawnSync || spawnSync)(binary, ['__provider-hook-config'], { input: JSON.stringify(input), encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) {
    const notStarted = ['ENOENT', 'EACCES'].includes(result.error?.code) && !result.pid;
    return { ok: false, provider, dryRun: input.dryRun, error: notStarted ? 'hook_core_unavailable' : 'hook_core_outcome_unknown',
      ...(notStarted ? { changed: false } : { outcomeUnknown: true, recoveryRequired: true }) };
  }
  try {
    const value = JSON.parse(result.stdout);
    if (typeof value.ok !== 'boolean' || value.provider !== provider) throw new Error();
    return value;
  } catch (_) { return { ok: false, provider, dryRun: input.dryRun, error: 'hook_core_invalid_response', outcomeUnknown: true, recoveryRequired: true }; }
}
module.exports = { mutateProviderHooks };
