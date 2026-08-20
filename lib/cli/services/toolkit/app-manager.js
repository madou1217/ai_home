'use strict';

const nodePath = require('node:path');
const nodeFs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const os = require('node:os');
const { listProviderDefinitions } = require('../../../provider-catalog');
const { resolvePlatformPath } = require('../../../runtime/platform-path');
const { resolveClientPlatform } = require('../../../runtime/client-platform');
const {
  resolveProviderCliPath,
  ensureNativeCliAvailable,
  installNativeCliWithProgress
} = require('../ai-cli/ensure-native-cli');
const { hasDesktopInstallPlan } = require('../ai-cli/desktop-install-strategies');
const { getAppInstaller, listManagedAppInstallers } = require('../../../server/app-installers');
const {
  getAiCliConfig,
  getAiCliBinaryName,
  listInstallableAiClis
} = require('../ai-cli/provider-registry');
const {
  diagnoseProviderSessionHookConfig,
  installProviderSessionHookConfig,
  getCodexConfigTomlTarget,
  getProviderHookConfigTarget
} = require('../../../server/provider-session-hook-config');
const {
  resolveDesktopClientProfileDir
} = require('../ai-cli/desktop-client-profile');
const {
  listIdeClients,
  getIdeClient,
  resolveIdeExtensionRoots,
  getIdeConfigPath,
  findIdeClientRecord
} = require('./ide-client-registry');
const { resolveHostHomeDir } = require('../../../runtime/host-home');

const VERSION_CACHE_MS = 10 * 60 * 1000;
const versionCache = new Map();
const versionInFlight = new Map();
const INVENTORY_CACHE_MS = 1000;
const inventoryCache = new Map();
const inventoryInFlight = new Map();
const inventoryDependencyIds = new WeakMap();
let nextInventoryDependencyId = 1;

/**
 * AppManager: scans and manages all AI developer apps, CLIs, desktop clients, and IDE tools.
 * Single Responsibility: Aggregates app detection, metadata extraction, hook status, and installs.
 */

// Category mapping comes from the generated Provider contract. The toolkit must
// not maintain a second hard-coded Provider list that would become stale when a
// new Provider is added.
const APP_CATEGORIES = Object.freeze({
  cli: Object.freeze(uniqueValues([
    ...listInstallableAiClis(),
    ...listManagedAppInstallers().map((installer) => installer.provider)
  ])),
  desktop: Object.freeze(listProviderDefinitions()
    .filter((definition) => definition.clients && definition.clients.desktop)
    .map((definition) => `${definition.id}-desktop`)),
  ide: Object.freeze(listIdeClients())
});

