'use strict';

const os = require('node:os');

const { buildCodexProviderArgs, injectCodexProviderArgs } = require('../cli/services/ai-cli/codex-provider-args');
const { buildPtyLaunch, resolveWindowsUpstreamSpawn } = require('../runtime/pty-launch');
const { withHiddenWindowsConsole } = require('../runtime/hidden-child-process-options');
const { windowsSpawnOptions } = require('../runtime/windows-cmd-launch');
const { createCodexAppServerAccountIdentityValidator } = require('./codex-app-server-account-identity');
const { CODEX_APP_SERVER_PASSTHROUGH_ENV } = require('./codex-app-server-hook-wrapper');
const { createCodexAppServerStdioRpcClient } = require('./codex-app-server-stdio-rpc-client');
const { buildProviderEnv } = require('./native-session-chat-env');
const { resolveNativeCliLaunch } = require('./native-session-chat-launch');

function createCodexResetCreditStdioTransport(options = {}) {
  const getProfileDir = options.getProfileDir;
  if (typeof getProfileDir !== 'function') {
    throw codedError('codex_reset_runtime_unavailable', 'Codex 重置需要账号 runtime profile');
  }
  const buildRuntimeEnv = options.buildProviderEnv || buildProviderEnv;
  const resolveLaunch = options.resolveNativeCliLaunch || resolveNativeCliLaunch;
  const wrapLaunch = options.buildPtyLaunch || buildPtyLaunch;
  const createStdioClient = options.createStdioClient || createCodexAppServerStdioRpcClient;
  const identityValidatorFactory = options.accountIdentityValidatorFactory
    || createCodexAppServerAccountIdentityValidator;

  async function request(accountRef, method, params) {
    const runtimeDir = text(getProfileDir('codex', accountRef));
    if (!runtimeDir) {
      throw codedError('codex_reset_runtime_unavailable', 'Codex 重置账号 runtime 不可用');
    }
    const providerEnv = buildRuntimeEnv('codex', runtimeDir, options.env || process.env, {
      accountRef,
      aiHomeDir: options.aiHomeDir,
      gateway: false
    });
    const env = {
      ...providerEnv,
      [CODEX_APP_SERVER_PASSTHROUGH_ENV]: '1'
    };
    const nativeLaunch = resolveLaunch('codex', {
      env,
      cwd: options.cwd,
      hostHomeDir: options.hostHomeDir,
      spawnSyncImpl: options.spawnSyncImpl
    });
    const appServerArgs = injectCodexProviderArgs(
      ['app-server', '--listen', 'stdio://'],
      buildCodexProviderArgs(env)
    );
    const platform = options.platform || process.platform;
    const launchArgs = [...(nativeLaunch.prefixArgs || []), ...appServerArgs];
    const launch = platform === 'win32'
      ? resolveWindowsUpstreamSpawn(nativeLaunch.command, launchArgs, {
        platform,
        env,
        fsImpl: options.fs,
        nodeExecPath: options.nodeExecPath
      })
      : wrapLaunch(nativeLaunch.command, launchArgs, { platform });
    const client = createStdioClient({
      command: launch.command,
      args: launch.args,
      cwd: text(options.cwd) || text(options.hostHomeDir) || os.homedir(),
      env: {
        ...env,
        ...(launch.envPatch || {})
      },
      spawnImpl: options.spawnImpl,
      spawnOptions: withHiddenWindowsConsole(windowsSpawnOptions(launch)),
      requestTimeoutMs: options.requestTimeoutMs,
      onStderr: options.onStderr,
      clientInfo: {
        name: 'aih-reset-credit',
        title: 'AI Home Reset Credit',
        version: '1.0.0'
      },
      capabilities: { experimentalApi: true },
      accountIdentityValidator: identityValidatorFactory({
        fs: options.fs,
        aiHomeDir: options.aiHomeDir,
        accountRef,
        getProfileDir
      })
    });
    try {
      return await client.request(method, params);
    } finally {
      client.close();
    }
  }

  return Object.freeze({
    readRateLimits(accountRef) {
      return request(accountRef, 'account/rateLimits/read', {});
    },
    consumeCredit(accountRef, params) {
      return request(accountRef, 'account/rateLimitResetCredit/consume', params);
    }
  });
}

function codedError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

module.exports = {
  createCodexResetCreditStdioTransport
};
