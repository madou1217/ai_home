'use strict';

const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { spawnSync: systemSpawnSync } = require('node:child_process');
const { resolvePlatformPath } = require('../../../runtime/platform-path');
const { resolveHostHomeDir } = require('../../../runtime/host-home');

const DEFAULT_DISCOVERY_TIMEOUT_MS = 3000;
const DEFAULT_DISCOVERY_MAX_BUFFER = 4 * 1024 * 1024;
const DEFAULT_MANAGED_ROLES = Object.freeze(['frpc', 'frps', 'cloudflared']);
const COMMAND_WRAPPERS = new Set([
  'cmd',
  'daemonize',
  'doas',
  'env',
  'nohup',
  'nssm',
  'powershell',
  'pwsh',
  'setsid',
  'sh',
  'bash',
  'dash',
  'start-stop-daemon',
  'sudo',
  'winsw',
  'zsh'
]);

function resolvePlatform(options = {}) {
  const processObj = options.processObj || process;
  return String(options.platform || processObj.platform || process.platform).trim().toLowerCase();
}

function resolveEnv(options = {}) {
  const processObj = options.processObj || process;
  return options.env || processObj.env || process.env || {};
}

function resolvePathApi(options = {}) {
  return resolvePlatformPath(resolvePlatform(options), options.path || nodePath);
}

function resolveHome(options = {}) {
  if (String(options.hostHomeDir || '').trim()) return String(options.hostHomeDir).trim();
  try {
    return resolveHostHomeDir({
      env: resolveEnv(options),
      platform: resolvePlatform(options),
      os: options.os || nodeOs
    });
  } catch (_error) {
    const env = resolveEnv(options);
    return String(env.USERPROFILE || env.HOME || '').trim();
  }
}

function unique(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function fileExists(fsImpl, targetPath) {
  if (!targetPath) return false;
  try {
    return fsImpl.existsSync(targetPath) && (!fsImpl.statSync || fsImpl.statSync(targetPath).isFile());
  } catch (_error) {
    return false;
  }
}

function tokenizeCommandLine(value) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(value || '')))) {
    tokens.push(String(match[1] ?? match[2] ?? match[3] ?? '').trim());
  }
  return tokens.filter(Boolean);
}

function entryArguments(entry) {
  if (Array.isArray(entry && entry.args)) return entry.args.map((value) => String(value || '').trim()).filter(Boolean);
  if (Array.isArray(entry && entry.arguments)) return entry.arguments.map((value) => String(value || '').trim()).filter(Boolean);
  return tokenizeCommandLine(entry && (entry.commandLine || entry.command || entry.pathName || ''));
}

function entryExecutable(entry) {
  const args = entryArguments(entry);
  return String(entry && (entry.executablePath || entry.execute || entry.program || '') || args[0] || '').trim();
}

function normalizeExecutableName(value, pathImpl) {
  const basename = pathImpl.basename(String(value || '').replace(/^@/, '').trim());
  return basename.replace(/\.exe$/i, '').toLowerCase();
}

function nestedWrapperArguments(args, pathImpl) {
  if (args.length === 0) return [];
  const wrapper = normalizeExecutableName(args[0], pathImpl);
  if (!COMMAND_WRAPPERS.has(wrapper)) return [];
  const nested = [];
  for (const arg of args.slice(1)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
    nested.push(arg);
    if (/\s/.test(arg)) nested.push(...tokenizeCommandLine(arg));
  }
  return nested;
}

function entryExecutableForRole(entry, role, pathImpl) {
  const normalizedRole = String(role || '').trim().toLowerCase();
  if (!normalizedRole) return '';
  const explicit = entryExecutable(entry);
  const explicitName = normalizeExecutableName(explicit, pathImpl);
  if (explicitName === normalizedRole) return explicit;
  if (!COMMAND_WRAPPERS.has(explicitName)) return '';

  const args = entryArguments(entry);
  const candidates = nestedWrapperArguments([explicit, ...args], pathImpl);
  return candidates.find((value) => normalizeExecutableName(value, pathImpl) === normalizedRole) || '';
}