function readJsonFileSafe(fsImpl, filePath) {
  if (!filePath || !fsImpl || typeof fsImpl.existsSync !== 'function') return {};
  try {
    if (!fsImpl.existsSync(filePath)) return {};
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function readTextFileSafe(fsImpl, filePath) {
  if (!filePath || !fsImpl || typeof fsImpl.existsSync !== 'function') return '';
  try {
    return fsImpl.existsSync(filePath) ? String(fsImpl.readFileSync(filePath, 'utf8') || '') : '';
  } catch (_error) {
    return '';
  }
}

function resolveHookDiagnosis(providerId, hostHome, fsImpl, pathImpl, options = {}) {
  const targetPath = getProviderHookConfigTarget(providerId, { homeDir: hostHome });
  const codexConfigPath = providerId === 'codex'
    ? getCodexConfigTomlTarget({ homeDir: hostHome })
    : '';
  const config = readJsonFileSafe(fsImpl, targetPath);
  const status = diagnoseProviderSessionHookConfig(providerId, config, {
    ...options,
    hostHomeDir: hostHome,
    homeDir: hostHome,
    path: pathImpl,
    codexConfigText: readTextFileSafe(fsImpl, codexConfigPath)
  });
  return {
    ...status,
    targetPath,
    targetKind: status.targetKind || '',
    reason: status.reason || (status.installed ? '' : status.disabled ? 'disabled' : 'missing_events')
  };
}

function resolveLifecycleCapability(installer, action, options = {}) {
  if (!installer || typeof installer.resolveLifecyclePlans !== 'function') return false;
  try {
    return installer.resolveLifecyclePlans(action, options).length > 0;
  } catch (_error) {
    return false;
  }
}

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
  return resolveClientPlatform(options);
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

function getIdeExtensionRoots(clientId, hostHome, platform, pathImpl, env = {}) {
  return resolveIdeExtensionRoots(clientId, {
    hostHomeDir: hostHome,
    platform,
    pathImpl,
    env
  });
}

function compactExtensionText(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function extensionTextTokens(value) {
  return String(value || '').trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function extensionManifestText(directoryName, manifest) {
  const keywords = Array.isArray(manifest && manifest.keywords) ? manifest.keywords : [];
  return [
    directoryName,
    manifest && manifest.name,
    manifest && manifest.publisher,
    manifest && manifest.displayName,
    manifest && manifest.description,
    ...keywords
  ].map((value) => String(value || '').trim()).filter(Boolean).join(' ');
}

function extensionMatchesProvider(definition, extensionText) {
  if (!definition) return false;
  const label = definition.presentation && definition.presentation.label;
  const aliases = uniqueValues([definition.id, label])
    .map((value) => compactExtensionText(value))
    .filter((value) => value.length >= 4);
  if (!aliases.length) return false;
  const compactText = compactExtensionText(extensionText);
  const tokens = extensionTextTokens(extensionText);
  return aliases.some((alias) => compactText.includes(alias) || tokens.includes(alias));
}

/**
 * Discover the Providers actually represented by an IDE host's installed
 * extension manifests. Provider identity comes from the generated contract;
 * the Toolkit does not maintain a second IDE-to-Provider list.
 */
function discoverIdeIntegrationProviders(clientId, options = {}) {
  const fsImpl = options.fs || nodeFs;
  if (!fsImpl || typeof fsImpl.readdirSync !== 'function') return [];
  const platform = resolvePlatform(options);
  const pathImpl = resolvePathApi(options, platform);
  const hostHome = resolveHostHome(options);
  const env = resolveProcessEnv(options);
  const definitions = listProviderDefinitions();
  const detected = new Set();

  for (const root of getIdeExtensionRoots(clientId, hostHome, platform, pathImpl, env)) {
    let entries;
    try {
      entries = fsImpl.readdirSync(root, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of Array.isArray(entries) ? entries : []) {
      const directoryName = typeof entry === 'string' ? entry : String(entry && entry.name || '').trim();
      if (!directoryName) continue;
      if (typeof entry !== 'string' && typeof entry.isDirectory === 'function' && !entry.isDirectory()) continue;
      const manifestPath = pathImpl.join(root, directoryName, 'package.json');
      const manifest = readJsonFileSafe(fsImpl, manifestPath);
      const text = extensionManifestText(directoryName, manifest);
      definitions.forEach((definition) => {
        if (extensionMatchesProvider(definition, text)) detected.add(definition.id);
      });
    }
  }

  return definitions.filter((definition) => detected.has(definition.id)).map((definition) => definition.id);
}

function normalizePathToken(value, hostHome) {
  return String(value || '').replace('{hostHomeDir}', hostHome).trim();
}

function getDesktopClientConfig(provider, platform) {
  const cliConfig = getAiCliConfig(provider) || {};
  const desktopClient = cliConfig.desktopClient || {};
  return desktopClient[platform] || null;
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

  if (platform === 'windows') {
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
  if (resolvePlatform(options) !== 'windows' || provider !== 'codex') return null;
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const pathImpl = resolvePathApi(options, 'windows');
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
  if (platform === 'macos' && record.bundlePath) {
    const infoPlistPath = nodePath.join(record.bundlePath, 'Contents', 'Info.plist');
    try {
      const content = fsImpl.readFileSync(infoPlistPath, 'utf8');
      const version = readInfoPlistValue(content, 'CFBundleShortVersionString');
      if (version) return version;
    } catch (_error) {
      // Fall through to plutil/binary probes.
    }
    if (!options.deferProbe) {
      try {
        const result = spawnSyncImpl('/usr/bin/plutil', [
          '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', infoPlistPath
        ], { encoding: 'utf8', windowsHide: true });
        if (result && result.status === 0 && result.stdout) return String(result.stdout).trim();
      } catch (_error) {}
    }
  }
  if (platform === 'windows' && record.executablePath) {
    const versionProbe = {
      kind: 'windows-file',
      asyncProbe: probeWindowsFileVersion,
      syncProbe: getWindowsFileVersion
    };
    return options.deferProbe
      ? getDeferredVersion(record.executablePath, options, versionProbe)
      : versionProbe.syncProbe(record.executablePath, options);
  }
  if (options.deferProbe) return getDeferredVersion(record.executablePath || record.displayPath, options);
  return getBinaryVersion(record.executablePath || record.displayPath, options);
}

function getWindowsFileVersion(executablePath, options = {}) {
  if (!executablePath) return '';
  const spawnSyncImpl = options.spawnSync || spawnSync;
  try {
    const script = `(Get-Item -LiteralPath ${quotePowerShellLiteral(executablePath)}).VersionInfo.ProductVersion`;
    const result = spawnSyncImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 1024 * 1024
    });
    const version = String(result && result.status === 0 ? result.stdout : '').trim().split(/\r?\n/)[0];
    return version ? version.slice(0, 64) : '';
  } catch (_error) {
    return '';
  }
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
    if (platform === 'macos') {
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

  if (platform === 'windows' || platform === 'linux') {
    const resolver = platform === 'windows' ? 'where.exe' : 'which';
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
  return findIdeClientRecord('vscode', {
    ...options,
    platform,
    pathImpl,
    hostHomeDir: resolveHostHome(options),
    env: resolveProcessEnv(options)
  });
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
      return parseBinaryVersion(raw, 32);
    }
  } catch (_e) {
    // Ignore execution errors
  }
  return '';
}

function parseBinaryVersion(output, maxLength = 64) {
  const raw = String(output || '');
  const match = raw.match(/(?:^|[^0-9])v?(\d+(?:\.\d+){1,3}[A-Za-z][\w.-]*|\d+(?:\.\d+){1,3})(?=$|[^0-9A-Za-z])/i);
  return match ? match[1] : raw.trim().split(/\r?\n/)[0].slice(0, maxLength);
}

function probeBinaryVersion(binaryPath, options = {}) {
  return probeCommand(binaryPath, ['--version'], options, parseBinaryVersion);
}

function probeWindowsFileVersion(executablePath, options = {}) {
  const script = `(Get-Item -LiteralPath ${quotePowerShellLiteral(executablePath)}).VersionInfo.ProductVersion`;
  return probeCommand('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script
  ], options, (output) => String(output || '').trim().split(/\r?\n/)[0].slice(0, 64));
}

function probeCommand(command, args, options = {}, parseOutput = parseBinaryVersion) {
  const spawnImpl = options.spawn || spawn;
  const timeoutMs = Math.min(Math.max(Number(options.versionProbeTimeoutMs) || 3000, 500), 30000);
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    try {
      child = spawnImpl(command, args, {
        encoding: 'utf8',
        windowsHide: true
      });
    } catch (_error) {
      finish('');
      return;
    }
    if (!child || typeof child.once !== 'function') {
      finish('');
      return;
    }
    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => { stdout += String(chunk || ''); });
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => { stderr += String(chunk || ''); });
    }
    child.once('error', () => finish(''));
    child.once('close', (code) => finish(code === 0 ? parseOutput(`${stdout}\n${stderr}`) : ''));
    timer = setTimeout(() => {
      try { child.kill?.(); } catch (_error) {}
      finish('');
    }, timeoutMs);
    timer.unref?.();
  });
}

