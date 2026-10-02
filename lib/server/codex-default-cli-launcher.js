'use strict';

const { spawn } = require('node:child_process');
const {
  AIH_SERVER_PROFILE_ID,
  readDefaultAccountRef,
  readDefaultProviderProfile
} = require('../account/default-account-store');
const { readAccountCredentialRecord } = require('./account-credential-store');
const { resolveAiHomeDir } = require('./codex-desktop-account');
const { buildCodexDefaultCliArgs, resolveCodexHome } = require('./codex-cli-startup-policy');
const { healCodexConfigFile } = require('../cli/services/pty/codex-config-heal');
const { getManagedAihProviderBlock } = require('../cli/services/pty/codex-config-sync');
const { hasCodexModelProviderArg } = require('../cli/services/ai-cli/codex-provider-args');
const { consumeCodexManagedLaunch } = require('../runtime/codex-launch-context');
const { resolveWindowsUpstreamSpawn } = require('../runtime/pty-launch');
const { readCodexGatewayConnection } = require('./codex-gateway-connection');
const { repairStaleProjectedRolloutPaths } = require('./codex-app-server-stdio-proxy-rollout');

function buildCodexDefaultCliEnv(fs, options = {}) {
  const processObj = options.processObj || process;
  const env = {
    ...((processObj && processObj.env) || process.env)
  };
  const aiHomeDir = String(options.aiHomeDir || resolveAiHomeDir({
    processObj,
    os: options.os
  }) || '').trim();
  if (consumeCodexManagedLaunch(env)) {
    // 鉴权已由 AIH 启动链路选定；全局 hook 只能透传，不能再次套用 set-default。
    return {
      env,
      aiHomeDir,
      accountRef: '',
      authMode: String(env.OPENAI_API_KEY || '').trim() ? 'apikey' : 'oauth'
    };
  }
  if (!aiHomeDir) {
    return { env, aiHomeDir: '', accountRef: '', authMode: 'passthrough' };
  }

  if (readDefaultProviderProfile(fs, aiHomeDir, 'codex') === AIH_SERVER_PROFILE_ID) {
    Object.assign(env, readCodexGatewayConnection(fs, aiHomeDir, '').env);
    return { env, aiHomeDir, accountRef: '', authMode: 'apikey', providerProfile: AIH_SERVER_PROFILE_ID };
  }

  const accountRef = readDefaultAccountRef(fs, aiHomeDir, 'codex');
  if (!accountRef) {
    return { env, aiHomeDir, accountRef: '', authMode: 'passthrough' };
  }

  const record = readAccountCredentialRecord(fs, aiHomeDir, accountRef);
  const apiKey = record && record.provider === 'codex'
    ? String(record.env && record.env.OPENAI_API_KEY || '').trim()
    : '';
  if (apiKey) {
    env.OPENAI_API_KEY = apiKey;
    env.OPENAI_BASE_URL = String(record.env.OPENAI_BASE_URL || '').trim() || 'https://api.openai.com/v1';
    delete env.AIH_CODEX_GATEWAY_ACCOUNT_REF;
    delete env.AIH_CODEX_REMOTE_AUTH_TOKEN;
    return { env, aiHomeDir, accountRef, authMode: 'native-apikey' };
  }

  // OAuth uses the host auth.json projected by `aih codex set-default`.
  // Never let an unrelated shell-level API key override that durable choice.
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  delete env.AIH_CODEX_GATEWAY_ACCOUNT_REF;
  return {
    env,
    aiHomeDir,
    accountRef,
    authMode: record && record.provider === 'codex' ? 'oauth' : 'unavailable'
  };
}