function entryArgumentsForRole(entry, role, pathImpl) {
  const args = entryArguments(entry);
  const explicit = entryExecutable(entry);
  const directExecutable = normalizeExecutableName(explicit, pathImpl);
  if (directExecutable === String(role || '').trim().toLowerCase()) return args;
  const wrapperArgs = COMMAND_WRAPPERS.has(directExecutable) ? [explicit, ...args] : args;
  const nested = nestedWrapperArguments(wrapperArgs, pathImpl);
  const roleIndex = nested.findIndex((value) => (
    normalizeExecutableName(value, pathImpl) === String(role || '').trim().toLowerCase()
  ));
  return roleIndex >= 0 ? nested.slice(roleIndex + 1) : args;
}

function entryMatchesRole(entry, role, pathImpl) {
  if (entryExecutableForRole(entry, role, pathImpl)) return true;
  const normalizedRole = String(role || '').trim().toLowerCase();
  const serviceName = String(entry && (entry.name || entry.taskName || entry.label || '') || '')
    .trim()
    .toLowerCase()
    .replace(/\.service$/, '');
  return serviceName === normalizedRole
    || serviceName.startsWith(`${normalizedRole}-`)
    || serviceName.startsWith(`${normalizedRole}_`);
}

function entryDirectlyRunsRole(entry, role, pathImpl) {
  return normalizeExecutableName(entryExecutable(entry), pathImpl) === String(role || '').trim().toLowerCase();
}

function envValue(env, name) {
  const wanted = String(name || '').toLowerCase();
  const key = Object.keys(env || {}).find((candidate) => candidate.toLowerCase() === wanted);
  return key ? String(env[key] || '') : '';
}

function expandWindowsEnvironment(value, options = {}) {
  if (resolvePlatform(options) !== 'win32') return String(value || '');
  const env = resolveEnv(options);
  return String(value || '')
    .replace(/%([^%]+)%/g, (match, name) => envValue(env, name) || match)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (match, name) => envValue(env, name) || match);
}

function resolveEntryBase(entry, options = {}) {
  const pathImpl = resolvePathApi(options);
  const rawBase = entry && (entry.cwd || entry.workingDirectory || entry.workDir || '');
  const base = expandWindowsEnvironment(rawBase, options).trim();
  return base && pathImpl.isAbsolute(base) ? pathImpl.normalize(base) : '';
}

function resolveCandidatePath(value, entry, options = {}) {
  const pathImpl = resolvePathApi(options);
  const expanded = expandWindowsEnvironment(value, options);
  const candidate = expanded.trim().replace(/^['"]|['"]$/g, '');
  if (!candidate) return '';
  if (pathImpl.isAbsolute(candidate)) return pathImpl.normalize(candidate);
  const base = resolveEntryBase(entry, options);
  return base ? pathImpl.normalize(pathImpl.resolve(base, candidate)) : '';
}

function normalizeRows(value) {
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

function runCommand(command, args, options = {}) {
  const spawnSync = options.spawnSync || systemSpawnSync;
  const configuredTimeout = Number(options.discoveryTimeoutMs);
  const configuredMaxBuffer = Number(options.discoveryMaxBuffer);
  const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_DISCOVERY_TIMEOUT_MS;
  const maxBuffer = Number.isFinite(configuredMaxBuffer) && configuredMaxBuffer > 0
    ? configuredMaxBuffer
    : DEFAULT_DISCOVERY_MAX_BUFFER;
  try {
    return spawnSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      env: resolveEnv(options),
      timeout,
      maxBuffer
    });
  } catch (_error) {
    return null;
  }
}

function managedRoles(options = {}) {
  return unique(options.managedRoles || DEFAULT_MANAGED_ROLES).map((role) => role.toLowerCase());
}

function parseUnixProcessOutput(output) {
  return String(output || '').split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) return null;
    return {
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      commandLine: match[3].trim()
    };
  }).filter(Boolean);
}