function versionCacheKey(binaryPath, options = {}) {
  return `${String(options.platform || process.platform)}:${String(options.versionProbeKind || 'binary')}:${String(binaryPath || '').trim()}`;
}

function getCachedVersion(binaryPath, options = {}) {
  const cached = versionCache.get(versionCacheKey(binaryPath, options));
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  if (!cached || now - cached.at >= VERSION_CACHE_MS) return undefined;
  return cached.value;
}

function scheduleVersionProbe(binaryPath, options = {}, probeVersion = probeBinaryVersion) {
  const normalizedPath = String(binaryPath || '').trim();
  if (!normalizedPath) return;
  const key = versionCacheKey(normalizedPath, options);
  if (versionInFlight.has(key)) return;
  const request = probeVersion(normalizedPath, options)
    .then((value) => {
      versionCache.set(key, {
        at: typeof options.now === 'function' ? options.now() : Date.now(),
        value: String(value || '').trim()
      });
      return value;
    })
    .catch(() => '')
    .finally(() => {
      if (versionInFlight.get(key) === request) versionInFlight.delete(key);
    });
  versionInFlight.set(key, request);
}

function getDeferredVersion(binaryPath, options = {}, versionProbe = {}) {
  const normalizedPath = String(binaryPath || '').trim();
  if (!normalizedPath) return '';
  const probeOptions = {
    ...options,
    versionProbeKind: versionProbe.kind || options.versionProbeKind || 'binary'
  };
  if (options.probeVersions === 'sync') {
    const syncProbe = versionProbe.syncProbe || getBinaryVersion;
    const value = syncProbe(normalizedPath, probeOptions);
    versionCache.set(versionCacheKey(normalizedPath, probeOptions), {
      at: typeof probeOptions.now === 'function' ? probeOptions.now() : Date.now(),
      value
    });
    return value || '未探测到';
  }
  const cached = getCachedVersion(normalizedPath, probeOptions);
  if (cached !== undefined) return cached || '未探测到';
  scheduleVersionProbe(normalizedPath, probeOptions, versionProbe.asyncProbe || probeBinaryVersion);
  return '探测中';
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
  if (getIdeClient(norm)) {
    return getIdeConfigPath(norm, {
      ...options,
      platform,
      pathImpl: resolvedPath,
      hostHomeDir: home,
      homeDir: home,
      env
    });
  }
  const appData = env.APPDATA || resolvedPath.join(home, 'AppData', 'Roaming');
  const configHome = env.XDG_CONFIG_HOME
    || (platform === 'windows' ? appData : resolvedPath.join(home, '.config'));

  const cliConfig = getAiCliConfig(norm);
  if (cliConfig) {
    const globalDir = String(cliConfig.globalDir || `.${norm}`)
      .trim()
      .replace(/^[/\\]+|[/\\]+$/g, '');
    const globalParts = globalDir.split(/[\\/]+/).filter(Boolean);
    let root = globalParts[0] === '.config'
      ? resolvedPath.join(configHome, ...globalParts.slice(1))
      : resolvedPath.join(home, ...globalParts);
    const configSubDir = String(cliConfig.configSubDir || '').trim();
    if (configSubDir) root = resolvedPath.join(root, ...configSubDir.split(/[\\/]+/).filter(Boolean));
    const configFile = String(cliConfig.configFile || '').trim();
    return configFile ? resolvedPath.join(root, configFile) : root;
  }

  switch (norm) {
    case 'claude-desktop':
      if (platform === 'macos') {
        return resolvedPath.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      }
      return resolvedPath.join(configHome, 'Claude', 'claude_desktop_config.json');
    case 'vscode':
      if (platform === 'macos') {
        return resolvedPath.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
      }
      return platform === 'windows'
        ? resolvedPath.join(appData, 'Code', 'User', 'settings.json')
        : resolvedPath.join(configHome, 'Code', 'User', 'settings.json');
    case 'frpc':
      return resolvedPath.join(home, '.config', 'frp', 'frpc.toml');
    default:
      return resolvedPath.join(home, `.${norm}`);
  }
}

