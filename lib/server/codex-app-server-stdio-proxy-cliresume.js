'use strict';

const { resolveManagedCodexUpstream } = require('../runtime/codex-managed-runtime');

const { buildCodexDefaultCliArgs } = require('./codex-cli-startup-policy');
const { readCodexFlag } = require('../runtime/codex-flags');
// CLI resume domain, maintained here after the one-time split.

const { spawn } = require('node:child_process');
const { resolveWindowsUpstreamSpawn } = require('../runtime/pty-launch');
const net = require('node:net');
const path = require('node:path');
const { repairCodexSessionVisibility } = require('../cli/services/ai-cli/codex-session-visibility-repair');
const { startCodexCliResumeCwdProxy } = require('./codex-cli-resume-proxy');
const { resolveCodexSessionListScope, withCodexAllProjectsUrl } = require('./codex-session-list-scope');
const {
  buildCodexDefaultCliEnv,
  forwardChildExitStatus,
  isLocalAppServerEnabled,
  launchUsesProfile
} = require('./codex-default-cli-launcher');
const { readServerConfig } = require('./server-config-store');
const { stripPermissionIntentFlags } = require('../runtime/permission-flag-catalog');
const {
  CODEX_DESKTOP_AUTH_TYPES,
  buildCodexDesktopRuntimeAuth,
  resolveAiHomeDir,
  resolveCodexDesktopAccountIdentity,
  resolveCodexDesktopChatGptAccount,
  resolveCodexDesktopChatGptIdentity
} = require('./codex-desktop-account');
const { readHookState, getDatabaseSyncCtor, readCurrentCodexRuntimeConfig, resolveCodexStateHome } = require('./codex-app-server-stdio-proxy-utils');