function resolveProcessCwd(pid, options = {}) {
  const numericPid = Number(pid || 0);
  if (!numericPid) return '';
  const platform = resolvePlatform(options);
  const fsImpl = options.fs || nodeFs;
  if (platform === 'linux') {
    try {
      return String(fsImpl.readlinkSync(`/proc/${numericPid}/cwd`) || '').trim();
    } catch (_error) {
      return '';
    }
  }
  if (platform === 'darwin') {
    const result = runCommand('lsof', ['-a', '-p', String(numericPid), '-d', 'cwd', '-Fn'], options);
    const match = String(result && result.status === 0 ? result.stdout : '').match(/^n(.+)$/m);
    return match ? match[1].trim() : '';
  }
  return '';
}

function readProcessEntries(options = {}) {
  if (Array.isArray(options.processEntries)) return options.processEntries;
  if (typeof options.listProcessEntries === 'function') {
    try { return normalizeRows(options.listProcessEntries(options)); } catch (_error) { return []; }
  }

  if (resolvePlatform(options) === 'win32') {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
    const result = runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], options);
    return normalizeRows(result && result.status === 0 ? result.stdout : '').map((row) => ({
      pid: Number(row.ProcessId || row.processId || 0),
      parentPid: Number(row.ParentProcessId || row.parentProcessId || 0),
      name: row.Name || row.name || '',
      executablePath: row.ExecutablePath || row.executablePath || '',
      commandLine: row.CommandLine || row.commandLine || ''
    }));
  }

  const result = runCommand('ps', ['-ww', '-axo', 'pid=,ppid=,command='], options);
  const pathImpl = resolvePathApi(options);
  const roles = managedRoles(options);
  return parseUnixProcessOutput(result && result.status === 0 ? result.stdout : '').map((entry) => {
    if (!roles.some((role) => entryMatchesRole(entry, role, pathImpl))) return entry;
    return { ...entry, cwd: resolveProcessCwd(entry.pid, options) };
  });
}

function parseSystemdUnit(name, content, enabled = false) {
  const entries = [];
  const normalizedContent = String(content || '').replace(/\\\r?\n\s*/g, ' ');
  const workingDirectory = normalizedContent.match(/^\s*WorkingDirectory\s*=\s*(.+)$/m);
  for (const match of normalizedContent.matchAll(/^\s*ExecStart\s*=\s*(.+)$/gm)) {
    const commandLine = String(match[1] || '').trim().replace(/^[-@:+!]+/, '').trim();
    if (!commandLine) continue;
    entries.push({
      source: 'systemd',
      name,
      commandLine,
      workingDirectory: workingDirectory ? workingDirectory[1].trim() : '',
      enabled
    });
  }
  return entries;
}

function listFiles(fsImpl, directory, suffix, options = {}, depth = 0) {
  try {
    const pathImpl = resolvePathApi(options);
    const files = [];
    for (const entry of fsImpl.readdirSync(directory, { withFileTypes: true })) {
      const target = pathImpl.join(directory, entry.name);
      if (entry.isFile() || entry.isSymbolicLink()) {
        if (!suffix || target.toLowerCase().endsWith(suffix)) files.push(target);
      } else if (entry.isDirectory() && depth < 2) {
        files.push(...listFiles(fsImpl, target, suffix, options, depth + 1));
      }
    }
    return files;
  } catch (_error) {
    return [];
  }
}