/**
 * List all managed apps with detailed status, versions, paths, and hook diagnostics
 */
function buildManagedApps(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const platform = resolvePlatform(options);
  const pathImpl = resolvePathApi(options, platform);
  const hostHome = resolveHostHome(options);
  const definitions = listProviderDefinitions();
  const defMap = new Map(definitions.map((d) => [d.id, d]));

  const standaloneInstallers = listManagedAppInstallers();
  const standaloneByProvider = new Map(standaloneInstallers.map((installer) => [installer.provider, installer]));
  const cliList = uniqueValues([
    ...listInstallableAiClis(),
    ...standaloneInstallers.map((installer) => installer.provider)
  ]);
  const apps = [];

  for (const providerId of cliList) {
    const def = defMap.get(providerId) || {};
    const installer = getAppInstaller(providerId);
    const managedApp = standaloneByProvider.get(providerId)?.managedApp || {};
    const cliConfig = getAiCliConfig(providerId) || managedApp || {};
    const binaryName = getAiCliBinaryName(providerId);
    const cliPath = resolveProviderCliPath(providerId, {
      ...options,
      hostHomeDir: hostHome
    });

    const isInstalled = Boolean(cliPath);
    const version = isInstalled ? getDeferredVersion(cliPath, options) : '';

    const configPath = managedApp.configName || managedApp.configPath
      ? getProviderConfigPath(providerId, hostHome, pathImpl, { ...options, platform })
      : (def.id ? getProviderConfigPath(providerId, hostHome, pathImpl, { ...options, platform }) : '');
    const configExists = configPath ? fsImpl.existsSync(configPath) : false;
    const configMetadata = getConfigMetadata(configPath, pathImpl);

    // Diagnose hook status
    let hookStatus = null;
    try {
      hookStatus = resolveHookDiagnosis(providerId, hostHome, fsImpl, pathImpl, options);
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
    const label = String((def.presentation && def.presentation.label)
      || def.name
      || managedApp.clientName
      || cliConfig.name
      || providerId).trim();
    const lifecycleOptions = { ...options, hostHomeDir: hostHome, platform, provider: providerId };
    apps.push({
      id: providerId,
      // CLI/Desktop 的形态由 type 和语义图标表达，名称只保留应用本身的展示名。
      name: managedApp.name || label,
      provider: providerId,
      clientId: providerId,
      clientName: label,
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
      hookReason: hookStatus && hookStatus.reason || '',
      hookMissingEvents: hookStatus && Array.isArray(hookStatus.missingEvents) ? hookStatus.missingEvents : [],
      installAvailable: Boolean(installer && typeof installer.install === 'function'),
      canUpdate: resolveLifecycleCapability(installer, 'update', lifecycleOptions),
      canUninstall: resolveLifecycleCapability(installer, 'uninstall', lifecycleOptions),
      updateReason: resolveLifecycleCapability(installer, 'update', lifecycleOptions) ? '' : '当前安装方式没有可验证的更新计划',
      uninstallReason: resolveLifecycleCapability(installer, 'uninstall', lifecycleOptions) ? '' : '当前安装方式没有安全的官方卸载计划'
    });
  }

  // Desktop Provider 清单直接来自生成合同；新增 Provider 无需修改这里。
  const desktopApps = definitions
    .filter((definition) => definition.clients && definition.clients.desktop
      && getDesktopClientConfig(definition.id, platform))
    .map((definition) => {
      const desktopConfig = getDesktopClientConfig(definition.id, platform) || {};
      const label = String(definition.presentation && definition.presentation.label || definition.id).trim();
      const clientName = String(desktopConfig.clientName || label).trim();
      return {
        id: `${definition.id}-desktop`,
        name: clientName,
        provider: definition.id,
        clientId: `${definition.id}-desktop`,
        clientName,
        configProvider: definition.id,
        type: 'desktop',
        categories: ['ALL', 'Desktop'],
        binaryName: clientName,
        pkg: '',
        defaultModel: '-',
        supportedModels: []
      };
    });
  desktopApps.push(...listIdeClients().map((clientId) => {
    const client = getIdeClient(clientId);
    return {
      id: client.id,
      name: client.name,
      provider: client.id,
      clientId: client.id,
      clientName: client.name,
      configProvider: client.id,
      type: 'ide',
      categories: ['ALL', 'IDE'],
      binaryName: client.binaryName,
      pkg: '',
      defaultModel: '-',
      supportedModels: []
    };
  }));

  for (const dApp of desktopApps) {
    const record = dApp.type === 'ide'
      ? findIdeClientRecord(dApp.clientId, {
        ...options,
        platform,
        pathImpl,
        hostHomeDir: hostHome,
        env: resolveProcessEnv(options)
      })
      : findDesktopClientRecord(dApp.provider, { ...options, platform, path: pathImpl });
    const configPath = dApp.type === 'ide'
      ? getIdeConfigPath(dApp.clientId, {
        ...options,
        platform,
        pathImpl,
        hostHomeDir: hostHome,
        homeDir: hostHome,
        env: resolveProcessEnv(options)
      })
      : getProviderConfigPath(dApp.configProvider, hostHome, pathImpl, {
        ...options,
        platform
      });
    const configExists = configPath ? fsImpl.existsSync(configPath) : false;
    const configMetadata = getConfigMetadata(configPath, pathImpl);
    const installed = Boolean(record);
    const version = getDesktopVersion(record, {
      ...options,
      platform,
      path: pathImpl,
      deferProbe: options.probeVersions !== 'sync'
    });
    const installer = getAppInstaller(dApp.provider);
    const integrationProviders = dApp.type === 'ide'
      ? discoverIdeIntegrationProviders(dApp.clientId, {
        ...options,
        platform,
        path: pathImpl,
        hostHomeDir: hostHome
      })
      : [];
    const lifecycleOptions = { ...options, hostHomeDir: hostHome, platform, provider: dApp.provider, kind: 'desktop' };
    const canUpdate = resolveLifecycleCapability(installer, 'update', lifecycleOptions);
    const canUninstall = resolveLifecycleCapability(installer, 'uninstall', lifecycleOptions);
    const versionSource = installer && typeof installer.resolveDesktopVersionSource === 'function'
      ? installer.resolveDesktopVersionSource(lifecycleOptions)
      : null;
    apps.push({
      ...dApp,
      ...(dApp.type === 'ide' ? { integrationProviders } : {}),
      binaryName: (record && record.displayPath && pathImpl.basename(record.displayPath)) || dApp.binaryName,
      cliPath: (record && record.displayPath) || '',
      installed,
      version: version || (installed ? '未探测到' : '-'),
      versionSource,
      configExists,
      ...configMetadata,
      hookSupported: false,
      hookInstalled: false,
      syncMode: 'unavailable',
      installAvailable: dApp.type === 'desktop' && hasDesktopInstallPlan(dApp.provider, {
        ...options,
        platform,
        path: pathImpl
      }),
      canUpdate,
      canUninstall,
      updateReason: canUpdate ? '' : '当前桌面安装器没有可验证的更新计划',
      uninstallReason: canUninstall ? '' : '当前桌面安装器没有安全的官方卸载计划'
    });
  }

  return {
    ok: true,
    total: apps.length,
    installedCount: apps.filter((a) => a.installed).length,
    apps
  };
}

function getInventoryCacheKey(options = {}) {
  const explicit = String(options.inventoryCacheKey || '').trim();
  if (explicit) return explicit;
  const env = resolveProcessEnv(options);
  const dependencyId = (value) => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return String(value || '');
    if (!inventoryDependencyIds.has(value)) {
      inventoryDependencyIds.set(value, nextInventoryDependencyId);
      nextInventoryDependencyId += 1;
    }
    return inventoryDependencyIds.get(value);
  };
  return JSON.stringify({
    platform: resolvePlatform(options),
    hostHomeDir: resolveHostHome(options),
    appData: String(env.APPDATA || '').trim(),
    configHome: String(env.XDG_CONFIG_HOME || '').trim(),
    fs: dependencyId(options.fs || nodeFs),
    path: dependencyId(options.path || nodePath),
    spawn: dependencyId(options.spawn || spawn),
    spawnSync: dependencyId(options.spawnSync || spawnSync)
  });
}

