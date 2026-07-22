'use strict';

/**
 * Strategy registry for native CLI install + discovery.
 *
 * Open/Closed: add a provider by registering a strategy; callers only depend on
 * resolveNativeCliInstallPlans / collectNativeCliPathEntries.
 * Single Responsibility: each strategy owns one provider family's install URLs
 * and on-disk binary search roots (cross-platform).
 */

const CLAUDE_PROVIDER = 'claude';
const CLAUDE_WINDOWS_INSTALL_URL = 'https://claude.ai/install.ps1';

const QODER_REGIONS = Object.freeze({
  qoder: Object.freeze({
    id: 'qoder_global',
    label: 'Qoder CLI (global) official installer',
    bashUrl: 'https://qoder.com/install',
    ps1Url: 'https://qoder.com/install.ps1',
    // Primary CLI binary is qodercli; desktop may also expose qoder.cmd.
    binaryNames: Object.freeze(['qodercli', 'qoder'])
  }),
  qodercn: Object.freeze({
    id: 'qoder_cn',
    label: 'Qoder CLI CN official installer',
    bashUrl: 'https://qoder.com.cn/install',
    ps1Url: 'https://qoder.com.cn/install.ps1',
    // CN must NOT fall back to global `qoder` / `qodercli` — separate auth plane.
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
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$installer = Invoke-RestMethod -Uri '${ps1Url}'`,
    'Invoke-Expression $installer'
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

      // Official install `qodercli install` / `qoderclicn install` places shims here.
      const localBin = joinIf(pathImpl, hostHomeDir, '.local', 'bin');
      if (localBin) entries.push(localBin);

      if (platform === 'win32' && pathImpl) {
        const localAppData = String(env.LOCALAPPDATA || '').trim()
          || (hostHomeDir ? pathImpl.join(hostHomeDir, 'AppData', 'Local') : '');
        const programFiles = String(env.ProgramFiles || 'C:\\Program Files').trim();
        const programFilesX86 = String(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)').trim();
        // Observed layouts from official Windows installer + desktop companion.
        [
          localAppData ? pathImpl.join(localAppData, 'qodercli') : '',
          localAppData ? pathImpl.join(localAppData, 'qoderclicn') : '',
          localAppData ? pathImpl.join(localAppData, 'QoderCli') : '',
          localAppData ? pathImpl.join(localAppData, 'Programs', 'Qoder') : '',
          pathImpl.join(programFiles, 'Qoder', 'bin'),
          pathImpl.join(programFilesX86, 'Qoder', 'bin'),
          hostHomeDir ? pathImpl.join(hostHomeDir, 'AppData', 'Roaming', 'npm') : ''
        ].filter(Boolean).forEach((entry) => entries.push(entry));
      } else if (pathImpl) {
        [
          hostHomeDir ? pathImpl.join(hostHomeDir, '.qoder', 'bin') : '',
          '/usr/local/bin',
          '/opt/homebrew/bin'
        ].filter(Boolean).forEach((entry) => entries.push(entry));
      }
      return entries;
    },
    resolveInstallPlans(provider, pkg, options = {}) {
      const processObj = options.processObj || process;
      const platform = normalizePlatform(processObj);
      if (platform === 'win32') {
        return [buildWindowsPs1Plan(`${region.id}_windows`, region.label, region.ps1Url, options)];
      }
      return [buildPosixCurlBashPlan(`${region.id}_posix`, region.label, region.bashUrl)];
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
  buildPosixCurlBashPlan
};