function executablePattern(options = {}) {
  const alternatives = managedRoles(options)
    .map((role) => role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return alternatives ? new RegExp(`\\b(?:${alternatives})(?:\\.exe)?\\b`, 'i') : /$a/;
}

function splitSearchPath(value, fallback = '') {
  return String(value || fallback || '')
    .split(':')
    .map((item) => item.trim())
    .filter(Boolean);
}

function systemdServiceDirectories(options = {}) {
  const env = resolveEnv(options);
  const home = resolveHome(options);
  const pathImpl = resolvePathApi(options);
  const configHome = String(env.XDG_CONFIG_HOME || '').trim()
    || (home ? pathImpl.join(home, '.config') : '');
  const dataHome = String(env.XDG_DATA_HOME || '').trim()
    || (home ? pathImpl.join(home, '.local', 'share') : '');
  const runtimeDir = String(env.XDG_RUNTIME_DIR || '').trim();
  const userRoots = [
    configHome,
    ...splitSearchPath(env.XDG_CONFIG_DIRS, '/etc/xdg'),
    runtimeDir,
    dataHome,
    ...splitSearchPath(env.XDG_DATA_DIRS, '/usr/local/share:/usr/share')
  ].filter(Boolean).map((root) => pathImpl.join(root, 'systemd', 'user'));

  return unique([
    '/etc/systemd/system',
    '/run/systemd/system',
    '/usr/local/lib/systemd/system',
    '/usr/lib/systemd/system',
    '/lib/systemd/system',
    ...userRoots,
    '/etc/systemd/user',
    '/usr/local/lib/systemd/user',
    '/usr/lib/systemd/user'
  ]);
}

function readSystemctlEntries(rolePattern, options = {}, scopeArgs = []) {
  const entries = [];
  const listed = runCommand('systemctl', [
    ...scopeArgs,
    'list-unit-files',
    '--type=service',
    '--all',
    '--no-legend',
    '--no-pager'
  ], options);
  if (!listed || listed.status !== 0) return entries;

  for (const line of String(listed.stdout || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([^\s]+)\s+([^\s]+)/);
    if (!match || !rolePattern.test(match[1])) continue;
    const unit = runCommand('systemctl', [...scopeArgs, 'cat', match[1]], options);
    if (!unit || unit.status !== 0) continue;
    const enabled = /^(enabled|enabled-runtime|static|alias)$/i.test(match[2]);
    entries.push(...parseSystemdUnit(match[1], unit.stdout, enabled));
  }
  return entries;
}

function readSystemdEntries(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const entries = [];
  const rolePattern = executablePattern(options);
  const serviceDirectories = systemdServiceDirectories(options);

  for (const directory of serviceDirectories) {
    for (const file of listFiles(fsImpl, directory, '.service', options)) {
      try {
        const content = fsImpl.readFileSync(file, 'utf8');
        if (!rolePattern.test(content)) continue;
        const enabled = /\.wants[\\/]|wants[\\/]/i.test(file);
        entries.push(...parseSystemdUnit(nodePath.basename(file), content, enabled));
      } catch (_error) {}
    }
  }

  entries.push(...readSystemctlEntries(rolePattern, options));
  entries.push(...readSystemctlEntries(rolePattern, options, ['--user']));
  return entries;
}

function plistString(content, key) {
  const escapedKey = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(content || '').match(new RegExp(`<key>${escapedKey}</key>\\s*<string>([^<]*)</string>`));
  return match ? decodePlistText(match[1]).trim() : '';
}

function plistBoolean(content, key) {
  const escapedKey = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<key>${escapedKey}</key>\\s*<(true|false)\\s*/>`).exec(String(content || ''))?.[1] === 'true';
}

function plistArray(content, key) {
  const escapedKey = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(content || '').match(new RegExp(`<key>${escapedKey}</key>\\s*<array>([\\s\\S]*?)</array>`));
  if (!match) return [];
  return Array.from(match[1].matchAll(/<string>([^<]*)<\/string>/g))
    .map((item) => decodePlistText(item[1]).trim())
    .filter(Boolean);
}

function decodePlistText(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function plistHasKey(content, key) {
  const escapedKey = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<key>${escapedKey}</key>`).test(String(content || ''));
}

function launchdEntryEnabled(content) {
  if (plistBoolean(content, 'Disabled')) return false;
  if (plistBoolean(content, 'RunAtLoad') || plistBoolean(content, 'StartOnMount')) return true;
  if (/<key>KeepAlive<\/key>\s*<(true|dict)/.test(String(content || ''))) return true;
  return [
    'StartInterval',
    'StartCalendarInterval',
    'WatchPaths',
    'QueueDirectories',
    'MachServices',
    'Sockets'
  ].some((key) => plistHasKey(content, key));
}

