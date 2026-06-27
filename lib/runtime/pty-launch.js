const fs = require('fs');
const path = require('path');

const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

function shellPathForName(name) {
  const shell = String(name || '').trim();
  if (!POSIX_SHELLS.has(shell)) return '';
  const candidate = path.join('/bin', shell);
  return fs.existsSync(candidate) ? candidate : shell;
}

function parseShellShebang(firstLine) {
  const line = String(firstLine || '').trim();
  if (!line.startsWith('#!')) return '';
  const tokens = line.slice(2).trim().split(/\s+/).filter(Boolean);
  const interpreter = tokens[0] || '';
  const baseName = path.basename(interpreter);
  if (baseName === 'env') {
    const shellName = tokens.slice(1).find((token) => !String(token || '').startsWith('-'));
    return POSIX_SHELLS.has(shellName) ? shellPathForName(shellName) : '';
  }
  return POSIX_SHELLS.has(baseName) ? shellPathForName(baseName) : '';
}

function resolvePosixShellScriptWrapper(cliBin, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const filePath = String(cliBin || '');
  if (!filePath) return '';
  try {
    if (!fsImpl.existsSync(filePath)) return '';
    const preview = fsImpl.readFileSync(filePath, 'utf8').split(/\r?\n/, 1)[0] || '';
    return parseShellShebang(preview);
  } catch (_error) {
    return '';
  }
}

function quoteForCmd(arg) {
  const text = String(arg || '');
  if (text.length === 0) return '""';
  if (/^[A-Za-z0-9._:/\\-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildPtyLaunch(cliBin, args, options = {}) {
  const platform = options.platform || process.platform;
  const pathImpl = platform === 'win32' ? path.win32 : path;
  const normalizedArgs = Array.isArray(args) ? args.map((x) => String(x)) : [];

  if (platform !== 'win32') {
    const shellWrapper = resolvePosixShellScriptWrapper(cliBin, options);
    if (shellWrapper) {
      return { command: shellWrapper, args: [String(cliBin), ...normalizedArgs] };
    }
    return { command: String(cliBin), args: normalizedArgs };
  }

  const ext = pathImpl.extname(String(cliBin || '')).toLowerCase();
  const requiresCmdWrapper = !ext || ext === '.cmd' || ext === '.bat';
  if (!requiresCmdWrapper) {
    return { command: String(cliBin), args: normalizedArgs };
  }

  const commandLine = [quoteForCmd(cliBin), ...normalizedArgs.map(quoteForCmd)].join(' ');
  const wrappedLine = `chcp 65001>nul & ${commandLine}`;
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', wrappedLine]
  };
}

function resolveWindowsBatchLaunch(cliName, cliBin, env = process.env, platform = process.platform) {
  const launchBin = String(cliBin || cliName || '').trim();
  if (platform !== 'win32') {
    return { launchBin, envPatch: {} };
  }
  const ext = path.win32.extname(launchBin).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') {
    return { launchBin, envPatch: {} };
  }

  const cliDir = path.win32.dirname(launchBin);
  const cliBase = path.win32.basename(launchBin);
  const currentPath = String((env && (env.Path || env.PATH)) || '');
  const sep = ';';
  const parts = currentPath.split(sep).map((x) => x.trim()).filter(Boolean);
  const hasDir = parts.some((x) => x.toLowerCase() === cliDir.toLowerCase());
  const nextPath = hasDir ? currentPath : [cliDir, ...parts].join(sep);

  return {
    launchBin: String(cliName || cliBase || ''),
    envPatch: {
      PATH: nextPath,
      Path: nextPath
    }
  };
}

module.exports = {
  buildPtyLaunch,
  parseShellShebang,
  resolvePosixShellScriptWrapper,
  resolveWindowsBatchLaunch
};