function getInventoryNow(options = {}) {
  return typeof options.now === 'function' ? options.now() : Date.now();
}

function invalidateManagedAppsCache(cacheKey = '') {
  const key = String(cacheKey || '').trim();
  if (key) {
    inventoryCache.delete(key);
    return;
  }
  inventoryCache.clear();
}

function listManagedApps(options = {}) {
  const shouldCache = options.cacheInventory !== false
    && options.refreshInventory !== true
    && options.probeVersions !== 'sync';
  if (!shouldCache) return Promise.resolve().then(() => buildManagedApps(options));

  const cacheKey = getInventoryCacheKey(options);
  const cached = inventoryCache.get(cacheKey);
  const now = getInventoryNow(options);
  if (cached && now - cached.at < INVENTORY_CACHE_MS) {
    return Promise.resolve(cached.value);
  }
  const existing = inventoryInFlight.get(cacheKey);
  if (existing) return existing;

  const request = Promise.resolve()
    .then(() => buildManagedApps(options))
    .then((value) => {
      inventoryCache.set(cacheKey, {
        at: getInventoryNow(options),
        value
      });
      return value;
    })
    .finally(() => {
      if (inventoryInFlight.get(cacheKey) === request) inventoryInFlight.delete(cacheKey);
    });
  inventoryInFlight.set(cacheKey, request);
  return request;
}

