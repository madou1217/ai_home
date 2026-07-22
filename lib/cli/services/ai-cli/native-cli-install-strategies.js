'use strict';

/**
 * Strategy registry for native CLI install + discovery.
 *
 * Open/Closed: add a provider by registering a strategy; callers only depend on
 * resolveNativeCliInstallPlans / collectNativeCliPathEntries.
 * Single Responsibility: each strategy owns one provider family's install URLs
 * and on-disk binary search roots (cross-platform).
 *
 * Qoder install (verified against official scripts + live `qoderclicn install`):
 *   1. Fetch region manifest
 *   2. Download matching archive
 *   3. Extract
 *   4. Run `<binary> install --force`
 * Placement:
 *   global → ~/.qoder/bin/qodercli/qodercli.exe
 *   CN     → ~/.qoder-cn/bin/qoderclicn/qoderclicn.exe
 */

const CLAUDE_PROVIDER = 'claude';
const CLAUDE_WINDOWS_INSTALL_URL = 'https://claude.ai/install.ps1';

const QODER_REGIONS = Object.freeze({
  qoder: Object.freeze({
    id: 'qoder_global',
    label: 'Qoder CLI (global) official installer',
    bashUrl: 'https://qoder.com/install',
    ps1Url: 'https://qoder.com/install.ps1',
    // Official CDN (same as install scripts BASE_URL)
    baseUrl: 'https://qoder-ide.oss-accelerate.aliyuncs.com/qodercli',
    homeDirName: '.qoder',
    binaryDirName: 'qodercli',
    binaryNames: Object.freeze(['qodercli', 'qoder'])
  }),
  qodercn: Object.freeze({
    id: 'qoder_cn',
    label: 'Qoder CLI CN official installer',
    bashUrl: 'https://qoder.com.cn/install',
    ps1Url: 'https://qoder.com.cn/install.ps1',
    baseUrl: 'https://static.qoder.com.cn/qoder-cli-cn',
    homeDirName: '.qoder-cn',
    binaryDirName: 'qoderclicn',
    // CN must NOT fall back to global `qoder` / `qodercli`.
    binaryNames: Object.freeze(['qoderclicn'])
  })
});

function normalizePlatform(processObj = process) {
  return String(processObj.platform || process.platform || '').trim();
}

function resolvePowerShell(processObj, pathImpl) {
  const systemRoot = String(
    processObj.env && (processObj.env.SystemRoot || processObj.env.SYSTEMROOT) || ''
  ).trim();
  if (systemRoot && pathImpl) {
    return pathImpl.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }
  return 'powershell.exe';
}

