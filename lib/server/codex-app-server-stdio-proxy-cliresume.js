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


module.exports = { parseProxyArgs, waitForReadyFile, startRemoteControlProxyProcess, hasArg, runCodexResumeVisibilityRepair, cleanupTemporaryFiles, forwardExitCode, hasExplicitRemoteArg, normalizeRemoteHost, canConnectToTcpEndpoint, resolveCliResumeRemoteConfig, buildCodexCliResumeArgs, buildCodexRemoteResumeLaunch };