/**
 * Refresh only one application's local version after the inventory has been
 * read. The inventory scan keeps its short cache and the synchronous probe is
 * deliberately limited to the selected CLI/Desktop target.
 */
async function refreshManagedAppVersion(appId, options = {}) {
  const normalizedAppId = String(appId || '').trim();
  const inventoryOptions = { ...options };
  delete inventoryOptions.probeVersions;
  const inventory = await listManagedApps(inventoryOptions);
  const app = (inventory.apps || []).find((item) => item.id === normalizedAppId);
  if (!app) return { ok: false, error: 'app_not_found', appId: normalizedAppId };

  let version = '';
  let refreshed = { ...app };
  const platform = resolvePlatform(options);
  const hostHome = resolveHostHome(options);
  if (app.type === 'cli' && app.cliPath) {
    version = getDeferredVersion(app.cliPath, {
      ...options,
      platform,
      probeVersions: 'sync'
    });
  } else if (app.type === 'desktop') {
    const record = findDesktopClientRecord(app.provider, {
      ...options,
      platform,
      hostHomeDir: hostHome
    });
    version = getDesktopVersion(record, {
      ...options,
      platform,
      path: resolvePathApi(options, platform),
      probeVersions: 'sync'
    });
    if (record) {
      const pathImpl = resolvePathApi(options, platform);
      refreshed = {
        ...refreshed,
        cliPath: record.displayPath || '',
        binaryName: (record.displayPath && pathImpl.basename(record.displayPath)) || refreshed.binaryName
      };
    }
  }

  const displayVersion = version || (app.installed ? '未探测到' : '-');
  return {
    ok: true,
    app: { ...refreshed, version: displayVersion },
    currentVersion: version || null
  };
}

