'use strict';

const nodePath = require('node:path');
const nodeFs = require('node:fs');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const { listProviderDefinitions } = require('../../../provider-catalog');
const { resolvePlatformPath } = require('../../../runtime/platform-path');
const {
  resolveProviderCliPath,
  ensureNativeCliAvailable,
  installNativeCliWithProgress
} = require('../ai-cli/ensure-native-cli');
const { hasDesktopInstallPlan } = require('../ai-cli/desktop-install-strategies');
const { getAppInstaller } = require('../../../server/app-installers');
const {
  getAiCliConfig,
  getAiCliBinaryName,
  listSupportedAiClis
} = require('../ai-cli/provider-registry');
const {
  diagnoseProviderSessionHookConfig,
  installProviderSessionHooks
} = require('../../../server/provider-session-hook-config');
const {
  resolveDesktopClientProfileDir
} = require('../ai-cli/desktop-client-profile');
const { resolveHostHomeDir } = require('../../../runtime/host-home');

/**
 * AppManager: scans and manages all AI developer apps, CLIs, desktop clients, and IDE tools.
 * Single Responsibility: Aggregates app detection, metadata extraction, hook status, and installs.
 */

// Category mapping comes from the generated Provider contract. The toolkit must
// not maintain a second hard-coded Provider list that would become stale when a
// new Provider is added.
const APP_CATEGORIES = Object.freeze({
  cli: Object.freeze(listSupportedAiClis()),
  desktop: Object.freeze(listProviderDefinitions()
    .filter((definition) => definition.cli && definition.cli.desktopClient)
    .map((definition) => `${definition.id}-desktop`)),
  ide: Object.freeze(['vscode', 'cursor', 'windsurf']),
  agents: Object.freeze([])
});

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

function resolvePlatform(options = {}) {
  const processObj = options.processObj || process;
  return String(options.platform || processObj.platform || process.platform).trim().toLowerCase();
}

function resolvePathApi(options = {}, platform = resolvePlatform(options)) {
  return resolvePlatformPath(platform, options.path || nodePath);
}

function resolveProcessEnv(options = {}) {
  const processObj = options.processObj || process;
  return options.env || processObj.env || process.env || {};
}

