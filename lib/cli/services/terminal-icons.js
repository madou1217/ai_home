'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  getProviderMeta,
  getProviderTerminalIconAsset,
  isKnownProvider,
  listProviderIds
} = require('../../provider-catalog');
const {
  detectTerminalIconStrategy,
  listTerminalIconStrategies
} = require('./terminal-icon-strategies');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WINDOWS_TERMINAL_FRAGMENT_DIR = ['Microsoft', 'Windows Terminal', 'Fragments', 'AI Home'];
const WINDOWS_TERMINAL_SETTINGS_DIR = ['Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState'];
const WINDOWS_TERMINAL_FRAGMENT_NAMESPACE = '{f65ddb7e-706b-4499-8a50-40313caf510a}';
const ITERM2_DYNAMIC_PROFILE_DIR = ['Library', 'Application Support', 'iTerm2', 'DynamicProfiles'];
const ITERM2_DYNAMIC_PROFILE_FILE = 'provider-icons.json';
const LINUX_ICON_SIZE_DIR = ['icons', 'hicolor', '256x256', 'apps'];
const LINUX_DESKTOP_ENTRY_DIR = ['applications'];
const KONSOLE_PROFILE_DIR = ['konsole'];
const WARP_AGENT_COMMAND_SECTION = 'agents.third_party.cli_agent_toolbar_enabled_commands';
const WARP_AGENT_NAME_BY_PROVIDER = Object.freeze({
  codex: 'Codex',
  claude: 'Claude',
  gemini: 'Gemini',
  agy: 'Gemini',
  opencode: 'OpenCode'
});

function looksLikeWindowsPath(value) {
  return /^[A-Za-z]:[\\/]/.test(String(value || '')) || String(value || '').includes('\\');
}

function joinPlatformPath(base, parts, pathImpl = path) {
  const targetPath = looksLikeWindowsPath(base) ? path.win32 : pathImpl;
  return targetPath.join(base, ...parts);
}

function dirnameForPath(value, pathImpl = path) {
  return looksLikeWindowsPath(value) ? path.win32.dirname(value) : pathImpl.dirname(value);
}

function normalizeProviderList(provider, options = {}) {
  if (options.all) return listProviderIds();
  const id = String(provider || '').trim().toLowerCase();
  return id ? [id] : [];
}

function normalizeKnownProviders(providers) {
  const seen = new Set();
  const ids = [];
  for (const provider of Array.isArray(providers) ? providers : []) {
    const id = String(provider || '').trim().toLowerCase();
    if (!id || seen.has(id) || !isKnownProvider(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function guidToBytes(guid) {
  const hex = String(guid || '').replace(/[{}-]/g, '').trim();
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`Invalid GUID: ${guid}`);
  return Buffer.from(hex, 'hex');
}

function formatGuid(bytes) {
  const hex = Buffer.from(bytes).toString('hex');
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`;
}

function uuidV5(namespaceGuid, name) {
  const namespaceBytes = guidToBytes(namespaceGuid);
  const nameBytes = Buffer.from(String(name || ''), 'utf16le');
  const bytes = crypto
    .createHash('sha1')
    .update(namespaceBytes)
    .update(nameBytes)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatGuid(bytes);
}

function stableGuidForProvider(provider) {
  const id = String(provider || '').trim().toLowerCase();
  const meta = getProviderMeta(id);
  const appNamespace = uuidV5(WINDOWS_TERMINAL_FRAGMENT_NAMESPACE, 'AI Home');
  return uuidV5(appNamespace, `AIH ${meta.label || id}`);
}

function normalizeGuid(value) {
  return String(value || '').trim().replace(/[{}]/g, '').toLowerCase();
}

function providerProfileName(provider) {
  const id = String(provider || '').trim().toLowerCase();
  const meta = getProviderMeta(id);
  return `AIH ${meta.label || id}`;
}

function providerIconName(provider) {
  const id = String(provider || '').trim().toLowerCase();
  return `aih-${id}`;
}

function resolveHomeDir(env = {}) {
  return String(env.HOME || env.USERPROFILE || '').trim();
}

function escapeDesktopValue(value) {
  return String(value || '').replace(/[\r\n]/g, ' ').trim();
}

function escapeTomlBasicString(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\u0008/g, '\\b')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\f/g, '\\f')
    .replace(/\r/g, '\\r');
}

function tomlBasicString(value) {
  return `"${escapeTomlBasicString(value)}"`;
}

function quoteDesktopExecArg(value) {
  const text = String(value || '');
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `"${text.replace(/["\\]/g, '\\$&')}"`;
}

