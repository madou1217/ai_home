'use strict';

const path = require('node:path');
const {
  CODEX_APP_SERVER_PASSTHROUGH_ENV,
  CODEX_GLOBAL_VALUE_OPTIONS,
  buildCodexAppServerWrapperScript
} = require('./codex-app-server-hook-wrapper');

const WRAPPER_MARKER = 'aih-codex-cli-hook';
// The marker only counts when it is its own comment line (`# marker` /
// `REM marker`, CRLF tolerated). A bare includes() misfires when the marker
// string happens to appear inside a path embedded in the file — e.g. a pnpm
// shim's `cmd-shim-target=` comment under a directory whose name contains
// "aih-codex-cli-hook" — which made trusted upstream backups look like
// wrappers and blocked recovery.
const WRAPPER_MARKER_LINE_PATTERN = new RegExp(`^(?:#|REM) ${WRAPPER_MARKER}\\r?$`, 'm');
const NODE_ENTRY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const WINDOWS_POWERSHELL_SHIM_EXTENSIONS = new Set(['.ps1']);
const WINDOWS_CMD_SHIM_EXTENSIONS = new Set(['.cmd', '.bat']);
const PRESERVE_BACKUP_EXTENSIONS = new Set([
  ...NODE_ENTRY_EXTENSIONS,
  ...WINDOWS_POWERSHELL_SHIM_EXTENSIONS,
  ...WINDOWS_CMD_SHIM_EXTENSIONS
]);

function buildWrapperScript(options = {}) {
  return buildCodexAppServerWrapperScript(WRAPPER_MARKER, {
    ...options,
    routeDefaultCliThroughHelper: true
  });
}