function uniqueValues(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function normalizePathToken(value, hostHome) {
  return String(value || '').replace('{hostHomeDir}', hostHome).trim();
}

function getDesktopClientConfig(provider, platform) {
  const cliConfig = getAiCliConfig(provider) || {};
  const desktopClient = cliConfig.desktopClient || {};
  const platformKey = platform === 'darwin'
    ? 'macos'
    : platform === 'win32'
      ? 'windows'
      : platform;
  return desktopClient[platformKey] || null;
}

function getDesktopExecNames(desktopConfig = {}) {
  return uniqueValues([
    ...(Array.isArray(desktopConfig.execNames) ? desktopConfig.execNames : []),
    ...(Array.isArray(desktopConfig.processNames) ? desktopConfig.processNames : [])
  ]);
}

function buildDesktopInstallCandidates(provider, options = {}) {
  const platform = resolvePlatform(options);
  const pathImpl = resolvePathApi(options, platform);
  const env = resolveProcessEnv(options);
  const hostHome = resolveHostHome(options);
  const config = getDesktopClientConfig(provider, platform);
  if (!config) return [];

  const candidates = Array.isArray(config.installPaths)
    ? config.installPaths.map((candidate) => normalizePathToken(candidate, hostHome))
    : [];
  const execNames = getDesktopExecNames(config);

  if (platform === 'win32') {
    const roots = uniqueValues([
      env.LOCALAPPDATA,
      env.ProgramFiles,
      env.ProgramW6432,
      env['ProgramFiles(x86)'],
      hostHome ? pathImpl.join(hostHome, 'AppData', 'Local') : '',
      hostHome ? pathImpl.join(hostHome, 'AppData', 'Roaming') : ''
    ]);
    const appNames = uniqueValues(execNames.map((name) => pathImpl.basename(name, '.exe')));
    roots.forEach((root) => {
      appNames.forEach((appName) => {
        candidates.push(pathImpl.join(root, 'Programs', appName, `${appName}.exe`));
        candidates.push(pathImpl.join(root, appName, `${appName}.exe`));
        candidates.push(pathImpl.join(root, 'OpenAI', appName, `${appName}.exe`));
      });
    });
  } else if (platform === 'linux') {
    const roots = ['/usr/bin', '/usr/local/bin', '/opt', hostHome ? pathImpl.join(hostHome, '.local', 'bin') : ''];
    execNames.forEach((name) => {
      const executable = pathImpl.basename(name);
      roots.forEach((root) => {
        if (!root) return;
        candidates.push(pathImpl.join(root, executable));
        candidates.push(pathImpl.join(root, executable, executable));
      });
    });
  }

  return uniqueValues(candidates);
}

function readInfoPlistValue(content, key) {
  const escaped = String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(content || '').match(new RegExp(`<key>${escaped}</key>\\s*<string>([^<]*)</string>`));
  return match ? String(match[1] || '').trim() : '';
}

function normalizeJsonRows(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return [value];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch (_error) {
    return [];
  }
}

function quotePowerShellLiteral(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function findWindowsStoreDesktopClient(provider, desktopConfig, options = {}) {
  if (resolvePlatform(options) !== 'win32' || provider !== 'codex') return null;
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const pathImpl = resolvePathApi(options, 'win32');
  const executableNames = new Set(getDesktopExecNames(desktopConfig).map((name) => name.toLowerCase()));
  const script = [
    'Get-AppxPackage -ErrorAction SilentlyContinue',
    "Where-Object { $_.Name -like 'OpenAI.*' }",
    'ForEach-Object { $manifest = Get-AppxPackageManifest -Package $_ -ErrorAction SilentlyContinue; $application = @($manifest.Package.Applications.Application)[0]; [PSCustomObject]@{ Name=$_.Name; InstallLocation=$_.InstallLocation; Version=$_.Version.ToString(); Executable=$application.Executable } }',
    'ConvertTo-Json -Compress'
  ].join(' | ');
  let rows = [];
  try {
    const result = spawnSyncImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 1024 * 1024
    });
    rows = normalizeJsonRows(result && result.status === 0 ? result.stdout : '');
  } catch (_error) {
    return null;
  }

  const rankedRows = rows.slice().sort((left, right) => {
    const rank = (row) => String(row && (row.Name || row.name) || '').toLowerCase() === 'openai.codex' ? 0 : 1;
    return rank(left) - rank(right);
  });
  for (const row of rankedRows) {
    const installLocation = String(row.InstallLocation || row.installLocation || '').trim();
    if (!installLocation) continue;
    const packageName = String(row.Name || row.name || '').trim();
    const manifestExecutable = String(row.Executable || row.executable || '').trim();
    const executableName = pathImpl.basename(manifestExecutable).toLowerCase();
    const packageMatches = /(?:codex|chatgpt)/i.test(packageName);
    if (manifestExecutable && !executableNames.has(executableName) && !packageMatches) continue;
    const relativeExecutable = manifestExecutable || pathImpl.join('app', getDesktopExecNames(desktopConfig)[0] || 'ChatGPT.exe');
    const executablePath = pathImpl.isAbsolute(relativeExecutable)
      ? pathImpl.normalize(relativeExecutable)
      : pathImpl.join(installLocation, relativeExecutable);
    return {
      bundlePath: '',
      executablePath,
      displayPath: executablePath,
      clientName: desktopConfig.clientName || 'ChatGPT',
      packageVersion: String(row.Version || row.version || '').trim(),
      packageName
    };
  }
  return null;
}