function quoteWindowsCmdArg(value) {
  const text = String(value || '');
  if (/^[A-Za-z0-9_@%+=:,./\\:-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildWindowsTerminalCommandLine(provider, options = {}) {
  const id = String(provider || '').trim().toLowerCase();
  const inner = [options.aihCommand || 'aih', id].map(quoteWindowsCmdArg).join(' ');
  return `${options.cmdCommand || 'cmd.exe'} /d /s /c "${inner}"`;
}

function buildWindowsTerminalStartingDirectory(options = {}) {
  return String(options.startingDirectory || '%USERPROFILE%');
}

function writeFileSync(fsImpl, targetPath, content, encoding = 'utf8') {
  fsImpl.mkdirSync(dirnameForPath(targetPath), { recursive: true });
  fsImpl.writeFileSync(targetPath, content, encoding);
}

function copyFileSync(fsImpl, sourcePath, targetPath) {
  fsImpl.mkdirSync(dirnameForPath(targetPath), { recursive: true });
  if (typeof fsImpl.copyFileSync === 'function') {
    fsImpl.copyFileSync(sourcePath, targetPath);
    return;
  }
  fsImpl.writeFileSync(targetPath, fsImpl.readFileSync(sourcePath));
}

function isWindowsTerminalProviderProfileActive(provider, env = {}) {
  const expected = normalizeGuid(stableGuidForProvider(provider));
  const activeProfileId = normalizeGuid(env.WT_PROFILE_ID || env.WtProfileId || '');
  if (activeProfileId && activeProfileId === expected) return true;
  return String(env.AIH_WT_PROVIDER_PROFILE || '').trim().toLowerCase() === String(provider || '').trim().toLowerCase();
}

function resolveProviderTerminalIconPath(provider, options = {}) {
  const pathImpl = options.path || path;
  const asset = getProviderTerminalIconAsset(provider);
  return asset ? pathImpl.resolve(options.repoRoot || REPO_ROOT, asset) : '';
}

function buildWindowsTerminalProfile(provider, options = {}) {
  const id = String(provider || '').trim().toLowerCase();
  const iconPath = resolveProviderTerminalIconPath(id, options);
  return {
    guid: stableGuidForProvider(id),
    name: providerProfileName(id),
    commandline: buildWindowsTerminalCommandLine(id, options),
    startingDirectory: buildWindowsTerminalStartingDirectory(options),
    icon: iconPath,
    hidden: false
  };
}

function buildWindowsTerminalFragment(providers, options = {}) {
  const ids = normalizeKnownProviders(providers);
  return {
    profiles: ids.map((provider) => buildWindowsTerminalProfile(provider, options))
  };
}

function buildWindowsTerminalLaunchCommand(provider, providerArgs = [], options = {}) {
  const id = String(provider || '').trim().toLowerCase();
  if (!isKnownProvider(id)) {
    throw new Error(`Unknown provider: ${provider || 'unknown'}`);
  }
  const meta = getProviderMeta(id);
  const cwd = String(options.cwd || '').trim();
  const args = [
    '-w', String(options.windowId || '0'),
    'new-tab',
    '--profile', stableGuidForProvider(id),
    '--title', `AIH ${meta.short || meta.label || id}`
  ];
  if (cwd) args.push('--startingDirectory', cwd);
  args.push(String(options.aihCommand || 'aih'), id);
  for (const arg of Array.isArray(providerArgs) ? providerArgs : []) {
    args.push(String(arg));
  }
  return {
    command: options.wtCommand || 'wt.exe',
    args,
    env: {
      AIH_WT_PROVIDER_PROFILE: id
    }
  };
}

function resolveWindowsTerminalFragmentPath(options = {}) {
  const env = options.env || process.env;
  const pathImpl = options.path || path;
  const localAppData = String(env.LOCALAPPDATA || '').trim()
    || (String(env.USERPROFILE || '').trim() ? joinPlatformPath(String(env.USERPROFILE).trim(), ['AppData', 'Local'], pathImpl) : '');
  if (!localAppData) return '';
  return joinPlatformPath(localAppData, [...WINDOWS_TERMINAL_FRAGMENT_DIR, 'provider-icons.json'], pathImpl);
}

function resolveWindowsTerminalSettingsPath(options = {}) {
  if (options.settingsPath) return options.settingsPath;
  const env = options.env || process.env;
  const pathImpl = options.path || path;
  const localAppData = String(env.LOCALAPPDATA || '').trim()
    || (String(env.USERPROFILE || '').trim() ? joinPlatformPath(String(env.USERPROFILE).trim(), ['AppData', 'Local'], pathImpl) : '');
  if (!localAppData) return '';
  return joinPlatformPath(localAppData, [...WINDOWS_TERMINAL_SETTINGS_DIR, 'settings.json'], pathImpl);
}

function syncWindowsTerminalSettingsProfiles(providers, options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const settingsPath = resolveWindowsTerminalSettingsPath(options);
  if (!settingsPath) return { path: '', changed: false, profiles: [], skipped: 'missing-path' };
  let current = '';
  try {
    current = fsImpl.readFileSync(settingsPath, 'utf8');
  } catch (_error) {
    return { path: settingsPath, changed: false, profiles: [], skipped: 'missing-file' };
  }
  let settings;
  try {
    settings = JSON.parse(current);
  } catch (_error) {
    return { path: settingsPath, changed: false, profiles: [], skipped: 'parse-error' };
  }
  const list = settings && settings.profiles && Array.isArray(settings.profiles.list)
    ? settings.profiles.list
    : null;
  if (!list) return { path: settingsPath, changed: false, profiles: [], skipped: 'missing-profile-list' };

  const desiredByGuid = new Map(
    normalizeKnownProviders(providers)
      .map((provider) => {
        const profile = buildWindowsTerminalProfile(provider, options);
        return [normalizeGuid(profile.guid), profile];
      })
  );
  const updatedProfiles = [];
  let changed = false;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const desired = desiredByGuid.get(normalizeGuid(entry.guid));
    if (!desired) continue;
    let entryChanged = false;
    for (const key of ['commandline', 'icon', 'startingDirectory']) {
      if (entry[key] !== desired[key]) {
        entry[key] = desired[key];
        changed = true;
        entryChanged = true;
      }
    }
    if (entryChanged) updatedProfiles.push(desired.name);
  }
  if (changed) fsImpl.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 4)}\n`, 'utf8');
  return { path: settingsPath, changed, profiles: updatedProfiles };
}

function writeWindowsTerminalFragment(providers, options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const pathImpl = options.path || path;
  const targetPath = options.targetPath || resolveWindowsTerminalFragmentPath(options);
  if (!targetPath) {
    throw new Error('LOCALAPPDATA or USERPROFILE is required to locate Windows Terminal fragments.');
  }
  const fragment = buildWindowsTerminalFragment(providers, options);
  fsImpl.mkdirSync(dirnameForPath(targetPath, pathImpl), { recursive: true });
  fsImpl.writeFileSync(targetPath, `${JSON.stringify(fragment, null, 2)}\n`, 'utf8');
  const shouldSyncSettings = options.syncSettings === true
    || (options.syncSettings !== false && !options.targetPath);
  const settings = shouldSyncSettings
    ? syncWindowsTerminalSettingsProfiles(providers, options)
    : null;
  return { path: targetPath, fragment, settings };
}

function resolveIterm2DynamicProfilePath(options = {}) {
  if (options.targetPath) return options.targetPath;
  const env = options.env || process.env;
  const pathImpl = options.path || path;
  const home = resolveHomeDir(env);
  return home ? joinPlatformPath(home, [...ITERM2_DYNAMIC_PROFILE_DIR, ITERM2_DYNAMIC_PROFILE_FILE], pathImpl) : '';
}

function buildIterm2DynamicProfile(provider, options = {}) {
  const id = String(provider || '').trim().toLowerCase();
  return {
    Guid: normalizeGuid(stableGuidForProvider(id)),
    Name: providerProfileName(id),
    Tags: ['AIH'],
    'Custom Command': 'Yes',
    Command: `${options.aihCommand || 'aih'} ${id}`,
    Icon: 2,
    'Custom Icon Path': resolveProviderTerminalIconPath(id, options)
  };
}

function buildIterm2DynamicProfiles(providers, options = {}) {
  return {
    Profiles: normalizeKnownProviders(providers).map((provider) => buildIterm2DynamicProfile(provider, options))
  };
}

function writeIterm2DynamicProfiles(providers, options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const targetPath = resolveIterm2DynamicProfilePath(options);
  if (!targetPath) {
    throw new Error('HOME is required to locate iTerm2 DynamicProfiles.');
  }
  const profiles = buildIterm2DynamicProfiles(providers, options);
  writeFileSync(fsImpl, targetPath, `${JSON.stringify(profiles, null, 2)}\n`);
  return { path: targetPath, profiles };
}

function buildIterm2SetProfileSequence(provider) {
  return `\x1b]1337;SetProfile=${providerProfileName(provider)}\x07`;
}

function buildTerminalTitleSequence(title) {
  const cleanTitle = String(title || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return cleanTitle ? `\x1b]0;${cleanTitle}\x07` : '';
}

function isIterm2ProviderProfileActive(provider, env = {}) {
  const activeProfile = String(env.ITERM_PROFILE || '').trim();
  if (activeProfile && activeProfile === providerProfileName(provider)) return true;
  return String(env.AIH_ITERM_PROVIDER_PROFILE || '').trim().toLowerCase() === String(provider || '').trim().toLowerCase();
}

function resolveXdgDataHome(options = {}) {
  const env = options.env || process.env;
  const pathImpl = options.path || path;
  const explicit = String(env.XDG_DATA_HOME || '').trim();
  if (explicit) return explicit;
  const home = resolveHomeDir(env);
  return home ? joinPlatformPath(home, ['.local', 'share'], pathImpl) : '';
}

function resolveLinuxIconPath(provider, options = {}) {
  const pathImpl = options.path || path;
  const xdgDataHome = options.xdgDataHome || resolveXdgDataHome(options);
  return xdgDataHome ? joinPlatformPath(xdgDataHome, [...LINUX_ICON_SIZE_DIR, `${providerIconName(provider)}.png`], pathImpl) : '';
}

function resolveLinuxDesktopEntryPath(provider, options = {}) {
  const pathImpl = options.path || path;
  const xdgDataHome = options.xdgDataHome || resolveXdgDataHome(options);
  return xdgDataHome ? joinPlatformPath(xdgDataHome, [...LINUX_DESKTOP_ENTRY_DIR, `${providerIconName(provider)}.desktop`], pathImpl) : '';
}

function resolveKonsoleProfilePath(provider, options = {}) {
  const pathImpl = options.path || path;
  const xdgDataHome = options.xdgDataHome || resolveXdgDataHome(options);
  return xdgDataHome ? joinPlatformPath(xdgDataHome, [...KONSOLE_PROFILE_DIR, `${providerIconName(provider)}.profile`], pathImpl) : '';
}

function buildLinuxDesktopEntry(provider, options = {}) {
  const id = String(provider || '').trim().toLowerCase();
  const name = providerProfileName(id);
  const exec = [options.aihCommand || 'aih', id].map(quoteDesktopExecArg).join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${escapeDesktopValue(name)}`,
    `Comment=${escapeDesktopValue(`Open ${name} in a terminal`)}`,
    `Exec=${exec}`,
    `Icon=${providerIconName(id)}`,
    'Terminal=true',
    'Categories=Development;Utility;',
    'StartupNotify=false',
    ''
  ].join('\n');
}