function powershellQuote(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function cmdSetValue(value) {
  return String(value || '').replace(/"/g, '""');
}

function buildWindowsPowerShellWrapperScript(options = {}) {
  const {
    nodeExecPath,
    helperScriptPath,
    upstreamBinaryPath,
    stateFilePath
  } = options;
  return [
    '#!/usr/bin/env pwsh',
    `# ${WRAPPER_MARKER}`,
    `$upstream = ${powershellQuote(upstreamBinaryPath)}`,
    `$nodeBin = ${powershellQuote(nodeExecPath)}`,
    `$helper = ${powershellQuote(helperScriptPath)}`,
    `$stateFile = ${powershellQuote(stateFilePath)}`,
    '$forwardArgs = @($args)',
    `$valueOptions = @(${CODEX_GLOBAL_VALUE_OPTIONS.map(powershellQuote).join(', ')})`,
    '$subcommand = $null',
    '$expectOptionValue = $false',
    'foreach ($arg in $forwardArgs) {',
    '  if ($expectOptionValue) { $expectOptionValue = $false; continue }',
    '  if ($arg -eq "--") { break }',
    '  if ($valueOptions -contains $arg) { $expectOptionValue = $true; continue }',
    '  if ($arg.StartsWith("-")) { continue }',
    '  $subcommand = $arg',
    '  break',
    '}',
    'if ($subcommand -eq "resume") {',
    '  $proxyArgs = @($helper, "--run-cli-resume", "--upstream", $upstream, "--state-file", $stateFile, "--") + $forwardArgs',
    '  if ($MyInvocation.ExpectingInput) {',
    '    $input | & $nodeBin @proxyArgs',
    '  } else {',
    '    & $nodeBin @proxyArgs',
    '  }',
    '  exit $LASTEXITCODE',
    '}',
    'if ($subcommand -eq "app-server") {',
    `  if ($env:${CODEX_APP_SERVER_PASSTHROUGH_ENV} -eq "1") {`,
    `    Remove-Item Env:${CODEX_APP_SERVER_PASSTHROUGH_ENV} -ErrorAction SilentlyContinue`,
    '    & $upstream @forwardArgs',
    '    exit $LASTEXITCODE',
    '  }',
    '  $proxyArgs = @($helper, "--upstream", $upstream, "--state-file", $stateFile, "--") + $forwardArgs',
    '  if ($MyInvocation.ExpectingInput) {',
    '    $input | & $nodeBin @proxyArgs',
    '  } else {',
    '    & $nodeBin @proxyArgs',
    '  }',
    '  exit $LASTEXITCODE',
    '}',
    '  $proxyArgs = @($helper, "--run-cli-default", "--upstream", $upstream, "--state-file", $stateFile, "--") + $forwardArgs',
    'if ($MyInvocation.ExpectingInput) {',
    '  $input | & $nodeBin @proxyArgs',
    '} else {',
    '  & $nodeBin @proxyArgs',
    '}',
    'exit $LASTEXITCODE',
    ''
  ].join('\n');
}

function buildWindowsCmdWrapperScript(options = {}) {
  const {
    nodeExecPath,
    helperScriptPath,
    upstreamBinaryPath,
    stateFilePath
  } = options;
  return [
    '@echo off',
    `REM ${WRAPPER_MARKER}`,
    'setlocal',
    `set "UPSTREAM=${cmdSetValue(upstreamBinaryPath)}"`,
    `set "NODE_BIN=${cmdSetValue(nodeExecPath)}"`,
    `set "HELPER=${cmdSetValue(helperScriptPath)}"`,
    `set "STATE_FILE=${cmdSetValue(stateFilePath)}"`,
    'call :AIH_FIND_SUBCOMMAND %*',
    'goto :AIH_DISPATCH',
    ':AIH_FIND_SUBCOMMAND',
    'set "AIH_SUBCOMMAND="',
    ':AIH_SCAN_NEXT',
    'if "%~1"=="" exit /b 0',
    'if "%~1"=="--" exit /b 0',
    ...CODEX_GLOBAL_VALUE_OPTIONS.map((option) => (
      `if /I "%~1"=="${option}" goto :AIH_SKIP_OPTION_VALUE`
    )),
    'set "AIH_SCAN_ARG=%~1"',
    'if "%AIH_SCAN_ARG:~0,1%"=="-" (',
    '  shift',
    '  goto :AIH_SCAN_NEXT',
    ')',
    'set "AIH_SUBCOMMAND=%~1"',
    'exit /b 0',
    ':AIH_SKIP_OPTION_VALUE',
    'shift',
    'if not "%~1"=="" shift',
    'goto :AIH_SCAN_NEXT',
    ':AIH_DISPATCH',
    'if /I "%AIH_SUBCOMMAND%"=="resume" (',
    '  "%NODE_BIN%" "%HELPER%" --run-cli-resume --upstream "%UPSTREAM%" --state-file "%STATE_FILE%" -- %*',
    '  exit /b %ERRORLEVEL%',
    ')',
    'if /I "%AIH_SUBCOMMAND%"=="app-server" (',
    `  if "%${CODEX_APP_SERVER_PASSTHROUGH_ENV}%"=="1" (`,
    `    set "${CODEX_APP_SERVER_PASSTHROUGH_ENV}="`,
    '    call "%UPSTREAM%" %*',
    '    exit /b %ERRORLEVEL%',
    '  )',
    '  "%NODE_BIN%" "%HELPER%" --upstream "%UPSTREAM%" --state-file "%STATE_FILE%" -- %*',
    '  exit /b %ERRORLEVEL%',
    ')',
    '"%NODE_BIN%" "%HELPER%" --run-cli-default --upstream "%UPSTREAM%" --state-file "%STATE_FILE%" -- %*',
    'exit /b %ERRORLEVEL%',
    ''
  ].join('\r\n');
}

function buildWrapperScriptForTarget(targetBinaryPath, options = {}) {
  const ext = path.extname(String(targetBinaryPath || '')).trim().toLowerCase();
  if (WINDOWS_POWERSHELL_SHIM_EXTENSIONS.has(ext)) {
    return buildWindowsPowerShellWrapperScript(options);
  }
  if (WINDOWS_CMD_SHIM_EXTENSIONS.has(ext)) {
    return buildWindowsCmdWrapperScript(options);
  }
  return buildWrapperScript(options);
}

function createCodexCliHookService(deps = {}) {
  const fs = deps.fs;
  const pathImpl = deps.path || path;
  const processObj = deps.processObj || process;
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const nodeExecPath = String(deps.nodeExecPath || process.execPath).trim();
  const helperScriptPath = String(
    deps.helperScriptPath || require.resolve('./codex-app-server-stdio-proxy')
  ).trim();
  const resolveCliPath = deps.resolveCliPath;

  const stateFilePath = aiHomeDir
    ? pathImpl.join(aiHomeDir, 'run', 'codex', 'cli-hook-state.json')
    : '';

  function readTextFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return '';
    try {
      return String(fs.readFileSync(filePath, 'utf8'));
    } catch (_error) {
      return '';
    }
  }

  function isNodeEntryContent(filePath) {
    const content = readTextFile(filePath);
    if (!content) return false;
    const firstLine = String(content.split('\n')[0] || '').trim();
    return /node(?:\s|$)/i.test(firstLine);
  }

  function buildBackupPath(binaryPath) {
    const normalized = String(binaryPath || '').trim();
    if (!normalized) return '';
    const originalExt = pathImpl.extname(normalized).trim();
    const resolvedExt = originalExt.toLowerCase();
    if (!PRESERVE_BACKUP_EXTENSIONS.has(resolvedExt)) {
      return `${normalized}.aih-original`;
    }
    const parsed = pathImpl.parse(normalized);
    return pathImpl.join(parsed.dir, `${parsed.name}.aih-original${originalExt}`);
  }

  function resolveUpstreamBinaryPath(targetBinaryPath) {
    const normalizedTarget = String(targetBinaryPath || '').trim();
    if (!normalizedTarget) {
      return {
        resolvedTargetBinaryPath: '',
        upstreamBinaryPath: '',
        legacyUpstreamBinaryPaths: []
      };
    }

    let resolvedTargetBinaryPath = normalizedTarget;
    try {
      if (fs.existsSync(normalizedTarget) && typeof fs.realpathSync === 'function') {
        resolvedTargetBinaryPath = String(fs.realpathSync(normalizedTarget) || '').trim() || normalizedTarget;
      }
    } catch (_error) {}

    const upstreamBinaryPath = buildBackupPath(resolvedTargetBinaryPath);
    const legacyUpstreamBinaryPaths = collectLegacyBackupPaths({
      normalizedTarget,
      resolvedTargetBinaryPath,
      upstreamBinaryPath
    });
    return {
      resolvedTargetBinaryPath,
      upstreamBinaryPath,
      legacyUpstreamBinaryPaths
    };
  }

  function collectLegacyBackupPaths(paths) {
    const { normalizedTarget, resolvedTargetBinaryPath, upstreamBinaryPath } = paths;
    const legacyTargetBackupPath = `${normalizedTarget}.aih-original`;
    const candidates = [
      legacyTargetBackupPath,
      `${legacyTargetBackupPath}${pathImpl.extname(upstreamBinaryPath)}`,
      `${resolvedTargetBinaryPath}.aih-original`
    ];
    const legacyUpstreamBinaryPaths = Array.from(new Set(candidates))
      .filter((candidate) => candidate && candidate !== upstreamBinaryPath);
    if (
      upstreamBinaryPath
      && !fs.existsSync(upstreamBinaryPath)
      && isNodeEntryContent(legacyTargetBackupPath)
      && !legacyUpstreamBinaryPaths.includes(legacyTargetBackupPath)
    ) {
      legacyUpstreamBinaryPaths.push(legacyTargetBackupPath);
    }
    return legacyUpstreamBinaryPaths;
  }

  function resolvePaths() {
    const targetBinaryPath = typeof resolveCliPath === 'function'
      ? String(resolveCliPath('codex') || '').trim()
      : '';
    return resolveTargetPaths(targetBinaryPath);
  }

  function isDesktopBundleBinary(targetBinaryPath) {
    return /\/Codex\.app\/Contents\/Resources\/codex$/.test(String(targetBinaryPath || '').trim());
  }

  function resolveTargetPaths(targetBinaryPath) {
    if (!targetBinaryPath) {
      return {
        targetBinaryPath: '',
        upstreamBinaryPath: '',
        reason: 'codex_cli_not_found'
      };
    }
    const upstream = resolveUpstreamBinaryPath(targetBinaryPath);
    if (
      isDesktopBundleBinary(targetBinaryPath)
      || isDesktopBundleBinary(upstream.resolvedTargetBinaryPath)
    ) {
      return {
        targetBinaryPath,
        resolvedTargetBinaryPath: upstream.resolvedTargetBinaryPath,
        upstreamBinaryPath: '',
        reason: 'desktop_bundle_binary'
      };
    }
    return {
      targetBinaryPath,
      resolvedTargetBinaryPath: upstream.resolvedTargetBinaryPath,
      upstreamBinaryPath: upstream.upstreamBinaryPath,
      legacyUpstreamBinaryPaths: upstream.legacyUpstreamBinaryPaths,
      reason: ''
    };
  }

  function isWrapperInstalled(targetBinaryPath) {
    return WRAPPER_MARKER_LINE_PATTERN.test(readTextFile(targetBinaryPath));
  }

  function resolveRealPath(filePath) {
    const normalized = String(filePath || '').trim();
    if (!normalized) return '';
    try {
      return fs.existsSync(normalized) && typeof fs.realpathSync === 'function'
        ? String(fs.realpathSync(normalized) || '').trim()
        : normalized;
    } catch (_error) {
      return normalized;
    }
  }

  function isSameFile(leftPath, rightPath) {
    const left = resolveRealPath(leftPath);
    const right = resolveRealPath(rightPath);
    return Boolean(left && right && left === right);
  }

  function resolvePnpmShimRuntimeTarget(filePath) {
    const content = readTextFile(filePath);
    const match = content.match(/\$basedir\/([^"]*node_modules\/@openai\/codex\/bin\/codex\.js)/);
    if (!match || !match[1]) return '';
    return pathImpl.resolve(pathImpl.dirname(String(filePath || '')), match[1]);
  }

  function resolveUpstreamDelegateTarget(filePath) {
    const content = readTextFile(filePath);
    if (!/^# aih-codex-upstream-delegate\r?$/m.test(content)) return '';
    const quoted = content.match(/^exec\s+(['"])(.+?)\1\s+"\$@"\s*$/m);
    return quoted && quoted[2] ? String(quoted[2]).trim() : '';
  }

  function isCleanExecutableSnapshot(filePath, visited = new Set()) {
    const normalized = String(filePath || '').trim();
    if (!normalized || !fs.existsSync(normalized) || isWrapperInstalled(normalized)) return false;
    const realPath = resolveRealPath(normalized);
    if (visited.has(realPath)) return false;
    visited.add(realPath);
    const pnpmShimTarget = resolvePnpmShimRuntimeTarget(normalized);
    if (pnpmShimTarget && !fs.existsSync(pnpmShimTarget)) return false;
    const delegateTarget = resolveUpstreamDelegateTarget(normalized);
    return !delegateTarget || isCleanExecutableSnapshot(delegateTarget, visited);
  }

  function isTrustedUpstreamFile(upstreamBinaryPath, targetBinaryPath) {
    const upstream = String(upstreamBinaryPath || '').trim();
    if (!isCleanExecutableSnapshot(upstream)) return false;
    return !isSameFile(upstream, targetBinaryPath);
  }

  function writeState(enabled, paths, extras = {}) {
    if (!stateFilePath) return false;
    fs.mkdirSync(pathImpl.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify({
      version: 1,
      enabled: enabled === true,
      updatedAt: new Date().toISOString(),
      targetBinaryPath: String(paths && paths.targetBinaryPath || ''),
      upstreamBinaryPath: String(paths && paths.upstreamBinaryPath || ''),
      ...extras
    }, null, 2));
    return true;
  }

  function copyExecutableSnapshot(sourcePath, destinationPath) {
    const stat = fs.statSync(sourcePath);
    const content = fs.readFileSync(sourcePath);
    fs.writeFileSync(destinationPath, content);
    fs.chmodSync(destinationPath, stat.mode & 0o777);
    return stat;
  }

  function copyUpstreamSnapshot(targetBinaryPath, upstreamBinaryPath) {
    return copyExecutableSnapshot(targetBinaryPath, upstreamBinaryPath);
  }

  function ensureUpstreamSnapshot(paths) {
    const { targetBinaryPath, upstreamBinaryPath, legacyUpstreamBinaryPaths } = paths;
    if (isTrustedUpstreamFile(upstreamBinaryPath, targetBinaryPath)) {
      return {
        ok: true,
        migrated: false,
        upstreamBinaryPath
      };
    }
    const legacyCandidates = Array.isArray(legacyUpstreamBinaryPaths)
      ? legacyUpstreamBinaryPaths
      : [];
    for (const legacyUpstreamBinaryPath of legacyCandidates) {
      if (!isTrustedUpstreamFile(legacyUpstreamBinaryPath, targetBinaryPath)) continue;
      copyExecutableSnapshot(legacyUpstreamBinaryPath, upstreamBinaryPath);
      try {
        fs.unlinkSync(legacyUpstreamBinaryPath);
      } catch (_error) {}
      return {
        ok: true,
        migrated: true,
        upstreamBinaryPath
      };
    }
    if (!targetBinaryPath || !fs.existsSync(targetBinaryPath)) {
      return {
        ok: false,
        migrated: false,
        reason: 'target_binary_missing'
      };
    }
    if (isWrapperInstalled(targetBinaryPath)) {
      return {
        ok: false,
        migrated: false,
        reason: 'upstream_backup_invalid'
      };
    }
    copyUpstreamSnapshot(targetBinaryPath, upstreamBinaryPath);
    return {
      ok: true,
      migrated: false,
      upstreamBinaryPath
    };
  }

  function installWrapper(paths) {
    const { targetBinaryPath, upstreamBinaryPath } = paths;
    if (!targetBinaryPath || !fs.existsSync(targetBinaryPath)) {
      return {
        ok: false,
        installed: false,
        reason: 'target_binary_missing'
      };
    }

    const wrapper = buildWrapperScriptForTarget(targetBinaryPath, {
      nodeExecPath,
      helperScriptPath,
      upstreamBinaryPath,
      stateFilePath
    });

    if (isWrapperInstalled(targetBinaryPath)) {
      const snapshotResult = ensureUpstreamSnapshot(paths);
      if (!snapshotResult.ok) {
        return {
          ok: false,
          installed: false,
          reason: String(snapshotResult.reason || 'missing_upstream_backup')
        };
      }
      fs.writeFileSync(targetBinaryPath, wrapper, 'utf8');
      fs.chmodSync(targetBinaryPath, 0o755);
      return {
        ok: true,
        installed: true,
        updated: true,
        targetBinaryPath,
        upstreamBinaryPath,
        migrated: snapshotResult.migrated,
        recovered: false
      };
    }

    copyUpstreamSnapshot(targetBinaryPath, upstreamBinaryPath);
    fs.writeFileSync(targetBinaryPath, wrapper, 'utf8');
    fs.chmodSync(targetBinaryPath, 0o755);
    return {
      ok: true,
      installed: true,
      updated: false,
      targetBinaryPath,
      upstreamBinaryPath
    };
  }

  function isTargetHealthy(paths) {
    const wrapperInstalled = isWrapperInstalled(paths.targetBinaryPath);
    const expectedWrapper = buildWrapperScriptForTarget(paths.targetBinaryPath, {
      nodeExecPath,
      helperScriptPath,
      upstreamBinaryPath: paths.upstreamBinaryPath,
      stateFilePath
    });
    const wrapperCurrent = readTextFile(paths.targetBinaryPath) === expectedWrapper;
    const upstreamReady = isTrustedUpstreamFile(paths.upstreamBinaryPath, paths.targetBinaryPath);
    return wrapperInstalled && upstreamReady && wrapperCurrent;
  }

  function installTarget(paths) {
    const result = inspectOrInstallTarget(paths);
    writeState(result.enabled, result, { reason: result.reason || '' });
    return result;
  }

  function inspectOrInstallTarget(paths) {
    if (!paths.targetBinaryPath || paths.reason === 'desktop_bundle_binary') {
      return {
        ok: true,
        supported: true,
        enabled: false,
        reason: paths.reason || 'codex_cli_not_found',
        targetBinaryPath: paths.targetBinaryPath,
        repaired: false
      };
    }
    if (isTargetHealthy(paths)) {
      return {
        ok: true,
        supported: true,
        enabled: true,
        healthy: true,
        targetBinaryPath: paths.targetBinaryPath,
        resolvedTargetBinaryPath: paths.resolvedTargetBinaryPath,
        upstreamBinaryPath: paths.upstreamBinaryPath,
        repaired: false
      };
    }
    const installed = installWrapper(paths);
    return {
      ...installed,
      supported: true,
      enabled: Boolean(installed.ok),
      healthy: Boolean(installed.ok),
      repaired: Boolean(installed.ok),
      targetBinaryPath: paths.targetBinaryPath,
      resolvedTargetBinaryPath: paths.resolvedTargetBinaryPath,
      upstreamBinaryPath: paths.upstreamBinaryPath
    };
  }

  function ensureInstalled() {
    return installTarget(resolvePaths());
  }

  function activate() {
    return {
      ...installTarget(resolvePaths()),
      stateFilePath
    };
  }

  function deactivate() {
    const paths = resolvePaths();
    if (!stateFilePath) {
      return { ok: true, supported: true, enabled: false };
    }
    writeState(false, paths);
    return {
      ok: true,
      supported: processObj.platform !== 'win32',
      enabled: false,
      stateFilePath
    };
  }

  return {
    resolvePaths,
    buildWrapperScript,
    ensureInstalled,
    activate,
    deactivate,
    isWrapperInstalled
  };
}

module.exports = {
  WRAPPER_MARKER,
  buildWrapperScript,
  buildWindowsPowerShellWrapperScript,
  buildWindowsCmdWrapperScript,
  createCodexCliHookService
};