function parseProxyArgs(argv) {
  const input = Array.isArray(argv) ? [...argv] : [];
  const result = {
    upstream: '',
    stateFile: '',
    repairResumeVisibility: false,
    runCliResume: false,
    forwardArgs: []
  };
  let passthrough = false;
  for (let index = 0; index < input.length; index += 1) {
    const token = String(input[index] || '');
    if (passthrough) {
      result.forwardArgs.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }
    if (token === '--upstream') {
      result.upstream = String(input[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (token === '--state-file') {
      result.stateFile = String(input[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (token === '--repair-resume-visibility') {
      result.repairResumeVisibility = true;
      continue;
    }
    if (token === '--run-cli-resume') {
      result.runCliResume = true;
      continue;
    }
  }
  return result;
}


const { waitForReadyFile, startRemoteControlProxyProcess } = require('./codex-remote-control-launcher');


function hasArg(args, name) {
  return (Array.isArray(args) ? args : []).some((arg) => String(arg || '').trim() === name);
}


function runCodexResumeVisibilityRepair(argv, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const processObj = deps.processObj || process;
  const parsed = parseProxyArgs(argv);
  const state = readHookState(fs, parsed.stateFile);
  if (!state.enabled) return { ok: true, skipped: true, reason: 'hook_disabled' };
  const args = Array.isArray(parsed.forwardArgs) ? parsed.forwardArgs : [];
  if (String(args[0] || '').trim() !== 'resume') {
    return { ok: true, skipped: true, reason: 'not_resume' };
  }

  const codexHome = resolveCodexStateHome({ ...deps, processObj });
  if (!codexHome) return { ok: true, skipped: true, reason: 'missing_codex_home' };
  const runtimeConfig = readCurrentCodexRuntimeConfig(fs, codexHome, { ...deps, processObj });
  const showAll = hasArg(args, '--all');
  const includeNonInteractive = hasArg(args, '--include-non-interactive');
  return repairCodexSessionVisibility(codexHome, {
    fs,
    path,
    cwd: showAll ? '' : processObj.cwd(),
    includeNonInteractive,
    currentModelProvider: runtimeConfig.modelProvider,
    DatabaseSync: deps.DatabaseSync || getDatabaseSyncCtor()
  });
}


function cleanupTemporaryFiles(fs, filePaths) {
  for (const filePath of Array.isArray(filePaths) ? filePaths : []) {
    const target = String(filePath || '').trim();
    if (!target) continue;
    try {
      if (typeof fs.rmSync === 'function') {
        fs.rmSync(target, { force: true });
      } else if (fs.existsSync(target)) {
        fs.unlinkSync(target);
      }
    } catch (_error) {}
  }
}


function forwardExitCode(child, processObj) {
  child.on('exit', (code, signal) => {
    if (signal) {
      try {
        processObj.kill(processObj.pid, signal);
        return;
      } catch (_error) {}
    }
    const exitCode = Number(code);
    processObj.exit(Number.isFinite(exitCode) ? exitCode : 0);
  });
}


function hasExplicitRemoteArg(args) {
  return (Array.isArray(args) ? args : []).some((arg) => {
    const text = String(arg || '').trim();
    return text === '--remote'
      || text.startsWith('--remote=')
      || text === '--remote-auth-token-env'
      || text.startsWith('--remote-auth-token-env=');
  });
}


function normalizeRemoteHost(host) {
  const value = String(host || '').trim();
  if (!value || value === '0.0.0.0' || value === '::') return '127.0.0.1';
  return value;
}


function canConnectToTcpEndpoint(host, port, timeoutMs = 180) {
  const safePort = Number(port);
  if (!host || !Number.isFinite(safePort) || safePort <= 0) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: safePort });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_error) {}
      resolve(Boolean(ok));
    };
    socket.setTimeout(Math.max(50, Number(timeoutMs) || 180));
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}


function resolveCliResumeRemoteConfig(fs, options = {}) {
  const aiHomeDir = String(options.aiHomeDir || resolveAiHomeDir({
    processObj: options.processObj || process,
    os: options.os
  }) || '').trim();
  if (!aiHomeDir) return null;
  const config = readServerConfig({ fs, aiHomeDir });
  const host = normalizeRemoteHost(config.host);
  const port = Number(config.port);
  if (!host || !Number.isFinite(port) || port <= 0) return null;
  return {
    host,
    port,
    remoteUrl: `ws://${host}:${port}`,
    authToken: String(config.apiKey || '').trim()
  };
}


function buildCodexCliResumeArgs(forwardArgs, remoteConfig) {
  return buildCodexRemoteResumeLaunch(forwardArgs, remoteConfig).args;
}

/**
 * 远程 resume 的启动参数：注入 `--remote` 的同一次里摘掉权限覆盖旗标。
 *
 * 实测 codex-cli 0.163.0：远程 resume 拒绝任何权限覆盖 ——
 *   `Permission overrides are not supported when resuming a remote task.`
 * 因此摘除发生在注入 `--remote` 之前，这个被拒的组合永远不会发到上游；
 * 摘掉了哪些旗标要如实返回，由调用方告诉用户（不静默降级）。
 */
function buildCodexRemoteResumeLaunch(forwardArgs, remoteConfig) {
  const args = Array.isArray(forwardArgs) ? [...forwardArgs] : [];
  const removedPermissionFlags = [];
  if (String(args[0] || '').trim() !== 'resume') return { args, removedPermissionFlags };
  if (!remoteConfig || hasExplicitRemoteArg(args)) return { args, removedPermissionFlags };

  const stripped = stripPermissionIntentFlags('codex', args);
  removedPermissionFlags.push(...stripped.removed);

  const injected = ['resume', '--remote', remoteConfig.remoteUrl];
  if (remoteConfig.authToken) {
    injected.push('--remote-auth-token-env', 'AIH_CODEX_REMOTE_AUTH_TOKEN');
  }
  return {
    args: [...injected, ...stripped.args.slice(1)],
    removedPermissionFlags
  };
}


async function runCodexCliResume(argv, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const spawnImpl = deps.spawn || spawn;
  const processObj = deps.processObj || process;
  const parsed = parseProxyArgs(argv);
  parsed.upstream = resolveManagedCodexUpstream(parsed.upstream, { processObj });
  if (!parsed.upstream) {
    throw new Error('missing_upstream_binary');
  }

  const { env, authMode, aiHomeDir } = buildCodexDefaultCliEnv(fs, {
    ...deps,
    processObj
  });
  let args = parsed.forwardArgs;
  // 交互式 resume 与裸启动一样走本地 app-server：provider / 账号就是调用方自己的，列表限当前项目
  // 且包含所有 provider 的会话。下面的网关远程恢复连的是 /v0/codex/app-server，那里按宿主默认
  // 账号起 app-server，会把恢复的会话跑到默认账号上；仅在本地路径不可用时保留。
  if (isLocalAppServerEnabled(env, processObj) && !hasExplicitRemoteArg(args) && !hasArg(args, '--help')
    && !launchUsesProfile(args)) {
    try {
      return await runCodexCliResumeWithLocalAppServer(parsed.upstream, args, {
        ...deps, fs, spawnImpl, processObj, env, authMode, aiHomeDir
      });
    } catch (error) {
      throw new Error(`codex_local_app_server_unavailable: ${String((error && error.message) || error)}`);
    }
  }
  let scopedResumeProxy = null;
  if (
    !['oauth', 'native-apikey'].includes(authMode)
    && String(readCodexFlag(env, 'disableRemoteResume', '0')) !== '1'
    && !hasExplicitRemoteArg(args)
  ) {
    const remoteConfig = resolveCliResumeRemoteConfig(fs, {
      aiHomeDir: deps.aiHomeDir,
      processObj,
      os: deps.os
    });
    const sessionScope = resolveCodexSessionListScope(args, typeof processObj.cwd === 'function' ? processObj.cwd() : '');
    const wantsAllProjects = !sessionScope.injectCwd;
    const canConnect = deps.canConnectToTcpEndpoint || canConnectToTcpEndpoint;
    const remoteReady = remoteConfig
      ? await canConnect(remoteConfig.host, remoteConfig.port, deps.connectTimeoutMs)
      : false;
    if (remoteReady) {
      let effectiveRemoteConfig = wantsAllProjects
        ? { ...remoteConfig, remoteUrl: withCodexAllProjectsUrl(remoteConfig.remoteUrl) }
        : null;
      if (!wantsAllProjects && typeof processObj.cwd === 'function') {
        const cwd = sessionScope.cwd;
        if (cwd) {
          try {
            scopedResumeProxy = await startCodexCliResumeCwdProxy(remoteConfig, { cwd, env, goServerBinary: deps.goServerBinary });
            effectiveRemoteConfig = { remoteUrl: scopedResumeProxy.remoteUrl, authToken: scopedResumeProxy.authToken };
          } catch (error) {
            // The caller already selected the scoped remote path. Do not
            // silently launch a different native account/history on failure.
            throw new Error(`codex_scoped_resume_unavailable: ${String((error && error.message) || error || 'unknown')}`);
          }
        }
      }
      if (effectiveRemoteConfig) {
        const remoteLaunch = buildCodexRemoteResumeLaunch(args, effectiveRemoteConfig);
        args = remoteLaunch.args;
        if (remoteLaunch.removedPermissionFlags.length > 0) {
          processObj.stderr.write(
            `[aih] 远程恢复会话时不接受权限覆盖，已忽略：${remoteLaunch.removedPermissionFlags.join(' ')}\n`
          );
        }
        if (effectiveRemoteConfig.authToken) {
          env.AIH_CODEX_REMOTE_AUTH_TOKEN = effectiveRemoteConfig.authToken;
        }
      }
    }
  }

  if (['oauth', 'native-apikey'].includes(authMode) && !hasExplicitRemoteArg(args)) {
    args = buildCodexDefaultCliArgs(fs, env, args, authMode, { ...deps, aiHomeDir });
  }

  // Windows 上游可能是 npm .cmd 垫片：直接 spawn 会 EINVAL，先解析为可直连目标。
  const upstreamTarget = resolveWindowsUpstreamSpawn(parsed.upstream, args, {
    platform: processObj && processObj.platform,
    env,
    fsImpl: fs
  });
  const child = spawnImpl(upstreamTarget.command, upstreamTarget.args, {
    stdio: 'inherit',
    env: { ...env, ...upstreamTarget.envPatch },
    windowsVerbatimArguments: upstreamTarget.windowsVerbatimArguments === true
  });
  const closeScopedResumeProxy = () => {
    if (!scopedResumeProxy) return;
    try { scopedResumeProxy.close(); } catch (_error) {}
    scopedResumeProxy = null;
  };
  child.on('error', (error) => {
    closeScopedResumeProxy();
    processObj.stderr.write(`${String((error && error.message) || error || 'codex_resume_failed')}\n`);
    processObj.exit(1);
  });
  child.once('exit', closeScopedResumeProxy);
  forwardExitCode(child, processObj);
  return child;
}


async function runCodexCliResumeWithLocalAppServer(upstream, args, options) {
  const { fs, spawnImpl, processObj, env, authMode, aiHomeDir } = options;
  // 本地 app-server 也是「远程任务」（下面对 TUI 注入 --remote）：远程 resume 拒绝权限
  // 覆盖，因此先把权限旗标摘掉再启动 —— 被拒的组合不会被发出去。
  const stripped = stripPermissionIntentFlags('codex', args);
  if (stripped.removed.length > 0) {
    processObj.stderr.write(
      `[aih] 远程恢复会话时不接受权限覆盖，已忽略：${stripped.removed.join(' ')}\n`
    );
  }
  const cliArgs = ['oauth', 'native-apikey'].includes(authMode)
    ? buildCodexDefaultCliArgs(fs, env, stripped.args, authMode, { ...options, aiHomeDir })
    : stripped.args;
  const startLocal = options.startCodexTuiLocalAppServer
    || require('./codex-tui-local-app-server').startCodexTuiLocalAppServer;
  const local = await startLocal({ upstream, env, args: cliArgs, cwd: processObj.cwd(), platform: processObj.platform });
  const resumeIndex = cliArgs.findIndex((arg) => String(arg || '').trim() === 'resume');
  const remoteArgs = ['--remote', local.remoteUrl, '--remote-auth-token-env', local.tokenEnv];
  const tuiArgs = resumeIndex >= 0
    ? [...cliArgs.slice(0, resumeIndex + 1), ...remoteArgs, ...cliArgs.slice(resumeIndex + 1)]
    : [...remoteArgs, ...cliArgs];
  const target = resolveWindowsUpstreamSpawn(upstream, tuiArgs, { platform: processObj.platform, env, fsImpl: fs });
  const child = spawnImpl(target.command, target.args, {
    stdio: 'inherit',
    env: { ...env, [local.tokenEnv]: local.authToken, ...target.envPatch },
    windowsVerbatimArguments: target.windowsVerbatimArguments === true
  });
  child.on('error', (error) => {
    local.close();
    processObj.stderr.write(`${String((error && error.message) || error || 'codex_resume_failed')}\n`);
    processObj.exit(1);
  });
  // 先停掉 app-server 再退出，凭据刷新等写入在 supervisor 回收凭据前落盘。
  child.on('exit', (code, signal) => {
    local.close().finally(() => forwardChildExitStatus(code, signal, processObj));
  });
  return child;
}


module.exports = { parseProxyArgs, waitForReadyFile, startRemoteControlProxyProcess, hasArg, runCodexResumeVisibilityRepair, cleanupTemporaryFiles, forwardExitCode, hasExplicitRemoteArg, normalizeRemoteHost, canConnectToTcpEndpoint, resolveCliResumeRemoteConfig, buildCodexCliResumeArgs, buildCodexRemoteResumeLaunch, runCodexCliResume };