/**
 * Install or update an application CLI
 */
async function installApp(providerId, options = {}) {
  const norm = String(providerId || '').trim().toLowerCase();
  const hostHome = resolveHostHome(options);

  const installer = getAppInstaller(norm);
  if (installer && typeof installer.installCli === 'function') {
    return installer.installCli({ ...options, hostHomeDir: hostHome });
  }
  return installNativeCliWithProgress(norm, { ...options, hostHomeDir: hostHome });
}

function resolveManagedDesktopTarget(appId) {
  const normalized = String(appId || '').trim().toLowerCase();
  if (!normalized.endsWith('-desktop')) return null;
  const provider = normalized.slice(0, -'-desktop'.length);
  const definition = listProviderDefinitions().find((item) => item.id === provider);
  if (!definition || !definition.clients || !definition.clients.desktop) return null;
  return { appId: normalized, provider };
}

/**
 * Open an installed Toolkit Desktop client without binding the operation to
 * an account. Account-scoped launch remains in account-app-launcher; this
 * method is only the host-level action shown by the Toolkit application card.
 */
function openManagedDesktopApp(appId, options = {}) {
  const target = resolveManagedDesktopTarget(appId);
  if (!target) return { ok: false, error: 'unsupported_app' };

  const platform = resolvePlatform(options);
  const record = findDesktopClientRecord(target.provider, {
    ...options,
    platform,
    hostHomeDir: resolveHostHome(options)
  });
  if (!record) {
    return {
      ok: false,
      error: 'desktop_not_installed',
      appId: target.appId,
      provider: target.provider
    };
  }

  const spawnImpl = options.spawn || spawn;
  const processObj = options.processObj || process;
  const env = options.env || processObj.env || process.env;
  const spawnOptions = {
    detached: true,
    stdio: 'ignore',
    windowsHide: platform === 'windows',
    env
  };
  const command = platform === 'macos' ? 'open' : record.executablePath;
  const args = platform === 'macos'
    ? ['-a', record.bundlePath || record.displayPath]
    : [];
  if (!command || (platform === 'macos' && !args[1])) {
    return { ok: false, error: 'desktop_executable_unavailable', appId: target.appId, provider: target.provider };
  }

  try {
    const child = spawnImpl(command, args, spawnOptions);
    if (child && typeof child.unref === 'function') child.unref();
    return {
      ok: true,
      status: 'launched',
      appId: target.appId,
      provider: target.provider,
      executable: record.executablePath || record.displayPath
    };
  } catch (error) {
    return {
      ok: false,
      error: 'desktop_launch_failed',
      message: String(error && error.message || error || '桌面应用启动失败'),
      appId: target.appId,
      provider: target.provider
    };
  }
}