function buildKonsoleProfile(provider, options = {}) {
  const id = String(provider || '').trim().toLowerCase();
  return [
    '[General]',
    `Name=${escapeDesktopValue(providerProfileName(id))}`,
    `Icon=${providerIconName(id)}`,
    `Command=${escapeDesktopValue(options.aihCommand || 'aih')}`,
    `Arguments=${escapeDesktopValue(id)}`,
    ''
  ].join('\n');
}

function writeLinuxTerminalIconFiles(providers, options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const xdgDataHome = options.xdgDataHome || resolveXdgDataHome(options);
  if (!xdgDataHome) {
    throw new Error('HOME or XDG_DATA_HOME is required to locate Linux terminal icon files.');
  }
  const results = [];
  for (const provider of normalizeKnownProviders(providers)) {
    const iconPath = resolveLinuxIconPath(provider, { ...options, xdgDataHome });
    const desktopEntryPath = resolveLinuxDesktopEntryPath(provider, { ...options, xdgDataHome });
    const konsoleProfilePath = resolveKonsoleProfilePath(provider, { ...options, xdgDataHome });
    copyFileSync(fsImpl, resolveProviderTerminalIconPath(provider, options), iconPath);
    writeFileSync(fsImpl, desktopEntryPath, buildLinuxDesktopEntry(provider, options));
    writeFileSync(fsImpl, konsoleProfilePath, buildKonsoleProfile(provider, options));
    results.push({ provider, iconPath, desktopEntryPath, konsoleProfilePath });
  }
  return { xdgDataHome, entries: results };
}

