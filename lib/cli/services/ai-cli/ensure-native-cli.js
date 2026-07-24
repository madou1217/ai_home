'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const os = require('node:os');

const {
  getAiCliBinaryName,
  getAiCliConfig
} = require('./provider-registry');
const {
  collectNativeCliPathEntries,
  resolveNativeCliInstallPlans,
  listProviderBinaryNames
} = require('./native-cli-installer');
const { resolveNativeCliPath } = require('../../../runtime/native-cli-resolver');
const { resolveHostHomeDir } = require('../../../runtime/host-home');
const { resolvePlatformPath } = require('../../../runtime/platform-path');

/**
 * Facade: resolve provider CLI (Strategy-backed binary names + search roots),
 * then Template Method auto-install loop for non-interactive environments
 * (WebUI / server). Interactive TTY install remains in pty/runtime.
 */

function resolveHostHome(options = {}) {
  if (String(options.hostHomeDir || '').trim()) return String(options.hostHomeDir).trim();
  const processObj = options.processObj || process;
  try {
    return resolveHostHomeDir({
      env: processObj.env || process.env || {},
      platform: processObj.platform || process.platform,
      os: options.os || os
    });
  } catch (_error) {
    return String(processObj.env && (processObj.env.USERPROFILE || processObj.env.HOME) || '').trim();
  }
}