function forwardChildExit(child, processObj) {
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

function runCodexDefaultCli(upstream, args, options = {}) {
  const upstreamBinary = String(upstream || '').trim();
  if (!upstreamBinary) throw new Error('missing_upstream_binary');

  const fs = options.fs || require('node:fs');
  const processObj = options.processObj || process;
  const spawnImpl = options.spawn || spawn;
  const forwardArgs = Array.isArray(args) ? args : [];
  const runtime = buildCodexDefaultCliEnv(fs, { ...options, processObj });
  const codexHome = resolveCodexHome(runtime.env, options);
  if (codexHome) {
    // 全局 hook 必须在原生 Codex 读配置前自愈；name 保留在文件中，避免 Windows argv 引号问题。
    const restoreGatewayProvider = runtime.authMode === 'apikey'
      && runtime.env.AIH_CODEX_GATEWAY_ACCOUNT_REF && !hasCodexModelProviderArg(forwardArgs);
    healCodexConfigFile((options.path || require('node:path')).join(codexHome, 'config.toml'), {
      fs, platform: processObj.platform,
      missingProviderBlock: restoreGatewayProvider ? getManagedAihProviderBlock({
        openaiApiKey: runtime.env.OPENAI_API_KEY, openaiBaseUrl: runtime.env.OPENAI_BASE_URL
      }) : '',
      log: (message) => processObj.stderr.write(`${message}\n`)
    });
  }
  // 旧会话的 rollout_path 可能还指向已删除的临时投影目录，resume 会报 "no rollout found"；
  // 启动前改指向共享会话存储里的同一文件（尽力而为，失败不影响启动）。
  try {
    repairStaleProjectedRolloutPaths({ fs, processObj: { ...processObj, env: runtime.env } });
  } catch (_error) {}
  const cliArgs = buildCodexDefaultCliArgs(
    fs,
    runtime.env,
    forwardArgs,
    runtime.authMode,
    { ...options, aiHomeDir: runtime.aiHomeDir }
  );
  const spawnCli = (launchArgs, extraEnv = {}) => {
    // Windows 上游可能是 npm .cmd 垫片：直接 spawn 会 EINVAL，先解析为可直连的
    // node + 脚本（或带 verbatim 的 cmd 包装）。
    const spawnTarget = resolveWindowsUpstreamSpawn(upstreamBinary, launchArgs, {
      platform: processObj && processObj.platform,
      env: runtime.env,
      fsImpl: fs
    });
    const child = spawnImpl(spawnTarget.command, spawnTarget.args, {
      stdio: 'inherit',
      env: { ...runtime.env, ...extraEnv, ...spawnTarget.envPatch },
      windowsVerbatimArguments: spawnTarget.windowsVerbatimArguments === true
    });
    child.on('error', (error) => {
      processObj.stderr.write(`${String((error && error.message) || error || 'codex_launch_failed')}\n`);
      processObj.exit(1);
    });
    return child;
  };

  // 交互式 TUI 走本地 app-server 代理，终端 /resume 才能列出当前项目所有 provider 的会话
  // （见 codex-tui-local-app-server.js）。失败时退回原生进程内 TUI。
  if (shouldUseLocalAppServer(cliArgs, runtime.env, processObj)) {
    // 延迟加载：codex-tui-local-app-server → codex-app-server-proxy → 本模块，顶层引用会成环。
    const startLocal = options.startCodexTuiLocalAppServer
      || require('./codex-tui-local-app-server').startCodexTuiLocalAppServer;
    return startLocal({
      upstream: upstreamBinary,
      env: runtime.env,
      args: cliArgs,
      cwd: processObj.cwd(),
      platform: processObj.platform
    })
      .then((local) => {
        const child = spawnCli(
          ['--remote', local.remoteUrl, '--remote-auth-token-env', local.tokenEnv, ...cliArgs],
          { [local.tokenEnv]: local.authToken }
        );
        // 先停掉 app-server 再退出，凭据刷新等写入在 supervisor 回收凭据前落盘。
        child.on('exit', (code, signal) => {
          local.close().finally(() => forwardChildExitStatus(code, signal, processObj));
        });
        return child;
      })
      .catch((error) => {
        processObj.stderr.write(`[aih] Codex local app-server unavailable, using the built-in one: ${String((error && error.message) || error)}\n`);
        const child = spawnCli(cliArgs);
        forwardChildExit(child, processObj);
        return child;
      });
  }

  const child = spawnCli(cliArgs);
  forwardChildExit(child, processObj);
  return child;
}

// 只接管交互式 TUI（裸启动或带初始 prompt）；子命令、显式 --remote、非 TTY 一律原生。
const CODEX_SUBCOMMANDS = new Set([
  'agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'mcp-server', 'plugin', 'app-server',
  'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'resume',
  'queue', 'archive', 'delete', 'migrate-rollouts', 'unarchive', 'fork', 'cloud', 'exec-server',
  'features', 'help'
]);
const CODEX_FLAGS_WITH_VALUE = new Set([
  '-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-i', '--image',
  '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir',
  '-a', '--ask-for-approval'
]);

function isInteractiveTuiLaunch(args) {
  const list = Array.isArray(args) ? args : [];
  for (let index = 0; index < list.length; index += 1) {
    const token = String(list[index] || '');
    if (token === '--remote' || token.startsWith('--remote=')) return false;
    if (token === '--version' || token === '-V' || token === '--help' || token === '-h') return false;
    if (token === '--') return true;
    if (CODEX_FLAGS_WITH_VALUE.has(token)) { index += 1; continue; }
    if (token.startsWith('-')) continue;
    return !CODEX_SUBCOMMANDS.has(token);
  }
  return true;
}

// 本地 app-server 的公共前提：未关闭（紧急开关 AIH_CODEX_TUI_LOCAL_REMOTE=0 退回原生进程内 TUI）、
// 交互终端。Windows（psmux）在真机验证前需显式 AIH_CODEX_TUI_LOCAL_REMOTE=1 才启用。
function isLocalAppServerEnabled(env, processObj) {
  const flag = String(env && env.AIH_CODEX_TUI_LOCAL_REMOTE || '').trim();
  if (flag === '0' || !processObj) return false;
  if (processObj.platform === 'win32' && flag !== '1') return false;
  if (!processObj.stdin || !processObj.stdin.isTTY) return false;
  return typeof processObj.cwd === 'function';
}

function shouldUseLocalAppServer(args, env, processObj) {
  return isLocalAppServerEnabled(env, processObj) && isInteractiveTuiLaunch(args) && !launchUsesProfile(args);
}

// 带 -p/--profile 时本地 app-server 无法还原 profile（见 codex-tui-local-app-server.js），走原生。
function launchUsesProfile(args) {
  return require('./codex-tui-local-app-server').usesProfile(args);
}

function forwardChildExitStatus(code, signal, processObj) {
  if (signal) {
    try {
      processObj.kill(processObj.pid, signal);
      return;
    } catch (_error) {}
  }
  const exitCode = Number(code);
  processObj.exit(Number.isFinite(exitCode) ? exitCode : 0);
}

module.exports = {
  buildCodexDefaultCliEnv,
  forwardChildExitStatus,
  isInteractiveTuiLaunch,
  isLocalAppServerEnabled,
  launchUsesProfile,
  runCodexDefaultCli
};