function getDesktopVersion(record, options = {}) {
  if (!record) return '';
  const fsImpl = options.fs || nodeFs;
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const platform = resolvePlatform(options);
  if (record.packageVersion) return String(record.packageVersion).trim();
  if (platform === 'darwin' && record.bundlePath) {
    const infoPlistPath = nodePath.join(record.bundlePath, 'Contents', 'Info.plist');
    try {
      const content = fsImpl.readFileSync(infoPlistPath, 'utf8');
      const version = readInfoPlistValue(content, 'CFBundleShortVersionString');
      if (version) return version;
    } catch (_error) {
      // Fall through to plutil/binary probes.
    }
    try {
      const result = spawnSyncImpl('/usr/bin/plutil', [
        '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', infoPlistPath
      ], { encoding: 'utf8', windowsHide: true });
      if (result && result.status === 0 && result.stdout) return String(result.stdout).trim();
    } catch (_error) {}
  }
  if (platform === 'win32' && record.executablePath) {
    try {
      const script = `(Get-Item -LiteralPath ${quotePowerShellLiteral(record.executablePath)}).VersionInfo.ProductVersion`;
      const result = spawnSyncImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000,
        maxBuffer: 1024 * 1024
      });
      const version = String(result && result.status === 0 ? result.stdout : '').trim().split(/\r?\n/)[0];
      if (version) return version.slice(0, 64);
    } catch (_error) {}
    return '';
  }
  return getBinaryVersion(record.executablePath || record.displayPath, options);
}

function findDesktopClientRecord(provider, options = {}) {
  const platform = resolvePlatform(options);
  const pathImpl = resolvePathApi(options, platform);
  const fsImpl = options.fs || nodeFs;
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const config = getDesktopClientConfig(provider, platform);
  if (!config) return null;

  for (const candidate of buildDesktopInstallCandidates(provider, options)) {
    if (!candidate || !fsImpl.existsSync(candidate)) continue;
    if (platform === 'darwin') {
      const execNames = getDesktopExecNames(config);
      const executableName = execNames.find((name) => fsImpl.existsSync(
        pathImpl.join(candidate, 'Contents', 'MacOS', name)
      )) || execNames[0] || '';
      const executablePath = executableName
        ? pathImpl.join(candidate, 'Contents', 'MacOS', executableName)
        : '';
      return {
        bundlePath: candidate,
        executablePath,
        displayPath: candidate,
        clientName: config.clientName || executableName || provider
      };
    }
    return {
      bundlePath: '',
      executablePath: candidate,
      displayPath: candidate,
      clientName: config.clientName || pathImpl.basename(candidate) || provider
    };
  }

  const storeRecord = findWindowsStoreDesktopClient(provider, config, options);
  if (storeRecord) return storeRecord;

  if (platform === 'win32' || platform === 'linux') {
    const resolver = platform === 'win32' ? 'where.exe' : 'which';
    for (const executableName of getDesktopExecNames(config)) {
      try {
        const result = spawnSyncImpl(resolver, [executableName], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 3000,
          maxBuffer: 1024 * 1024
        });
        const executablePath = String(result && result.stdout || '')
          .split(/\r?\n/)
          .map((value) => value.trim())
          .find((value) => value && fsImpl.existsSync(value));
        if (!executablePath) continue;
        return {
          bundlePath: '',
          executablePath,
          displayPath: executablePath,
          clientName: config.clientName || executableName || provider
        };
      } catch (_error) {}
    }
  }

  return null;
}