function augmentPathEnv(baseEnv, pathEntries, pathImpl = nodePath) {
  const env = { ...(baseEnv || {}) };
  const delimiter = pathImpl.delimiter || (process.platform === 'win32' ? ';' : ':');
  const current = String(env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  const next = [];
  const seen = new Set();
  [...pathEntries, ...current].forEach((entry) => {
    const value = String(entry || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    next.push(value);
  });
  if (next.length) {
    env.PATH = next.join(delimiter);
    if (Object.prototype.hasOwnProperty.call(env, 'Path')) env.Path = env.PATH;
  }
  return env;
}

function uniqueNames(...groups) {
  const seen = new Set();
  const out = [];
  groups.flat().forEach((name) => {
    const value = String(name || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  });
  return out;
}

function resolveProviderCliPath(provider, options = {}) {
  const normalizedProvider = String(provider || '').trim();
  if (!normalizedProvider) return '';
  const processObj = options.processObj || process;
  const platform = processObj.platform || process.platform;
  const pathImpl = resolvePlatformPath(platform, options.path || nodePath);
  const fsImpl = options.fs || nodeFs;
  const primary = getAiCliBinaryName(normalizedProvider) || normalizedProvider;
  const names = uniqueNames(
    primary,
    listProviderBinaryNames(normalizedProvider, options),
    primary === normalizedProvider ? normalizedProvider : ''
  );
  const hostHomeDir = resolveHostHome(options);
  const pathEntries = collectNativeCliPathEntries(normalizedProvider, {
    path: pathImpl,
    hostHomeDir,
    processObj
  });
  const baseEnv = processObj.env || process.env || {};
  const env = augmentPathEnv(baseEnv, pathEntries, pathImpl);
  const resolve = options.resolveNativeCliPath || resolveNativeCliPath;
  const resolveOpts = {
    fs: fsImpl,
    env,
    platform,
    cwd: typeof processObj.cwd === 'function' ? processObj.cwd() : process.cwd(),
    appRoot: options.appRoot,
    runtimeToolsDir: options.runtimeToolsDir,
    projectFallback: options.projectFallback
  };

  for (const name of names) {
    const found = resolve(name, resolveOpts);
    if (found) return found;
  }
  return '';
}

function runInstallPlan(plan, options = {}) {
  const processObj = options.processObj || process;
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const platform = String(processObj.platform || process.platform || '').trim();
  const result = spawnSyncImpl(plan.command, plan.args, {
    stdio: options.stdio || 'pipe',
    encoding: 'utf8',
    timeout: plan.timeoutMs || 300000,
    windowsHide: platform === 'win32',
    env: {
      ...(processObj.env || process.env || {}),
      // Hint installers to skip interactive prompts when supported.
      CI: '1',
      NONINTERACTIVE: '1'
    }
  });
  return {
    ok: Boolean(result && result.status === 0),
    status: result ? result.status : null,
    error: result && result.error ? String(result.error.message || result.error) : '',
    stdout: result ? String(result.stdout || '') : '',
    stderr: result ? String(result.stderr || '') : ''
  };
}

function resolveDefaultNpmInstall(pkg, platform) {
  const normalizedPackage = String(pkg || '').trim();
  if (!normalizedPackage) return null;
  return {
    command: String(platform || '').toLowerCase() === 'win32' ? 'npm.cmd' : 'npm',
    args: ['install', '--global', normalizedPackage]
  };
}

function runInstallPlanAsync(plan, options = {}) {
  const processObj = options.processObj || process;
  const spawnImpl = options.spawn || spawn;
  const platform = String(processObj.platform || process.platform || '').trim();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(plan.command, plan.args, {
        windowsHide: platform === 'win32',
        shell: platform === 'win32' && /\.(?:cmd|bat)$/i.test(String(plan.command || '')),
        env: {
          ...(processObj.env || process.env || {}),
          CI: '1',
          NONINTERACTIVE: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({ ok: false, status: null, error: String(error && error.message || error), stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    const append = (kind, chunk) => {
      const text = String(chunk || '');
      if (kind === 'stdout') stdout += text;
      else stderr += text;
      if (typeof options.onOutput === 'function') options.onOutput(text, kind, plan);
    };
    child.stdout?.on('data', (chunk) => append('stdout', chunk));
    child.stderr?.on('data', (chunk) => append('stderr', chunk));
    child.once('error', (error) => resolve({
      ok: false,
      status: null,
      error: String(error && error.message || error),
      stdout,
      stderr
    }));
    child.once('close', (status) => resolve({
      ok: status === 0,
      status: Number.isInteger(status) ? status : null,
      error: status === 0 ? '' : (stderr || `exit_${status}`),
      stdout,
      stderr
    }));
  });
}

async function installNativeCliWithProgress(provider, options = {}) {
  const normalizedProvider = String(provider || '').trim();
  const processObj = options.processObj || process;
  const platform = String(processObj.platform || process.platform || '').trim();
  const config = getAiCliConfig(normalizedProvider) || {};
  const pkg = String(config.pkg || '').trim();
  const resolveNpmInstall = typeof options.resolveNpmInstall === 'function'
    ? options.resolveNpmInstall
    : (packageName) => resolveDefaultNpmInstall(packageName, platform);
  const plans = resolveNativeCliInstallPlans(normalizedProvider, pkg, {
    path: options.path || nodePath,
    processObj,
    hostHomeDir: resolveHostHome(options),
    resolveNpmInstall
  });
  const installAttempts = [];
  for (const plan of plans) {
    options.onPlanStart?.(plan);
    const outcome = await runInstallPlanAsync(plan, options);
    const attempt = {
      id: plan.id,
      label: plan.label,
      ok: outcome.ok,
      error: outcome.ok ? '' : (outcome.error || outcome.stderr || `exit_${outcome.status}`),
      stdout: outcome.stdout,
      stderr: outcome.stderr
    };
    installAttempts.push(attempt);
    options.onPlanFinish?.(attempt, plan);
    if (!outcome.ok) continue;
    const cliPath = resolveProviderCliPath(normalizedProvider, options);
    if (cliPath) return { cliPath, binaryName: getAiCliBinaryName(normalizedProvider), installed: true, installAttempts };
  }
  return { cliPath: '', binaryName: getAiCliBinaryName(normalizedProvider), installed: false, installAttempts };
}

/**
 * Template method:
 *   resolve → (optional) install plans → re-resolve → result
 *
 * @returns {{
 *   cliPath: string,
 *   binaryName: string,
 *   installed: boolean,
 *   installAttempts: Array<{id:string,label:string,ok:boolean,error?:string,stdout?:string,stderr?:string}>
 * }}
 */
function ensureNativeCliAvailable(provider, options = {}) {
  const normalizedProvider = String(provider || '').trim();
  const binaryName = getAiCliBinaryName(normalizedProvider) || normalizedProvider;
  const installAttempts = [];
  let cliPath = resolveProviderCliPath(normalizedProvider, options);
  if (cliPath) {
    return { cliPath, binaryName, installed: false, installAttempts };
  }

  if (options.autoInstall === false) {
    return { cliPath: '', binaryName, installed: false, installAttempts };
  }

  const processObj = options.processObj || process;
  const pathImpl = options.path || nodePath;
  const hostHomeDir = resolveHostHome(options);
  const config = getAiCliConfig(normalizedProvider) || {};
  const pkg = String(config.pkg || '').trim();
  const resolveNpmInstall = typeof options.resolveNpmInstall === 'function'
    ? options.resolveNpmInstall
    : (packageName) => resolveDefaultNpmInstall(packageName, processObj.platform);
  const plans = resolveNativeCliInstallPlans(normalizedProvider, pkg, {
    path: pathImpl,
    processObj,
    hostHomeDir,
    resolveNpmInstall
  });

  for (const plan of plans) {
    const outcome = runInstallPlan(plan, options);
    installAttempts.push({
      id: plan.id,
      label: plan.label,
      ok: outcome.ok,
      error: outcome.ok ? '' : (outcome.error || outcome.stderr || `exit_${outcome.status}`),
      stdout: outcome.stdout,
      stderr: outcome.stderr
    });
    if (!outcome.ok) continue;
    cliPath = resolveProviderCliPath(normalizedProvider, options);
    if (cliPath) {
      return { cliPath, binaryName, installed: true, installAttempts };
    }
  }

  return {
    cliPath: '',
    binaryName,
    installed: installAttempts.some((item) => item.ok),
    installAttempts
  };
}

function buildCliNotFoundMessage(provider, ensureResult = {}) {
  const binaryName = ensureResult.binaryName || getAiCliBinaryName(provider) || provider;
  const config = getAiCliConfig(provider) || {};
  const attempts = Array.isArray(ensureResult.installAttempts) ? ensureResult.installAttempts : [];
  if (attempts.length === 0) {
    const pkg = String(config.pkg || '').trim();
    return pkg
      ? `未找到 ${binaryName} CLI，请先安装 ${pkg}`
      : `未找到 ${binaryName} CLI，请先安装原生 CLI`;
  }
  const failedLabels = attempts.map((item) => item.label).join('; ');
  const detail = attempts
    .map((item) => String(item.error || '').trim())
    .filter(Boolean)
    .slice(0, 1)
    .join('');
  const suffix = detail ? `：${detail.slice(0, 240)}` : '';
  return `未找到 ${binaryName} CLI，自动安装失败（${failedLabels}）${suffix}。请手动安装后重试。`;
}

module.exports = {
  resolveProviderCliPath,
  ensureNativeCliAvailable,
  installNativeCliWithProgress,
  runInstallPlanAsync,
  buildCliNotFoundMessage,
  resolveHostHome
};
