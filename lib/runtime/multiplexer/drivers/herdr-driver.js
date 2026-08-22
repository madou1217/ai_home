'use strict';

const path = require('path');
const nodeFs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { BaseMultiplexerDriver } = require('./base-driver');
const { MULTIPLEXER_TYPE } = require('../types');

const DISABLE_ENV = 'AIH_NO_PERSIST';
const RUN_SESSION_NAME = 'run';
const HERDR_WEBSITE = 'https://herdr.dev';
const HERDR_INSTALL_SHELL_URL = 'https://herdr.dev/install.sh';
const HERDR_INSTALL_PS_URL = 'https://herdr.dev/install.ps1';

function resolveHerdrExecution(options = {}) {
  return {
    command: String(options.command || 'herdr').trim() || 'herdr',
    spawnSync: typeof options.spawnSync === 'function' ? options.spawnSync : spawnSync
  };
}

function buildHerdrInstallCommand(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const hasBrew = options.hasBrew ?? (platform === 'darwin');

  if (platform === 'win32') {
    return {
      command: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${HERDR_INSTALL_PS_URL} | iex`],
      display: `powershell -Command "irm ${HERDR_INSTALL_PS_URL} | iex"`,
      type: 'powershell'
    };
  }

  if (platform === 'darwin' && hasBrew) {
    return {
      command: 'brew',
      args: ['install', 'herdr'],
      display: 'brew install herdr',
      type: 'brew'
    };
  }

  return {
    command: 'sh',
    args: ['-c', `curl -fsSL ${HERDR_INSTALL_SHELL_URL} | sh`],
    display: `curl -fsSL ${HERDR_INSTALL_SHELL_URL} | sh`,
    type: 'curl-sh'
  };
}

class HerdrDriver extends BaseMultiplexerDriver {
  constructor() {
    super();
    this._cachedDetect = null;
  }

  get name() {
    return MULTIPLEXER_TYPE.HERDR;
  }

  detect(options = {}) {
    const platform = options.platform || process.platform;
    const env = options.env || process.env;
    const usingInjectedProbes = !!(options.spawnSync || options.resolveCommandPath || options.existsSync);

    if (!usingInjectedProbes && this._cachedDetect) return this._cachedDetect;

    let result;
    if (String(env[DISABLE_ENV] || '') === '1') {
      result = { available: false, reason: 'disabled', command: '', viaShell: false };
    } else {
      result = this._detectHerdr(options);
    }

    if (!usingInjectedProbes) this._cachedDetect = result;
    return result;
  }

  _detectHerdr(options = {}) {
    const platform = options.platform || process.platform;
    const env = options.env || process.env;
    let command = '';
    if (typeof options.resolveCommandPath === 'function') {
      try {
        command = options.resolveCommandPath('herdr', { platform, env }) || '';
      } catch (_error) {
        command = '';
      }
    }
    if (!command && typeof options.spawnSync === 'function') {
      try {
        const probe = options.spawnSync('herdr', ['--version'], { stdio: 'ignore' });
        if (probe && probe.status === 0) command = 'herdr';
      } catch (_error) {
        command = '';
      }
    }
    const installPlan = buildHerdrInstallCommand(options);
    return command
      ? { available: true, reason: 'ok', command, viaShell: false }
      : {
          available: false,
          reason: 'not-found',
          command: '',
          viaShell: false,
          installPlan,
          installHint: `Install herdr: ${installPlan.display} (see ${HERDR_WEBSITE})`
        };
  }

  buildInstallPlan(options = {}) {
    return buildHerdrInstallCommand(options);
  }

  install(options = {}) {
    const spawnImpl = options.spawnSync || spawnSync;
    const installPlan = buildHerdrInstallCommand(options);
    let result;
    try {
      result = spawnImpl(installPlan.command, installPlan.args, {
        stdio: options.stdio || 'inherit',
        env: options.env || process.env
      });
    } catch (error) {
      return { ok: false, reason: 'spawn-failed', status: null, error, installPlan };
    }

    const status = result && Number.isInteger(result.status) ? result.status : null;
    if (result && result.error) {
      return { ok: false, reason: 'spawn-error', status, error: result.error, installPlan };
    }
    if (status !== 0) {
      return { ok: false, reason: 'install-failed', status, error: null, installPlan };
    }

    // Verify detection after installation
    const refreshed = this.detect({ ...options, spawnSync: spawnImpl });
    return {
      ok: refreshed.available,
      reason: refreshed.available ? 'ok' : 'installed-but-not-in-path',
      status: 0,
      command: refreshed.command,
      installPlan
    };
  }

  buildLaunchArgs(options = {}) {
    const command = options.command || 'herdr';
    const inner = options.inner || {};
    const socket = options.socket || 'default';
    const session = options.session || 'default';
    const herdrArgs = [];

    // Session / Workspace namespace mapping for herdr
    if (options.attachExisting) {
      herdrArgs.push('attach', '--session', session);
      return { command, args: herdrArgs, socket, session };
    }

    if (options.detached) {
      herdrArgs.push('spawn', '--detached', '--session', session);
      if (options.cwd) herdrArgs.push('--cwd', String(options.cwd));
      herdrArgs.push('--', String(inner.command));
      for (const arg of (Array.isArray(inner.args) ? inner.args : [])) herdrArgs.push(String(arg));
      return { command, args: herdrArgs, socket, session, detached: true };
    }

    herdrArgs.push('spawn', '--session', session);
    if (options.cwd) herdrArgs.push('--cwd', String(options.cwd));
    herdrArgs.push('--', String(inner.command));
    const innerArgs = Array.isArray(inner.args) ? inner.args : [];
    for (const arg of innerArgs) herdrArgs.push(String(arg));
    return { command, args: herdrArgs, socket, session };
  }

  listSessions(socket, options = {}) {
    const execution = resolveHerdrExecution(options);
    const args = ['list', '--json'];
    return execution.spawnSync(execution.command, args, { encoding: 'utf8' });
  }

  spawnHeadlessRun(options = {}) {
    const execution = resolveHerdrExecution(options);
    const socket = String(options.socket || '').trim();
    const shellCommand = String(options.shellCommand || '').trim();
    if (!socket || !shellCommand) {
      return { ok: false, error: 'herdr_run_invalid_options' };
    }
    const herdrArgv = [
      'spawn', '--detached',
      '--session', `${socket}-${RUN_SESSION_NAME}`,
      ...(options.cwd ? ['--cwd', String(options.cwd)] : []),
      '--', 'sh', '-c', shellCommand
    ];
    const result = execution.spawnSync(execution.command, herdrArgv, {
      env: options.env || process.env,
      stdio: 'ignore'
    });
    if (result.status !== 0) {
      return { ok: false, error: `herdr_spawn_failed_status_${result.status}` };
    }
    return { ok: true, socket, session: RUN_SESSION_NAME, scoped: false };
  }

  hasRun(socket, options = {}) {
    const execution = resolveHerdrExecution(options);
    try {
      const result = execution.spawnSync(execution.command, ['status', '--session', `${socket}-${RUN_SESSION_NAME}`], { stdio: 'ignore' });
      return result && result.status === 0;
    } catch (_error) {
      return false;
    }
  }

  killRun(socket, options = {}) {
    const execution = resolveHerdrExecution(options);
    try {
      execution.spawnSync(execution.command, ['kill', '--session', `${socket}-${RUN_SESSION_NAME}`], { stdio: 'ignore' });
    } catch (_error) { /* ignored */ }
  }

  cleanupRun(socket, options = {}) {
    if (!String(socket || '').trim()) return;
    this.killRun(socket, options);
  }

  sendInput(socket, text, options = {}) {
    const execution = resolveHerdrExecution(options);
    const value = String(text == null ? '' : text);
    try {
      const args = ['send', '--session', `${socket}-${RUN_SESSION_NAME}`, '--', value];
      if (options.appendNewline !== false) {
        args.push('\n');
      }
      const sent = execution.spawnSync(execution.command, args, { stdio: 'ignore' });
      return sent && sent.status === 0;
    } catch (_error) {
      return false;
    }
  }
}

module.exports = {
  HerdrDriver,
  buildHerdrInstallCommand,
  HERDR_WEBSITE,
  HERDR_INSTALL_SHELL_URL,
  HERDR_INSTALL_PS_URL
};