/**
 * Install hooks for one or more providers
 */
async function installAppHooks(providers, options = {}) {
  const list = Array.isArray(providers) ? providers : [providers];
  const hostHome = resolveHostHome(options);
  const inventory = await listManagedApps({ ...options, hostHomeDir: hostHome });
  const installedByProvider = new Map((inventory.apps || [])
    .filter((app) => app.type === 'cli')
    .map((app) => [app.provider, app]));
  const results = [];

  for (const p of list) {
    const norm = String(p || '').trim().toLowerCase();
    const app = installedByProvider.get(norm);
    try {
      if (!app || !app.installed) throw new Error('请先安装该 CLI，再启用会话同步。');
      if (!app.hookSupported) throw new Error('该应用没有可用的官方会话 Hook。');
      const res = installProviderSessionHookConfig(norm, {
        ...options,
        hostHomeDir: hostHome,
        homeDir: hostHome
      });
      const verified = resolveHookDiagnosis(norm, hostHome, options.fs || nodeFs, options.path || nodePath, options);
      results.push({
        provider: norm,
        ok: Boolean(res && res.ok && verified.installed),
        verified: Boolean(verified.installed),
        installed: Boolean(verified.installed),
        missingEvents: verified.missingEvents || [],
        reason: verified.reason || '',
        result: res
      });
    } catch (e) {
      results.push({ provider: norm, ok: false, verified: false, error: e.message });
    }
  }

  return { ok: results.length > 0 && results.every((result) => result.ok), results };
}

module.exports = {
  listManagedApps,
  refreshManagedAppVersion,
  invalidateManagedAppsCache,
  installApp,
  installAppHooks,
  openManagedDesktopApp,
  getProviderConfigPath,
  getConfigFormat,
  getDesktopVersion,
  findDesktopClientRecord,
  resolveHostHome,
  APP_CATEGORIES,
  getBinaryVersion
};