function resolveWarpSettingsPath(options = {}) {
  if (options.targetPath) return options.targetPath;
  const env = options.env || process.env;
  const pathImpl = options.path || path;
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    const localAppData = String(env.LOCALAPPDATA || '').trim()
      || (String(env.USERPROFILE || '').trim() ? joinPlatformPath(String(env.USERPROFILE).trim(), ['AppData', 'Local'], pathImpl) : '');
    return localAppData ? joinPlatformPath(localAppData, ['warp', 'Warp', 'config', 'settings.toml'], pathImpl) : '';
  }
  if (platform === 'linux') {
    const configHome = String(env.XDG_CONFIG_HOME || '').trim()
      || (String(env.HOME || '').trim() ? joinPlatformPath(String(env.HOME).trim(), ['.config'], pathImpl) : '');
    return configHome ? joinPlatformPath(configHome, ['warp-terminal', 'settings.toml'], pathImpl) : '';
  }
  const home = resolveHomeDir(env);
  return home ? joinPlatformPath(home, ['.warp', 'settings.toml'], pathImpl) : '';
}

function warpAgentNameForProvider(provider) {
  return WARP_AGENT_NAME_BY_PROVIDER[String(provider || '').trim().toLowerCase()] || '';
}

function buildWarpAgentCommandPattern(provider, options = {}) {
  const id = String(provider || '').trim().toLowerCase();
  const aihCommand = String(options.aihCommand || 'aih').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${aihCommand}\\s+${id}(?:\\s|$).*`;
}

function buildWarpAgentCommandEntries(providers, options = {}) {
  const entries = [];
  for (const provider of normalizeKnownProviders(providers)) {
    const agentName = warpAgentNameForProvider(provider);
    if (!agentName) continue;
    entries.push({
      provider,
      pattern: buildWarpAgentCommandPattern(provider, options),
      agentName
    });
  }
  return entries;
}

function listWarpAgentCommandProviders() {
  return listProviderIds().filter((provider) => Boolean(warpAgentNameForProvider(provider)));
}

function resolveWarpAgentCommandProviders(providers) {
  const requested = normalizeKnownProviders(providers).filter((provider) => Boolean(warpAgentNameForProvider(provider)));
  return requested.length > 0 ? listWarpAgentCommandProviders() : [];
}

function parseTomlKeyLine(line) {
  const text = String(line || '').trim();
  const match = text.match(/^("[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=/);
  if (!match) return '';
  const raw = match[1];
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1)
      .replace(/\\b/g, '\b')
      .replace(/\\t/g, '\t')
      .replace(/\\n/g, '\n')
      .replace(/\\f/g, '\f')
      .replace(/\\r/g, '\r')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}

function findTomlSectionRange(lines, sectionName) {
  const headerPattern = /^\s*\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?$/;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const match = String(lines[i] || '').match(headerPattern);
    if (!match) continue;
    if (match[1] === sectionName) {
      start = i;
      break;
    }
  }
  if (start < 0) return { start: -1, end: -1 };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (headerPattern.test(String(lines[i] || ''))) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function updateWarpSettingsContent(content, entries) {
  const items = Array.isArray(entries) ? entries : [];
  if (items.length === 0) return String(content || '');
  const entryKeys = new Set(items.map((entry) => entry.pattern));
  const entryLines = items.map((entry) => `${tomlBasicString(entry.pattern)} = ${tomlBasicString(entry.agentName)}`);
  const normalized = String(content || '').replace(/\r\n/g, '\n');
  const lines = normalized ? normalized.split('\n') : [];
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const range = findTomlSectionRange(lines, WARP_AGENT_COMMAND_SECTION);

  if (range.start < 0) {
    const next = lines.slice();
    if (next.length > 0 && String(next[next.length - 1]).trim()) next.push('');
    next.push(`[${WARP_AGENT_COMMAND_SECTION}]`, ...entryLines);
    return `${next.join('\n')}\n`;
  }

  const sectionBody = lines
    .slice(range.start + 1, range.end)
    .filter((line) => !entryKeys.has(parseTomlKeyLine(line)));
  const next = [
    ...lines.slice(0, range.start + 1),
    ...sectionBody,
    ...entryLines,
    ...lines.slice(range.end)
  ];
  return `${next.join('\n')}\n`;
}

function writeWarpAgentCommandSettings(providers, options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const targetPath = resolveWarpSettingsPath(options);
  if (!targetPath) {
    throw new Error('HOME, XDG_CONFIG_HOME, LOCALAPPDATA, or USERPROFILE is required to locate Warp settings.');
  }
  const entries = buildWarpAgentCommandEntries(providers, options);
  if (entries.length === 0) {
    throw new Error('No Warp-supported providers selected.');
  }
  let current = '';
  try { current = fsImpl.readFileSync(targetPath, 'utf8'); } catch (_error) { current = ''; }
  const next = updateWarpSettingsContent(current, entries);
  const changed = next !== current;
  if (changed) writeFileSync(fsImpl, targetPath, next, 'utf8');
  return { path: targetPath, entries, changed };
}

function isTerminalIconAutoEnabled(env = {}, terminalKey = '') {
  if (String(env.AIH_TERMINAL_ICON_AUTO || '1').trim() === '0') return false;
  if (terminalKey && String(env[terminalKey] || '1').trim() === '0') return false;
  return true;
}

function activateIterm2ProviderProfile(provider, options = {}) {
  const processImpl = options.processImpl || process;
  const env = processImpl.env || {};
  if (!isTerminalIconAutoEnabled(env, 'AIH_ITERM_PROVIDER_ICON_AUTO')) return false;
  if (processImpl.platform !== 'darwin') return false;
  if (String(env.TERM_PROGRAM || '').trim() !== 'iTerm.app' && !env.ITERM_SESSION_ID) return false;
  if (isIterm2ProviderProfileActive(provider, env)) return false;
  if (!processImpl.stdout || !processImpl.stdout.isTTY || typeof processImpl.stdout.write !== 'function') return false;
  try {
    writeIterm2DynamicProfiles([provider], { ...options, env });
    processImpl.stdout.write(buildIterm2SetProfileSequence(provider));
    env.AIH_ITERM_PROVIDER_PROFILE = String(provider || '').trim().toLowerCase();
    return true;
  } catch (_error) {
    return false;
  }
}

function buildKonsoleSetProfileCommand(provider, options = {}) {
  const env = options.env || process.env;
  const service = String(env.KONSOLE_DBUS_SERVICE || '').trim();
  const session = String(env.KONSOLE_DBUS_SESSION || '').trim();
  if (!service || !session) return null;
  return {
    command: options.qdbusCommand || 'qdbus',
    args: [service, session, 'org.kde.konsole.Session.setProfile', providerProfileName(provider)]
  };
}

function activateKonsoleProviderProfile(provider, options = {}) {
  const processImpl = options.processImpl || process;
  const env = processImpl.env || {};
  if (!isTerminalIconAutoEnabled(env, 'AIH_KONSOLE_PROVIDER_ICON_AUTO')) return false;
  if (processImpl.platform !== 'linux') return false;
  if (!env.KONSOLE_DBUS_SERVICE || !env.KONSOLE_DBUS_SESSION) return false;
  if (!processImpl.stdout || !processImpl.stdout.isTTY) return false;
  const spawnSyncImpl = options.spawnSync || require('node:child_process').spawnSync;
  try {
    writeLinuxTerminalIconFiles([provider], { ...options, env });
    const primary = buildKonsoleSetProfileCommand(provider, {
      env,
      qdbusCommand: options.qdbusCommand
    });
    const commands = [
      primary,
      options.qdbusCommand ? null : buildKonsoleSetProfileCommand(provider, { env, qdbusCommand: 'qdbus6' })
    ].filter(Boolean);
    for (const command of commands) {
      const result = spawnSyncImpl(command.command, command.args, { stdio: 'ignore' });
      if (result && result.error) continue;
      if (result && Number.isInteger(result.status) && result.status !== 0) continue;
      env.AIH_KONSOLE_PROVIDER_PROFILE = String(provider || '').trim().toLowerCase();
      return true;
    }
  } catch (_error) {
    return false;
  }
  return false;
}

function activateWarpAgentCommandMapping(provider, options = {}) {
  const processImpl = options.processImpl || process;
  const env = options.env || processImpl.env || {};
  if (!isTerminalIconAutoEnabled(env, 'AIH_WARP_PROVIDER_ICON_AUTO')) return false;
  if (buildWarpAgentCommandEntries([provider], options).length === 0) return false;
  try {
    writeWarpAgentCommandSettings(resolveWarpAgentCommandProviders([provider]), {
      ...options,
      env,
      platform: processImpl.platform
    });
    env.AIH_WARP_PROVIDER_ICON = String(provider || '').trim().toLowerCase();
    return true;
  } catch (_error) {
    return false;
  }
}

function buildProviderTerminalTitle(provider) {
  const meta = getProviderMeta(provider);
  const icon = String(meta.terminalIcon || '').trim();
  const label = String(meta.short || meta.label || provider || 'AI').trim();
  return `${icon ? `${icon} ` : ''}AIH ${label}`.trim();
}

function activateTitleProviderBadge(provider, strategy, options = {}) {
  const processImpl = options.processImpl || process;
  const env = processImpl.env || {};
  if (!strategy || !strategy.titleFallback) return false;
  if (!isTerminalIconAutoEnabled(env, 'AIH_TERMINAL_TITLE_AUTO')) return false;
  if (!processImpl.stdout || !processImpl.stdout.isTTY || typeof processImpl.stdout.write !== 'function') return false;
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (!normalizedProvider || String(env.AIH_TERMINAL_PROVIDER_TITLE || '').trim().toLowerCase() === normalizedProvider) return false;
  const sequence = buildTerminalTitleSequence(buildProviderTerminalTitle(normalizedProvider));
  if (!sequence) return false;
  try {
    processImpl.stdout.write(sequence);
    env.AIH_TERMINAL_PROVIDER_TITLE = normalizedProvider;
    return true;
  } catch (_error) {
    return false;
  }
}

function prepareCurrentTerminalProviderIcon(provider, options = {}) {
  const processImpl = options.processImpl || process;
  const env = options.env || processImpl.env || {};
  const strategy = detectTerminalIconStrategy({
    env,
    platform: processImpl.platform,
    terminal: options.terminal
  });
  const terminal = strategy && strategy.id || '';
  if (terminal === 'warp' && activateWarpAgentCommandMapping(provider, { ...options, processImpl })) return { applied: true, terminal };
  if (terminal === 'iterm2' && activateIterm2ProviderProfile(provider, options)) return { applied: true, terminal };
  if (terminal === 'konsole' && activateKonsoleProviderProfile(provider, options)) return { applied: true, terminal };
  if (terminal === 'windows-terminal' && isWindowsTerminalProviderProfileActive(provider, env)) return { applied: true, terminal };
  if (activateTitleProviderBadge(provider, strategy, { ...options, processImpl })) return { applied: true, terminal };
  return { applied: false, terminal };
}

function parseTerminalIconArgs(rawArgs = []) {
  const options = {
    all: false,
    json: false,
    install: false,
    printFragment: false,
    installWindowsTerminal: false,
    printIterm2DynamicProfile: false,
    installIterm2: false,
    installLinux: false,
    help: false
  };
  const unknown = [];
  for (const arg of rawArgs) {
    const token = String(arg || '').trim();
    if (!token) continue;
    if (token === '--all') options.all = true;
    else if (token === '--json') options.json = true;
    else if (token === '--install') options.install = true;
    else if (token === '--windows-terminal-fragment') options.printFragment = true;
    else if (token === '--install-windows-terminal') options.installWindowsTerminal = true;
    else if (token === '--iterm2-dynamic-profile') options.printIterm2DynamicProfile = true;
    else if (token === '--install-iterm2') options.installIterm2 = true;
    else if (token === '--install-linux') options.installLinux = true;
    else if (token === '--help' || token === '-h' || token === 'help') options.help = true;
    else unknown.push(token);
  }
  return { options, unknown };
}

function printTerminalIconHelp(log, provider) {
  log(`
Usage:
  aih ${provider} terminal-icon
  aih ${provider} terminal-icon --install [--all]
  aih ${provider} terminal-icon --windows-terminal-fragment [--all]
  aih ${provider} terminal-icon --install-windows-terminal [--all]
  aih ${provider} terminal-icon --iterm2-dynamic-profile [--all]
  aih ${provider} terminal-icon --install-iterm2 [--all]
  aih ${provider} terminal-icon --install-linux [--all]

Notes:
  Real graphical tab/window icons are terminal profile settings, not OSC title text.
  Windows Terminal uses profile icons; iTerm2 uses Dynamic Profiles; Konsole uses
  profiles over DBus. Warp is detected and repaired automatically through its
  CLI-agent command mapping in settings.toml.
  Apple Terminal, GNOME Terminal, kitty, WezTerm, Alacritty, Ghostty, VS Code
  terminals, and legacy console hosts receive a title badge fallback because
  they do not expose a portable runtime tab icon API.
`);
}

function installCurrentPlatformIcons(providers, options = {}) {
  const platform = options.platform || (options.processImpl && options.processImpl.platform) || process.platform;
  const env = options.env || (options.processImpl && options.processImpl.env) || process.env;
  const strategy = detectTerminalIconStrategy({
    env,
    platform,
    terminal: options.terminal
  });
  if (strategy && strategy.id === 'warp') {
    return {
      type: 'warp',
      result: writeWarpAgentCommandSettings(
        resolveWarpAgentCommandProviders(providers),
        { ...options, env, platform }
      )
    };
  }
  if (platform === 'win32') return { type: 'windows-terminal', result: writeWindowsTerminalFragment(providers, options) };
  if (platform === 'darwin') return { type: 'iterm2', result: writeIterm2DynamicProfiles(providers, options) };
  if (platform === 'linux') return { type: 'linux', result: writeLinuxTerminalIconFiles(providers, options) };
  throw new Error(`Unsupported platform for automatic terminal icon install: ${platform || 'unknown'}`);
}

function logInstallResult(consoleImpl, installResult) {
  if (installResult.type === 'windows-terminal') {
    consoleImpl.log(`\x1b[36m[aih]\x1b[0m Windows Terminal provider icon profiles written: ${installResult.result.path}`);
    consoleImpl.log('\x1b[90mOpen a new Windows Terminal tab with an AIH profile to see the provider icon.\x1b[0m');
    return;
  }
  if (installResult.type === 'iterm2') {
    consoleImpl.log(`\x1b[36m[aih]\x1b[0m iTerm2 provider icon dynamic profiles written: ${installResult.result.path}`);
    consoleImpl.log('\x1b[90mSwitch to an AIH iTerm2 profile, or run aih from iTerm2 and AIH will switch the session profile automatically.\x1b[0m');
    return;
  }
  if (installResult.type === 'warp') {
    consoleImpl.log(`\x1b[36m[aih]\x1b[0m Warp CLI-agent command mappings written: ${installResult.result.path}`);
    consoleImpl.log('\x1b[90mOpen a new Warp tab after settings reload; aih provider commands will be classified as their native CLI agents.\x1b[0m');
    return;
  }
  if (installResult.type === 'linux') {
    consoleImpl.log(`\x1b[36m[aih]\x1b[0m Linux terminal provider icons written under: ${installResult.result.xdgDataHome}`);
    consoleImpl.log('\x1b[90mThis installs XDG app icons/desktop entries and Konsole profiles using real provider PNG icons.\x1b[0m');
  }
}

function runTerminalIconCommand(provider, rawArgs = [], context = {}) {
  const consoleImpl = context.consoleImpl || console;
  const processImpl = context.processImpl || process;
  const { options, unknown } = parseTerminalIconArgs(rawArgs);
  if (options.help) {
    printTerminalIconHelp(consoleImpl.log.bind(consoleImpl), provider);
    return 0;
  }
  if (unknown.length > 0) {
    consoleImpl.error(`\x1b[31m[aih] Unknown terminal-icon arg: ${unknown[0]}\x1b[0m`);
    return 1;
  }

  const providers = normalizeProviderList(provider, options);
  const missing = providers.filter((item) => !isKnownProvider(item));
  if (missing.length > 0 || providers.length === 0) {
    consoleImpl.error(`\x1b[31m[aih] Unknown provider: ${missing[0] || provider || 'unknown'}\x1b[0m`);
    return 1;
  }

  const env = context.env || processImpl.env || {};
  const serviceOptions = {
    fs: context.fs,
    path: context.path || path,
    env,
    processImpl,
    repoRoot: context.repoRoot,
    aihCommand: context.aihCommand,
    platform: processImpl.platform
  };
  if (options.install) {
    try {
      const result = installCurrentPlatformIcons(providers, serviceOptions);
      if (options.json) {
        consoleImpl.log(JSON.stringify({ ok: true, install: result }, null, 2));
      } else {
        logInstallResult(consoleImpl, result);
      }
      return 0;
    } catch (error) {
      consoleImpl.error(`\x1b[31m[aih] failed to install provider terminal icons: ${error.message}\x1b[0m`);
      return 1;
    }
  }
  if (options.installWindowsTerminal) {
    try {
      const result = { type: 'windows-terminal', result: writeWindowsTerminalFragment(providers, serviceOptions) };
      if (options.json) {
        consoleImpl.log(JSON.stringify({ ok: true, path: result.result.path, fragment: result.result.fragment }, null, 2));
      } else {
        logInstallResult(consoleImpl, result);
      }
      return 0;
    } catch (error) {
      consoleImpl.error(`\x1b[31m[aih] failed to install Windows Terminal provider icons: ${error.message}\x1b[0m`);
      return 1;
    }
  }
  if (options.installIterm2) {
    try {
      const result = { type: 'iterm2', result: writeIterm2DynamicProfiles(providers, serviceOptions) };
      if (options.json) {
        consoleImpl.log(JSON.stringify({ ok: true, path: result.result.path, profiles: result.result.profiles }, null, 2));
      } else {
        logInstallResult(consoleImpl, result);
      }
      return 0;
    } catch (error) {
      consoleImpl.error(`\x1b[31m[aih] failed to install iTerm2 provider icons: ${error.message}\x1b[0m`);
      return 1;
    }
  }
  if (options.installLinux) {
    try {
      const result = { type: 'linux', result: writeLinuxTerminalIconFiles(providers, serviceOptions) };
      if (options.json) {
        consoleImpl.log(JSON.stringify({ ok: true, linux: result.result }, null, 2));
      } else {
        logInstallResult(consoleImpl, result);
      }
      return 0;
    } catch (error) {
      consoleImpl.error(`\x1b[31m[aih] failed to install Linux provider icons: ${error.message}\x1b[0m`);
      return 1;
    }
  }
  if (options.printIterm2DynamicProfile) {
    consoleImpl.log(JSON.stringify(buildIterm2DynamicProfiles(providers, serviceOptions), null, 2));
    return 0;
  }
  const fragment = buildWindowsTerminalFragment(providers, serviceOptions);
  if (options.json || options.printFragment) {
    consoleImpl.log(JSON.stringify(fragment, null, 2));
    return 0;
  }

  providers.forEach((item) => {
    const meta = getProviderMeta(item);
    consoleImpl.log(`${meta.label}: ${resolveProviderTerminalIconPath(item, serviceOptions)}`);
  });
  consoleImpl.log('\x1b[90mRun with --install for this OS, or use --install-windows-terminal / --install-iterm2 / --install-linux explicitly.\x1b[0m');
  return 0;
}

module.exports = {
  stableGuidForProvider,
  isWindowsTerminalProviderProfileActive,
  isIterm2ProviderProfileActive,
  resolveProviderTerminalIconPath,
  buildWindowsTerminalCommandLine,
  buildWindowsTerminalStartingDirectory,
  buildWindowsTerminalProfile,
  buildWindowsTerminalFragment,
  buildWindowsTerminalLaunchCommand,
  resolveWindowsTerminalFragmentPath,
  resolveWindowsTerminalSettingsPath,
  syncWindowsTerminalSettingsProfiles,
  writeWindowsTerminalFragment,
  resolveIterm2DynamicProfilePath,
  buildIterm2DynamicProfile,
  buildIterm2DynamicProfiles,
  writeIterm2DynamicProfiles,
  buildIterm2SetProfileSequence,
  buildTerminalTitleSequence,
  buildProviderTerminalTitle,
  resolveXdgDataHome,
  resolveLinuxIconPath,
  resolveLinuxDesktopEntryPath,
  resolveKonsoleProfilePath,
  buildLinuxDesktopEntry,
  buildKonsoleProfile,
  writeLinuxTerminalIconFiles,
  buildKonsoleSetProfileCommand,
  resolveWarpSettingsPath,
  buildWarpAgentCommandEntries,
  updateWarpSettingsContent,
  writeWarpAgentCommandSettings,
  detectTerminalIconStrategy,
  listTerminalIconStrategies,
  prepareCurrentTerminalProviderIcon,
  parseTerminalIconArgs,
  uuidV5,
  runTerminalIconCommand
};