function findVscodeRecord(options = {}) {
  const platform = resolvePlatform(options);
  const pathImpl = resolvePathApi(options, platform);
  const fsImpl = options.fs || nodeFs;
  const hostHome = resolveHostHome(options);
  const env = resolveProcessEnv(options);
  const candidates = platform === 'darwin'
    ? [
      '/Applications/Visual Studio Code.app',
      hostHome ? pathImpl.join(hostHome, 'Applications', 'Visual Studio Code.app') : ''
    ]
    : platform === 'win32'
      ? [
        env.LOCALAPPDATA ? pathImpl.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe') : '',
        env.ProgramFiles ? pathImpl.join(env.ProgramFiles, 'Microsoft VS Code', 'Code.exe') : '',
        hostHome ? pathImpl.join(hostHome, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe') : ''
      ]
      : [
        '/usr/bin/code',
        '/usr/local/bin/code',
        hostHome ? pathImpl.join(hostHome, '.local', 'bin', 'code') : ''
      ];

  for (const candidate of uniqueValues(candidates)) {
    if (!fsImpl.existsSync(candidate)) continue;
    if (platform === 'darwin') {
      const executableCandidates = ['Visual Studio Code', 'Electron'];
      const executableName = executableCandidates.find((name) => fsImpl.existsSync(
        pathImpl.join(candidate, 'Contents', 'MacOS', name)
      )) || executableCandidates[0];
      return {
        bundlePath: candidate,
        executablePath: pathImpl.join(candidate, 'Contents', 'MacOS', executableName),
        displayPath: candidate,
        clientName: 'Visual Studio Code'
      };
    }
    return {
      bundlePath: '',
      executablePath: candidate,
      displayPath: candidate,
      clientName: 'Visual Studio Code'
    };
  }
  return null;
}

function getConfigFormat(configPath) {
  const rawPath = String(configPath || '').trim();
  const fileName = rawPath.split(/[\\/]/).pop().toLowerCase();
  if (fileName === '.env' || fileName.startsWith('.env.')) return 'dotenv';
  const extension = nodePath.extname(fileName).toLowerCase();
  if (extension === '.toml') return 'toml';
  if (extension === '.jsonc') return 'jsonc';
  if (extension === '.json') return 'json';
  if (extension === '.yaml' || extension === '.yml') return 'yaml';
  if (extension === '.ini' || extension === '.properties') return 'ini';
  if (extension === '.sh' || extension === '.bash' || extension === '.zsh') return 'shellscript';
  return extension.replace(/^\./, '') || 'text';
}

function getConfigMetadata(configPath, pathImpl = nodePath) {
  const target = String(configPath || '').trim();
  return {
    configName: target ? pathImpl.basename(target) : '',
    configFormat: getConfigFormat(target)
  };
}

/**
 * Detect binary version using `--version` or `-v`
 */
function getBinaryVersion(binaryPath, options = {}) {
  if (!binaryPath) return '';
  const spawnSyncImpl = options.spawnSync || spawnSync;
  try {
    const res = spawnSyncImpl(binaryPath, ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true
    });
    if (res.status === 0 && (res.stdout || res.stderr)) {
      const raw = String(res.stdout || '') + '\n' + String(res.stderr || '');
      const match = raw.match(/(?:^|[^0-9])v?(\d+(?:\.\d+){1,3}[A-Za-z][\w.-]*|\d+(?:\.\d+){1,3})(?=$|[^0-9A-Za-z])/i);
      return match ? match[1] : raw.trim().split('\n')[0].slice(0, 32);
    }
  } catch (_e) {
    // Ignore execution errors
  }
  return '';
}

/**
 * Get config directory / file path for an AI CLI provider
 */
