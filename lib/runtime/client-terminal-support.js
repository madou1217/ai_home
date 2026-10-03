'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const {
  CLIENT_PLATFORMS,
  getClientPlatformAdapter,
  normalizeClientPlatform
} = require('./client-platform');

/**
 * 终端插件共享的探测与命令拼装工具（与具体终端无关）。
 * 具体终端的启动参数、安装计划都在 client-terminals/<id>.js 插件内。
 */
const DEFAULT_TERMINAL_ID = 'system-default';

function normalizeEnv(options = {}) {
  const processObj = options.processObj || process;
  const source = options.env || processObj.env || process.env || {};
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, String(value)]));
}

function resolveContext(options = {}) {
  const processObj = options.processObj || process;
  const platform = normalizeClientPlatform(options.platform || processObj.platform || process.platform);
  const platformAdapter = getClientPlatformAdapter(platform);
  const pathImpl = options.path || platformAdapter && platformAdapter.path || nodePath;
  return {
    ...options,
    platform,
    processObj,
    path: pathImpl,
    fs: options.fs || nodeFs,
    env: normalizeEnv(options),
    platformAdapter
  };
}

// pathEntryExists 兼容 Store 应用的 AppExecutionAlias：这类别名是 0 字节
// reparse point，stat 跟随解析点会 EACCES、existsSync 返回 false，而
// accessSync/lstat 只看目录项本身（2026-08-22 Windows Terminal 探测漏报：
// wt.exe 明明存在却被判定未安装）。
function pathEntryExists(fs, candidate) {
  try {
    if (fs.existsSync(candidate)) return true;
  } catch (_error) {}
  try {
    if (typeof fs.accessSync === 'function') {
      fs.accessSync(candidate);
      return true;
    }
  } catch (_error) {}
  try {
    if (typeof fs.lstatSync === 'function') {
      return Boolean(fs.lstatSync(candidate, { throwIfNoEntry: false }));
    }
  } catch (_error) {}
  return false;
}

function findOnPath(names, context = {}) {
  const { env, fs, path, platform } = resolveContext(context);
  const candidates = (Array.isArray(names) ? names : [names])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  const delimiter = platform === CLIENT_PLATFORMS.WINDOWS ? ';' : (path.delimiter || ':');
  const dirs = String(env.PATH || env.Path || env.path || '')
    .split(delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean);
  for (const dir of dirs) {
    for (const name of candidates) {
      const candidate = path.join(dir, name);
      if (pathEntryExists(fs, candidate)) return candidate;
      if (platform === CLIENT_PLATFORMS.WINDOWS && !/\.[a-z0-9]+$/i.test(name)) {
        const executable = `${candidate}.exe`;
        if (pathEntryExists(fs, executable)) return executable;
      }
    }
  }
  return '';
}

function findFirstExisting(paths, fs) {
  for (const candidate of paths) {
    if (candidate && pathEntryExists(fs, candidate)) return candidate;
  }
  return '';
}

function readHostHome(context) {
  const { env, platform } = context;
  return String(context.hostHomeDir || (platform === CLIENT_PLATFORMS.WINDOWS
    ? env.USERPROFILE
    : env.HOME) || '').trim();
}

function escapeAppleScriptString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function shellQuote(value, platform) {
  const text = String(value == null ? '' : value);
  if (platform === CLIENT_PLATFORMS.WINDOWS) return `"${text.replace(/"/g, '\\"')}"`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

// Windows Terminal 的 new-tab positional parser 会把含空格的每个参数再次
// 包进双引号。不能把整条 `cmd /k ...` 作为一个参数传入，否则 Terminal
// 会把它重组为 `"cmd.exe /k set" ...`，再由 CreateProcess 报 0x80070002。
// 这里仅拆解 aih 自己生成的 cmd 命令：去掉语法性外层双引号，保留参数值，
// 并把 && 作为独立 token；Terminal 随后会按参数边界重新生成合法命令行。
function tokenizeWindowsTerminalCommand(command) {
  const tokens = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(command || '')))) {
    const token = String(match[1] ?? match[2] ?? '').trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

function quoteWindowsStartToken(value) {
  const text = String(value == null ? '' : value);
  if (!text) return '""';
  if (/^[&|<>]+$/.test(text)) {
    return text.replace(/[&|<>]/g, (character) => `^${character}`);
  }
  if (/^[A-Za-z0-9_.:=/+\\-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildWindowsTerminalStartLine(executable, title, command) {
  const executableText = String(executable || '');
  const startExecutable = /[\\/]WindowsApps[\\/]wt\.exe$/i.test(executableText)
    ? 'wt.exe'
    : executableText;
  const childArgs = [
    '-w', 'new', 'new-tab', '--title', title,
    'cmd.exe', '/d', '/s', '/k',
    ...tokenizeWindowsTerminalCommand(command)
  ];
  const renderedArgs = childArgs.map((arg) => quoteWindowsStartToken(arg));
  return `start "" ${quoteWindowsStartToken(startExecutable)} ${renderedArgs.join(' ')}`;
}

function resolveTerminalExecutable(definition, context = {}) {
  const resolved = resolveContext(context);
  const { env, fs, path, platform } = resolved;
  const platformConfig = definition.executables && definition.executables[platform];
  if (!platformConfig) return '';
  const hostHomeDir = readHostHome(resolved);
  const localAppData = String(env.LOCALAPPDATA || (hostHomeDir
    ? path.join(hostHomeDir, 'AppData', 'Local')
    : '')).trim();
  const expandPaths = (paths) => (paths || []).map((candidate) => {
    const expanded = String(candidate || '')
      .replaceAll('{hostHomeDir}', hostHomeDir)
      .replaceAll('{localAppData}', localAppData);
    return expanded ? path.normalize(expanded) : '';
  });
  const managedCandidate = findFirstExisting(expandPaths(platformConfig.managedPaths), fs);
  if (managedCandidate) return managedCandidate;
  // 插件可声明包内可执行文件解析（例如 Windows Terminal 的 AppX 宿主），优先于 PATH。
  if (typeof definition.resolvePackageExecutable === 'function') {
    const packageExecutable = definition.resolvePackageExecutable(resolved);
    if (packageExecutable) return packageExecutable;
  }
  const pathCandidate = findOnPath(platformConfig.binaryNames || [], resolved);
  if (pathCandidate) return pathCandidate;
  return findFirstExisting(expandPaths(platformConfig.paths), fs);
}

function buildInteractiveShellCommand(context = {}) {
  const resolved = resolveContext(context);
  if (resolved.platform === CLIENT_PLATFORMS.WINDOWS) return 'echo AI Home terminal';
  const shell = String(
    resolved.env.SHELL
      || resolved.platformAdapter && resolved.platformAdapter.commands && resolved.platformAdapter.commands.shell
      || (resolved.platform === CLIENT_PLATFORMS.MACOS ? '/bin/zsh' : '/bin/bash')
  ).trim();
  return `exec ${shellQuote(shell, resolved.platform)} -l`;
}

function resolveLifecycleExecutable(names, fallbackPaths, context = {}) {
  const resolved = resolveContext(context);
  return findOnPath(names, resolved) || findFirstExisting(fallbackPaths, resolved.fs);
}

module.exports = {
  DEFAULT_TERMINAL_ID,
  buildInteractiveShellCommand,
  buildWindowsTerminalStartLine,
  escapeAppleScriptString,
  findFirstExisting,
  findOnPath,
  pathEntryExists,
  readHostHome,
  resolveContext,
  resolveLifecycleExecutable,
  resolveTerminalExecutable,
  shellQuote,
  tokenizeWindowsTerminalCommand
};
