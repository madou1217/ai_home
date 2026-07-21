'use strict';

const childProcess = require('node:child_process');
const fsDefault = require('node:fs');
const pathDefault = require('node:path');
const {
  resolveWindowsClaudeExecutablePath,
  resolveWindowsClaudeInstallPlan
} = require('./native-cli-installer');

const CLAUDE_PROVIDER = 'claude';
const CLAUDE_PACKAGE_NAME = '@anthropic-ai/claude-code';
const CLAUDE_MISSING_NATIVE_RE = /claude native binary not installed/i;

function sanitizeRepairOutput(value, maxLength = 1200) {
  const text = String(value || '').replace(/\r/g, '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function combineSpawnOutput(result) {
  if (!result) return '';
  return [
    result.stdout,
    result.stderr,
    result.error && result.error.message
  ].filter(Boolean).map(String).join('\n');
}

function isClaudeNativeBinaryMissingOutput(output) {
  return CLAUDE_MISSING_NATIVE_RE.test(String(output || ''));
}

function normalizeFilePath(filePath, pathImpl = pathDefault) {
  const normalized = String(filePath || '').trim();
  if (!normalized) return '';
  return pathImpl.normalize(normalized);
}

function expandShellWrapperPath(value, basedir, pathImpl = pathDefault) {
  let expanded = String(value || '').trim();
  if (!expanded) return '';
  expanded = expanded.replace(/^\$basedir(?=\/|\\|$)/, basedir);
  expanded = expanded.replace(/^\$\{basedir\}(?=\/|\\|$)/, basedir);
  if (!pathImpl.isAbsolute(expanded)) {
    expanded = pathImpl.resolve(basedir, expanded);
  }
  return normalizeFilePath(expanded, pathImpl);
}

function collectClaudePackageRootCandidates(text, basedir, pathImpl = pathDefault) {
  const candidates = [];
  const content = String(text || '');
  const packagePattern = /((?:\$basedir|\$\{basedir\}|[A-Za-z]:)?[^'"\n\r]*node_modules[\\/]@anthropic-ai[\\/]claude-code)(?=[\\/]|['"\s]|$)/g;
  let match = packagePattern.exec(content);
  while (match) {
    candidates.push(expandShellWrapperPath(match[1], basedir, pathImpl));
    match = packagePattern.exec(content);
  }
  return candidates;
}

function findPackageRootFromPath(filePath, fsImpl = fsDefault, pathImpl = pathDefault) {
  const normalized = normalizeFilePath(filePath, pathImpl);
  if (!normalized) return '';
  const marker = `${pathImpl.sep}node_modules${pathImpl.sep}@anthropic-ai${pathImpl.sep}claude-code${pathImpl.sep}`;
  const withSep = normalized.endsWith(pathImpl.sep) ? normalized : `${normalized}${pathImpl.sep}`;
  const index = withSep.indexOf(marker);
  if (index < 0) return '';
  const root = withSep.slice(0, index + marker.length - 1);
  try {
    if (fsImpl.existsSync(pathImpl.join(root, 'package.json'))) return root;
  } catch (_error) {}
  return '';
}

function resolveClaudePackageRoot(cliPath, deps = {}) {
  const fsImpl = deps.fs || fsDefault;
  const pathImpl = deps.path || pathDefault;
  const normalizedCliPath = normalizeFilePath(cliPath, pathImpl);
  const pathsToInspect = [];
  if (normalizedCliPath) pathsToInspect.push(normalizedCliPath);
  try {
    const realPath = fsImpl.realpathSync(normalizedCliPath);
    if (realPath && !pathsToInspect.includes(realPath)) pathsToInspect.push(realPath);
  } catch (_error) {}

  for (const candidatePath of pathsToInspect) {
    const directRoot = findPackageRootFromPath(candidatePath, fsImpl, pathImpl);
    if (directRoot) return directRoot;

    let content = '';
    try {
      if (!fsImpl.existsSync(candidatePath)) continue;
      content = String(fsImpl.readFileSync(candidatePath, 'utf8') || '');
    } catch (_error) {
      continue;
    }
    const basedir = pathImpl.dirname(candidatePath);
    for (const candidateRoot of collectClaudePackageRootCandidates(content, basedir, pathImpl)) {
      try {
        if (fsImpl.existsSync(pathImpl.join(candidateRoot, 'package.json'))) return candidateRoot;
      } catch (_error) {}
    }
  }
  return '';
}

function runCommand(spawnSyncImpl, command, args, options = {}) {
  try {
    return spawnSyncImpl(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs || 10000,
      cwd: options.cwd,
      env: options.env,
      windowsVerbatimArguments: options.windowsVerbatimArguments === true,
      windowsHide: options.windowsHide === true
    });
  } catch (error) {
    return { status: 1, error };
  }
}

function notifyRepairStart(deps, context) {
  if (!deps || typeof deps.onRepairStart !== 'function') return;
  try {
    deps.onRepairStart(context);
  } catch (_error) {}
}

function resolveWindowsCommandShell(processObj = process, pathImpl = pathDefault) {
  const env = processObj.env || {};
  const comspec = String(env.ComSpec || env.COMSPEC || '').trim();
  if (comspec) return comspec;
  const systemRoot = String(env.SystemRoot || env.SYSTEMROOT || '').trim();
  return systemRoot ? pathImpl.join(systemRoot, 'System32', 'cmd.exe') : 'cmd.exe';
}

function probeCli(cliPath, deps = {}) {
  const spawnSyncImpl = deps.spawnSync || childProcess.spawnSync;
  const processObj = deps.processObj || process;
  const pathImpl = deps.path || pathDefault;
  const platform = String(processObj.platform || process.platform || '').trim();
  const extension = pathImpl.extname(String(cliPath || '')).toLowerCase();
  const command = platform === 'win32' && (extension === '.cmd' || extension === '.bat')
    ? resolveWindowsCommandShell(processObj, pathImpl)
    : cliPath;
  const args = command === cliPath
    ? ['--version']
    : ['/d', '/s', '/c', `call "${cliPath}" --version`];
  return runCommand(spawnSyncImpl, command, args, {
    env: deps.env,
    windowsVerbatimArguments: command !== cliPath,
    windowsHide: platform === 'win32',
    timeoutMs: deps.timeoutMs || 10000
  });
}

function repairClaudeNativeBinary(cliPath, deps = {}) {
  const fsImpl = deps.fs || fsDefault;
  const pathImpl = deps.path || pathDefault;
  const spawnSyncImpl = deps.spawnSync || childProcess.spawnSync;
  const processObj = deps.processObj || process;
  const nodeExecPath = String(deps.nodeExecPath || processObj.execPath || process.execPath || '').trim();
  const env = deps.env || processObj.env || process.env;
  const normalizedCliPath = normalizeFilePath(cliPath, pathImpl);
  const platform = String(processObj.platform || process.platform || '').trim();

  if (!normalizedCliPath) {
    return { ok: false, repaired: false, needed: true, reason: 'claude_cli_path_missing' };
  }

  const initialProbe = probeCli(normalizedCliPath, {
    spawnSync: spawnSyncImpl,
    env,
    path: pathImpl,
    processObj,
    timeoutMs: deps.probeTimeoutMs
  });
  const initialOutput = combineSpawnOutput(initialProbe);
  if (initialProbe && initialProbe.status === 0) {
    return { ok: true, repaired: false, needed: false, reason: '' };
  }
  if (!isClaudeNativeBinaryMissingOutput(initialOutput)) {
    return {
      ok: true,
      repaired: false,
      needed: false,
      reason: 'probe_failed_unrelated'
    };
  }

  if (platform === 'win32') {
    const hostHomeDir = String(
      deps.hostHomeDir
      || env.USERPROFILE
      || env.HOME
      || ''
    ).trim();
    const installPlan = resolveWindowsClaudeInstallPlan({ path: pathImpl, processObj });
    const installedCliPath = resolveWindowsClaudeExecutablePath({ path: pathImpl, hostHomeDir });
    notifyRepairStart(deps, {
      strategy: installPlan.id,
      installUrl: installPlan.installUrl,
      installedCliPath
    });
    const installResult = runCommand(spawnSyncImpl, installPlan.command, installPlan.args, {
      env,
      windowsHide: true,
      timeoutMs: installPlan.timeoutMs
    });
    if (!installResult || installResult.status !== 0) {
      return {
        ok: false,
        repaired: false,
        needed: true,
        reason: 'claude_windows_native_install_failed',
        detail: sanitizeRepairOutput(combineSpawnOutput(installResult))
      };
    }
    const verifyProbe = probeCli(installedCliPath, {
      spawnSync: spawnSyncImpl,
      env,
      path: pathImpl,
      processObj,
      timeoutMs: deps.probeTimeoutMs
    });
    if (verifyProbe && verifyProbe.status === 0) {
      return {
        ok: true,
        repaired: true,
        needed: true,
        reason: '',
        cliPath: installedCliPath,
        strategy: installPlan.id
      };
    }
    return {
      ok: false,
      repaired: false,
      needed: true,
      reason: 'claude_windows_native_verify_failed',
      cliPath: installedCliPath,
      detail: sanitizeRepairOutput(combineSpawnOutput(verifyProbe))
    };
  }

  const packageRoot = resolveClaudePackageRoot(normalizedCliPath, { fs: fsImpl, path: pathImpl });
  if (!packageRoot) {
    return {
      ok: false,
      repaired: false,
      needed: true,
      reason: 'claude_package_root_not_found'
    };
  }
  const installScriptPath = pathImpl.join(packageRoot, 'install.cjs');
  try {
    if (!fsImpl.existsSync(installScriptPath)) {
      return {
        ok: false,
        repaired: false,
        needed: true,
        reason: 'claude_postinstall_missing',
        packageRoot
      };
    }
  } catch (_error) {
    return {
      ok: false,
      repaired: false,
      needed: true,
      reason: 'claude_postinstall_missing',
      packageRoot
    };
  }

  notifyRepairStart(deps, { packageRoot, installScriptPath });

  const installResult = runCommand(spawnSyncImpl, nodeExecPath, [installScriptPath], {
    cwd: packageRoot,
    env,
    windowsHide: platform === 'win32',
    timeoutMs: deps.installTimeoutMs || 120000
  });
  if (!installResult || installResult.status !== 0) {
    return {
      ok: false,
      repaired: false,
      needed: true,
      reason: 'claude_postinstall_failed',
      packageRoot,
      installScriptPath,
      detail: sanitizeRepairOutput(combineSpawnOutput(installResult))
    };
  }

  const verifyProbe = probeCli(normalizedCliPath, {
    spawnSync: spawnSyncImpl,
    env,
    path: pathImpl,
    processObj,
    timeoutMs: deps.probeTimeoutMs
  });
  if (verifyProbe && verifyProbe.status === 0) {
    return {
      ok: true,
      repaired: true,
      needed: true,
      reason: '',
      packageRoot,
      installScriptPath
    };
  }

  return {
    ok: false,
    repaired: false,
    needed: true,
    reason: 'claude_native_verify_failed',
    packageRoot,
    installScriptPath,
    detail: sanitizeRepairOutput(combineSpawnOutput(verifyProbe))
  };
}

function repairNativeBinaryIfNeeded(provider, cliPath, deps = {}) {
  const normalizedProvider = String(provider || '').trim();
  if (normalizedProvider !== CLAUDE_PROVIDER) {
    return { ok: true, repaired: false, needed: false, reason: 'not_applicable' };
  }
  return repairClaudeNativeBinary(cliPath, deps);
}

module.exports = {
  CLAUDE_PACKAGE_NAME,
  isClaudeNativeBinaryMissingOutput,
  repairNativeBinaryIfNeeded,
  repairClaudeNativeBinary,
  resolveClaudePackageRoot,
  sanitizeRepairOutput
};