function getProviderConfigPath(provider, hostHome, pathImpl = nodePath, options = {}) {
  const norm = String(provider || '').trim().toLowerCase();
  const home = hostHome || '';
  if (!home) return '';

  const platform = resolvePlatform(options);
  const resolvedPath = resolvePathApi({ path: pathImpl, ...options }, platform);
  const env = resolveProcessEnv(options);
  const appData = env.APPDATA || resolvedPath.join(home, 'AppData', 'Roaming');
  const configHome = env.XDG_CONFIG_HOME
    || (platform === 'win32' ? appData : resolvedPath.join(home, '.config'));

  switch (norm) {
    case 'claude':
      return resolvedPath.join(home, '.claude', 'settings.json');
    case 'codex':
      return resolvedPath.join(home, '.codex', 'config.toml');
    case 'opencode':
      return resolvedPath.join(configHome, 'opencode', 'opencode.json');
    case 'gemini':
      return resolvedPath.join(home, '.gemini', 'settings.json');
    case 'agy':
      return resolvedPath.join(home, '.antigravity', 'hooks.json');
    case 'grok':
      return resolvedPath.join(home, '.grok', 'settings.json');
    case 'qoder':
      return resolvedPath.join(home, '.qoder', 'config.json');
    case 'qodercn':
      return resolvedPath.join(home, '.qoder-cn', 'config.json');
    case 'kimi':
      return resolvedPath.join(home, '.kimi', 'config.json');
    case 'kiro':
      return resolvedPath.join(home, '.kiro', 'config.json');
    case 'claude-desktop':
      if (platform === 'darwin') {
        return resolvedPath.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      }
      return resolvedPath.join(configHome, 'Claude', 'claude_desktop_config.json');
    case 'vscode':
      if (platform === 'darwin') {
        return resolvedPath.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
      }
      return platform === 'win32'
        ? resolvedPath.join(appData, 'Code', 'User', 'settings.json')
        : resolvedPath.join(configHome, 'Code', 'User', 'settings.json');
    case 'frpc':
      return resolvedPath.join(home, '.config', 'frp', 'frpc.toml');
    case 'frps':
      return resolvedPath.join(home, '.config', 'frp', 'frps.toml');
    case 'cloudflared':
      return resolvedPath.join(home, '.cloudflared', 'config.yml');
    default:
      return resolvedPath.join(home, `.${norm}`);
  }
}

/**
 * List all managed apps with detailed status, versions, paths, and hook diagnostics
 */