function readLaunchdEntries(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const entries = [];
  const rolePattern = executablePattern(options);
  const home = resolveHome(options);
  const directories = [
    '/Library/LaunchDaemons',
    '/Library/LaunchAgents',
    home && resolvePathApi(options).join(home, 'Library', 'LaunchAgents')
  ].filter(Boolean);
  for (const directory of directories) {
    for (const file of listFiles(fsImpl, directory, '.plist', options)) {
      try {
        let content = fsImpl.readFileSync(file, 'utf8');
        if (!String(content || '').includes('<plist')) {
          const converted = runCommand('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '--', file], options);
          if (converted && converted.status === 0) content = converted.stdout;
        }
        const args = plistArray(content, 'ProgramArguments');
        const program = plistString(content, 'Program');
        if (!rolePattern.test(`${program} ${args.join(' ')}`)) continue;
        const commandLine = args.length > 0
          ? args.map((arg) => /\s/.test(arg) ? `"${arg}"` : arg).join(' ')
          : program;
        entries.push({
          source: 'launchd',
          name: nodePath.basename(file),
          executablePath: program || args[0] || '',
          args: args.length > 0 ? args.slice(1) : [],
          commandLine,
          workingDirectory: plistString(content, 'WorkingDirectory'),
          enabled: launchdEntryEnabled(content)
        });
      } catch (_error) {}
    }
  }
  return entries;
}

function readWindowsEntries(options = {}) {
  const script = [
    '$items = @(',
    'Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object { $task = $_; foreach ($action in @($task.Actions)) { [PSCustomObject]@{ Source="scheduled-task"; Name=$task.TaskName; TaskPath=$task.TaskPath; Execute=$action.Execute; Arguments=$action.Arguments; WorkingDirectory=$action.WorkingDirectory; State=$task.State } } };',
    'Get-CimInstance Win32_StartupCommand -ErrorAction SilentlyContinue | ForEach-Object { [PSCustomObject]@{ Source="startup-command"; Name=$_.Name; Command=$_.Command; Location=$_.Location; User=$_.User } };',
    'Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | ForEach-Object { [PSCustomObject]@{ Source="windows-service"; Name=$_.Name; State=$_.State; StartMode=$_.StartMode; PathName=$_.PathName } }',
    '); $items | ConvertTo-Json -Compress'
  ].join(' ');
  const result = runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], options);
  const entries = [];
  for (const row of normalizeRows(result && result.status === 0 ? result.stdout : '')) {
    const source = String(row.Source || row.source || '').trim();
    if (source === 'scheduled-task') {
      const execute = String(row.Execute || '').trim();
      const argumentsValue = String(row.Arguments || '').trim();
      entries.push({
        source,
        name: `${row.TaskPath || ''}${row.Name || ''}`,
        executablePath: execute,
        commandLine: [execute, argumentsValue].filter(Boolean).join(' '),
        workingDirectory: row.WorkingDirectory || '',
        enabled: String(row.State || '').toLowerCase() !== 'disabled'
      });
      continue;
    }
    if (source === 'startup-command') {
      entries.push({
        source,
        name: row.Name || row.Location || '',
        commandLine: row.Command || '',
        enabled: true
      });
      continue;
    }
    if (source === 'windows-service') {
      const startMode = String(row.StartMode || '').toLowerCase();
      entries.push({
        source,
        name: row.Name || '',
        commandLine: row.PathName || '',
        enabled: startMode === 'auto' || startMode.includes('delayed')
      });
    }
  }
  return entries;
}

function readStartupEntries(options = {}) {
  if (Array.isArray(options.startupEntries)) return options.startupEntries;
  if (typeof options.listStartupEntries === 'function') {
    try { return normalizeRows(options.listStartupEntries(options)); } catch (_error) { return []; }
  }
  const platform = resolvePlatform(options);
  if (platform === 'linux') return readSystemdEntries(options);
  if (platform === 'darwin') return readLaunchdEntries(options);
  if (platform === 'win32') return readWindowsEntries(options);
  return [];
}

module.exports = {
  DEFAULT_DISCOVERY_MAX_BUFFER,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  DEFAULT_MANAGED_ROLES,
  entryArguments,
  entryArgumentsForRole,
  entryDirectlyRunsRole,
  entryExecutableForRole,
  entryMatchesRole,
  fileExists,
  parseSystemdUnit,
  readProcessEntries,
  readStartupEntries,
  resolveCandidatePath,
  resolveEntryBase,
  resolveEnv,
  resolveHome,
  resolvePathApi,
  resolvePlatform,
  runCommand,
  tokenizeCommandLine,
  unique
};