function buildWindowsPs1Plan(id, label, ps1Url, options = {}) {
  const processObj = options.processObj || process;
  const powershell = resolvePowerShell(processObj, options.path);
  // Download to a real file then execute — Invoke-RestMethod|iex is unreliable
  // under NonInteractive/service contexts (can exit 0 without running body).
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$dest = Join-Path $env:TEMP ('aih-install-' + [guid]::NewGuid().ToString('n') + '.ps1')`,
    `Invoke-WebRequest -Uri '${ps1Url}' -OutFile $dest -UseBasicParsing`,
    '& $dest',
    'Remove-Item -Force $dest -ErrorAction SilentlyContinue'
  ].join('; ');
  return {
    id,
    label,
    command: powershell,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    timeoutMs: 300000
  };
}

function buildPosixCurlBashPlan(id, label, bashUrl) {
  return {
    id,
    label,
    command: 'bash',
    args: ['-lc', `curl -fsSL '${bashUrl}' | bash`],
    timeoutMs: 300000
  };
}

/**
 * Direct Qoder install plan that mirrors the official script pipeline:
 * manifest → download zip/tarball → extract → `<bin> install --force`.
 * This is the reliable non-interactive path for WebUI/server closed loop.
 */
function buildQoderDirectInstallPlan(region, options = {}) {
  const processObj = options.processObj || process;
  const platform = normalizePlatform(processObj);
  const pathImpl = options.path;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const binaryName = region.binaryNames[0];
  const workRoot = hostHomeDir && pathImpl
    ? pathImpl.join(hostHomeDir, region.homeDirName, 'tmp', 'aih-install')
    : '';

  if (platform === 'win32') {
    const powershell = resolvePowerShell(processObj, pathImpl);
    const base = region.baseUrl.replace(/'/g, "''");
    const bin = binaryName.replace(/'/g, "''");
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      `try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}`,
      `$base = '${base}'`,
      `$bin = '${bin}'`,
      `$work = Join-Path $env:TEMP ("aih-" + $bin + "-install-" + [guid]::NewGuid().ToString('n'))`,
      `New-Item -ItemType Directory -Path $work -Force | Out-Null`,
      `try {`,
      `  $manifest = Invoke-RestMethod -Uri ($base + '/channels/manifest.json') -UseBasicParsing`,
      `  $build = 0; try { $build = [Environment]::OSVersion.Version.Build } catch {}`,
      `  $items = @($manifest.files | Where-Object { $_.os -eq 'windows' -and ($_.arch -eq 'amd64' -or $_.arch -eq 'x64') })`,
      `  $file = $items | Where-Object { $_.variant -ne 'legacy' -and $_.runtime -ne 'node-sea' } | Select-Object -First 1`,
      `  if (-not $file) { $file = $items | Select-Object -First 1 }`,
      `  if (-not $file) { throw 'No windows binary in manifest' }`,
      `  if ($file.url -notmatch '^https://') { throw 'Insecure download URL' }`,
      `  $zip = Join-Path $work ($bin + '.zip')`,
      `  Invoke-WebRequest -Uri $file.url -OutFile $zip -UseBasicParsing`,
      `  if ($file.sha256) {`,
      `    $hash = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()`,
      `    if ($hash -ne $file.sha256) { throw ('Checksum mismatch: ' + $hash) }`,
      `  }`,
      `  Expand-Archive -Path $zip -DestinationPath $work -Force`,
      `  $exe = Join-Path $work ($bin + '.exe')`,
      `  if (-not (Test-Path $exe)) { throw ($bin + '.exe missing after extract') }`,
      `  & $exe install --force`,
      `  if ($LASTEXITCODE -ne 0) { throw ($bin + ' install --force failed: ' + $LASTEXITCODE) }`,
      `} finally {`,
      `  Remove-Item -Path $work -Recurse -Force -ErrorAction SilentlyContinue`,
      `}`
    ].join('; ');
    return {
      id: `${region.id}_windows_direct`,
      label: `${region.label} (direct)`,
      command: powershell,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      timeoutMs: 300000
    };
  }

  // POSIX: curl|bash is the official path and already delegates to binary install.
  // Prefer writing the script to a temp file when workRoot known, else pipe.
  if (workRoot) {
    return {
      id: `${region.id}_posix_script`,
      label: `${region.label} (script)`,
      command: 'bash',
      args: [
        '-lc',
        [
          'set -euo pipefail',
          `mkdir -p '${workRoot.replace(/'/g, `'\\''`)}'`,
          `script='${workRoot.replace(/'/g, `'\\''`)}/install.sh'`,
          `curl -fsSL '${region.bashUrl}' -o "$script"`,
          'bash "$script"',
          'rm -f "$script"'
        ].join(' && ')
      ],
      timeoutMs: 300000
    };
  }
  return buildPosixCurlBashPlan(`${region.id}_posix`, region.label, region.bashUrl);
}

function joinIf(pathImpl, hostHomeDir, ...parts) {
  if (!pathImpl || !hostHomeDir) return '';
  return pathImpl.join(hostHomeDir, ...parts);
}

/** @type {import('./native-cli-install-strategies').NativeCliInstallStrategy} */
const claudeInstallStrategy = Object.freeze({
  name: 'claude',
  matches(provider) {
    return String(provider || '').trim() === CLAUDE_PROVIDER;
  },
  collectPathEntries(provider, options = {}) {
    const processObj = options.processObj || process;
    if (normalizePlatform(processObj) !== 'win32') return [];
    const pathImpl = options.path;
    const hostHomeDir = String(options.hostHomeDir || '').trim();
    const entry = joinIf(pathImpl, hostHomeDir, '.local', 'bin');
    return entry ? [entry] : [];
  },
  resolveInstallPlans(provider, pkg, options = {}) {
    const processObj = options.processObj || process;
    const plans = [];
    if (normalizePlatform(processObj) === 'win32') {
      plans.push(buildWindowsPs1Plan(
        'claude_windows_native',
        'Claude Code official Windows installer',
        CLAUDE_WINDOWS_INSTALL_URL,
        options
      ));
    }
    return plans;
  }
});

function createQoderInstallStrategy(regionKey) {
  const region = QODER_REGIONS[regionKey];
  return Object.freeze({
    name: `qoder:${regionKey}`,
    matches(provider) {
      return String(provider || '').trim() === regionKey;
    },
    collectPathEntries(provider, options = {}) {
      const pathImpl = options.path;
      const hostHomeDir = String(options.hostHomeDir || '').trim();
      const processObj = options.processObj || process;
      const platform = normalizePlatform(processObj);
      const env = processObj.env || {};
      const entries = [];

      // Official install layout (verified live):
      //   ~/.qoder/bin/qodercli/qodercli.exe
      //   ~/.qoder-cn/bin/qoderclicn/qoderclicn.exe
      const localBin = joinIf(pathImpl, hostHomeDir, '.local', 'bin');
      if (localBin) entries.push(localBin);

      const officialDir = joinIf(
        pathImpl,
        hostHomeDir,
        region.homeDirName,
        'bin',
        region.binaryDirName
      );
      if (officialDir) entries.push(officialDir);

      // Parent bin dir may hold helpers; keep for completeness.
      const officialBin = joinIf(pathImpl, hostHomeDir, region.homeDirName, 'bin');
      if (officialBin) entries.push(officialBin);

      if (platform === 'win32' && pathImpl) {
        const localAppData = String(env.LOCALAPPDATA || '').trim()
          || (hostHomeDir ? pathImpl.join(hostHomeDir, 'AppData', 'Local') : '');
        const programFiles = String(env.ProgramFiles || 'C:\\Program Files').trim();
        const programFilesX86 = String(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)').trim();
        const desktopName = regionKey === 'qodercn' ? 'QoderCN' : 'Qoder';
        [
          localAppData ? pathImpl.join(localAppData, 'qodercli') : '',
          localAppData ? pathImpl.join(localAppData, 'qoderclicn') : '',
          localAppData ? pathImpl.join(localAppData, 'QoderCli') : '',
          localAppData ? pathImpl.join(localAppData, 'Programs', desktopName) : '',
          pathImpl.join(programFiles, desktopName, 'bin'),
          pathImpl.join(programFilesX86, desktopName, 'bin'),
          hostHomeDir ? pathImpl.join(hostHomeDir, 'AppData', 'Roaming', 'npm') : ''
        ].filter(Boolean).forEach((entry) => entries.push(entry));
      } else if (pathImpl) {
        [
          '/usr/local/bin',
          '/opt/homebrew/bin'
        ].forEach((entry) => entries.push(entry));
      }
      return entries;
    },
    resolveInstallPlans(provider, pkg, options = {}) {
      // Prefer direct (manifest → binary install --force) for non-interactive
      // WebUI/server; keep official script as fallback.
      const processObj = options.processObj || process;
      const platform = normalizePlatform(processObj);
      const plans = [buildQoderDirectInstallPlan(region, options)];
      if (platform === 'win32') {
        plans.push(buildWindowsPs1Plan(`${region.id}_windows_script`, `${region.label} (script)`, region.ps1Url, options));
      } else {
        plans.push(buildPosixCurlBashPlan(`${region.id}_posix`, region.label, region.bashUrl));
      }
      return plans;
    },
    binaryNames: region.binaryNames
  });
}

const qoderGlobalInstallStrategy = createQoderInstallStrategy('qoder');
const qoderCnInstallStrategy = createQoderInstallStrategy('qodercn');

const DEFAULT_STRATEGIES = Object.freeze([
  claudeInstallStrategy,
  qoderGlobalInstallStrategy,
  qoderCnInstallStrategy
]);

function listInstallStrategies(options = {}) {
  if (Array.isArray(options.strategies) && options.strategies.length) return options.strategies;
  return DEFAULT_STRATEGIES;
}

function findInstallStrategy(provider, options = {}) {
  const normalized = String(provider || '').trim();
  return listInstallStrategies(options).find((strategy) => strategy.matches(normalized)) || null;
}

function collectStrategyPathEntries(provider, options = {}) {
  const strategy = findInstallStrategy(provider, options);
  if (!strategy || typeof strategy.collectPathEntries !== 'function') return [];
  return strategy.collectPathEntries(provider, options).filter(Boolean);
}

function resolveStrategyInstallPlans(provider, pkg, options = {}) {
  const strategy = findInstallStrategy(provider, options);
  if (!strategy || typeof strategy.resolveInstallPlans !== 'function') return [];
  return strategy.resolveInstallPlans(provider, pkg, options).filter(Boolean);
}

function listStrategyBinaryNames(provider, options = {}) {
  const strategy = findInstallStrategy(provider, options);
  if (strategy && Array.isArray(strategy.binaryNames) && strategy.binaryNames.length) {
    return strategy.binaryNames.map((name) => String(name || '').trim()).filter(Boolean);
  }
  return [];
}

module.exports = {
  CLAUDE_PROVIDER,
  CLAUDE_WINDOWS_INSTALL_URL,
  QODER_REGIONS,
  claudeInstallStrategy,
  qoderGlobalInstallStrategy,
  qoderCnInstallStrategy,
  DEFAULT_STRATEGIES,
  listInstallStrategies,
  findInstallStrategy,
  collectStrategyPathEntries,
  resolveStrategyInstallPlans,
  listStrategyBinaryNames,
  buildWindowsPs1Plan,
  buildPosixCurlBashPlan,
  buildQoderDirectInstallPlan
};