async function listManagedApps(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const platform = resolvePlatform(options);
  const pathImpl = resolvePathApi(options, platform);
  const hostHome = resolveHostHome(options);
  const definitions = listProviderDefinitions();
  const defMap = new Map(definitions.map((d) => [d.id, d]));

  const cliList = listSupportedAiClis();
  const apps = [];

  for (const providerId of cliList) {
    const def = defMap.get(providerId) || {};
    const cliConfig = getAiCliConfig(providerId) || {};
    const binaryName = getAiCliBinaryName(providerId);
    const cliPath = resolveProviderCliPath(providerId, {
      ...options,
      hostHomeDir: hostHome
    });

    const isInstalled = Boolean(cliPath);
    let version = '';
    if (isInstalled) {
      version = getBinaryVersion(cliPath, options);
    }

    const configPath = getProviderConfigPath(providerId, hostHome, pathImpl, {
      ...options,
      platform
    });
    const configExists = configPath ? fsImpl.existsSync(configPath) : false;
    const configMetadata = getConfigMetadata(configPath, pathImpl);

    // Diagnose hook status
    let hookStatus = null;
    try {
      hookStatus = diagnoseProviderSessionHookConfig(providerId, {}, {
        hostHomeDir: hostHome
      });
    } catch (_e) {
      // ignore hook diagnosis error
    }

    // Determine category
    const categories = ['ALL', 'CLI Code'];
    if (Array.isArray(cliConfig.categories)) {
      cliConfig.categories.forEach((category) => {
        const normalized = String(category || '').trim();
        if (normalized && !categories.includes(normalized)) categories.push(normalized);
      });
    }
    apps.push({
      id: providerId,
      name: (def.presentation && def.presentation.label) || def.name || cliConfig.name || providerId,
      provider: providerId,
      type: 'cli',
      categories,
      binaryName,
      cliPath: cliPath || '',
      configExists,
      ...configMetadata,
      installed: isInstalled,
      version: version || (isInstalled ? '未探测到' : '-'),
      pkg: cliConfig.pkg || '',
      defaultModel: def.defaultModel || (cliConfig.models && cliConfig.models[0]) || '',
      supportedModels: def.supportedModels || cliConfig.models || [],
      hookSupported: Boolean(hookStatus && hookStatus.supported),
      hookInstalled: Boolean(hookStatus && hookStatus.installed),
      syncMode: (hookStatus && hookStatus.syncMode) || 'polling',
      installAvailable: Boolean(getAppInstaller(providerId))
    });
  }

  // Desktop Provider 清单直接来自生成合同；新增 Provider 无需修改这里。
  const desktopApps = definitions
    .filter((definition) => definition.cli && definition.cli.desktopClient)
    .map((definition) => {
      const desktopConfig = getDesktopClientConfig(definition.id, platform) || {};
      const label = String(definition.presentation && definition.presentation.label || definition.id).trim();
      const clientName = String(desktopConfig.clientName || label).trim();
      return {
        id: `${definition.id}-desktop`,
        name: clientName,
        provider: definition.id,
        configProvider: definition.id,
        type: 'desktop',
        categories: ['ALL', 'Desktop'],
        binaryName: clientName,
        pkg: '',
        defaultModel: '-',
        supportedModels: []
      };
    });
  desktopApps.push({
    id: 'vscode',
    name: 'Visual Studio Code',
    provider: 'vscode',
    configProvider: 'vscode',
    type: 'ide',
    categories: ['ALL', 'IDE'],
    binaryName: 'code',
    pkg: '',
    defaultModel: '-',
    supportedModels: []
  });

  for (const dApp of desktopApps) {
    const record = dApp.id === 'vscode'
      ? findVscodeRecord({ ...options, platform, path: pathImpl })
      : findDesktopClientRecord(dApp.provider, { ...options, platform, path: pathImpl });
    const configPath = getProviderConfigPath(dApp.configProvider, hostHome, pathImpl, {
      ...options,
      platform
    });
    const configExists = configPath ? fsImpl.existsSync(configPath) : false;
    const configMetadata = getConfigMetadata(configPath, pathImpl);
    const installed = Boolean(record);
    const version = getDesktopVersion(record, { ...options, platform, path: pathImpl });
    apps.push({
      ...dApp,
      binaryName: (record && record.displayPath && pathImpl.basename(record.displayPath)) || dApp.binaryName,
      cliPath: (record && record.displayPath) || '',
      installed,
      version: version || (installed ? '未探测到' : '-'),
      configExists,
      ...configMetadata,
      hookSupported: false,
      hookInstalled: false,
      syncMode: 'unavailable',
      installAvailable: dApp.type === 'desktop' && hasDesktopInstallPlan(dApp.provider, {
        ...options,
        platform,
        path: pathImpl
      })
    });
  }

  return {
    ok: true,
    total: apps.length,
    installedCount: apps.filter((a) => a.installed).length,
    apps
  };
}

/**
 * Install or update an application CLI
 */
async function installApp(providerId, options = {}) {
  const norm = String(providerId || '').trim().toLowerCase();
  const hostHome = resolveHostHome(options);

  return installNativeCliWithProgress(norm, {
    ...options,
    hostHomeDir: hostHome
  });
}

/**
 * Install hooks for one or more providers
 */
async function installAppHooks(providers, options = {}) {
  const list = Array.isArray(providers) ? providers : [providers];
  const hostHome = resolveHostHome(options);
  const results = [];

  for (const p of list) {
    const norm = String(p || '').trim().toLowerCase();
    try {
      const res = installProviderSessionHooks([norm], {
        ...options,
        hostHomeDir: hostHome
      });
      results.push({ provider: norm, ok: true, result: res });
    } catch (e) {
      results.push({ provider: norm, ok: false, error: e.message });
    }
  }

  return { ok: true, results };
}

module.exports = {
  listManagedApps,
  installApp,
  installAppHooks,
  getProviderConfigPath,
  getConfigFormat,
  getDesktopVersion,
  findDesktopClientRecord,
  resolveHostHome,
  APP_CATEGORIES,
  getBinaryVersion
};
