const fs = require('fs');
const path = require('path');

const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

function shellPathForName(name, fsImpl = fs) {
  const shell = String(name || '').trim();
  if (!POSIX_SHELLS.has(shell)) return '';
  const candidate = path.posix.join('/bin', shell);
  return fsImpl.existsSync(candidate) ? candidate : shell;
}

function parseShellShebang(firstLine, fsImpl = fs) {
  const line = String(firstLine || '').trim();
  if (!line.startsWith('#!')) return '';
  const tokens = line.slice(2).trim().split(/\s+/).filter(Boolean);
  const interpreter = tokens[0] || '';
  const baseName = path.basename(interpreter);
  if (baseName === 'env') {
    const shellName = tokens.slice(1).find((token) => !String(token || '').startsWith('-'));
    return POSIX_SHELLS.has(shellName) ? shellPathForName(shellName, fsImpl) : '';
  }
  return POSIX_SHELLS.has(baseName) ? shellPathForName(baseName, fsImpl) : '';
}

function resolvePosixShellScriptWrapper(cliBin, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const filePath = String(cliBin || '');
  if (!filePath) return '';
  try {
    if (!fsImpl.existsSync(filePath)) return '';
    const preview = fsImpl.readFileSync(filePath, 'utf8').split(/\r?\n/, 1)[0] || '';
    return parseShellShebang(preview, fsImpl);
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

function hasWindowsCmdShimExtension(filePath) {
  const ext = path.win32.extname(String(filePath || '')).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
}

function stripOuterQuotes(value) {
  const text = String(value || '').trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}

function resolveCmdShimToken(token, shimDir) {
  const dir = String(shimDir || '');
  const dirWithSlash = dir.endsWith('\\') || dir.endsWith('/')
    ? dir
    : `${dir}\\`;
  const expanded = stripOuterQuotes(token)
    .replace(/%~dp0/ig, dirWithSlash)
    .replace(/%dp0%/ig, dirWithSlash);
  return path.win32.normalize(expanded);
}

function findNodeShimTargetScript(cmdBody, shimDir) {
  const lines = String(cmdBody || '').split(/\r?\n/);
  for (const line of lines) {
    if (!/%\*/.test(line) || !/\.(?:c?js|mjs)\b/i.test(line)) continue;
    const quoted = Array.from(line.matchAll(/"([^"]+\.(?:c?js|mjs))"/ig));
    if (quoted.length > 0) {
      return resolveCmdShimToken(quoted[quoted.length - 1][1], shimDir);
    }
    const unquoted = line.match(/((?:%~dp0|%dp0%|[A-Za-z]:[\\/])\S+\.(?:c?js|mjs))\s+%\*/i);
    if (unquoted) return resolveCmdShimToken(unquoted[1], shimDir);
  }
  return '';
}

function isLikelyWindowsNodePath(value) {
  const text = String(value || '').trim();
  if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(text)) return false;
  const base = path.win32.basename(text).toLowerCase();
  return base === 'node.exe' || base === 'node';
}

function resolveNodeShimCommand(cmdBody, shimDir, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const localNode = path.win32.join(shimDir, 'node.exe');
  try {
    if (/%(?:~dp0|dp0%)\\node\.exe/i.test(String(cmdBody || '')) && fsImpl.existsSync(localNode)) {
      return localNode;
    }
  } catch (_error) {}
  if (isLikelyWindowsNodePath(options.nodeExecPath)) {
    return String(options.nodeExecPath);
  }
  return 'node.exe';
}

function collectCmdSetValues(cmdBody, key) {
  const escapedKey = String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const values = [];
  const re = new RegExp(`^[\\s@]*set\\s+"?${escapedKey}=([^"\\r\\n]*)"?`, 'gim');
  let match;
  while ((match = re.exec(String(cmdBody || '')))) {
    values.push(match[1]);
  }
  return values;
}

function expandCmdEnvValue(value, shimDir, env = {}) {
  return String(value || '')
    .replace(/%~dp0/ig, `${String(shimDir || '').replace(/[\\/]*$/, '')}\\`)
    .replace(/%dp0%/ig, `${String(shimDir || '').replace(/[\\/]*$/, '')}\\`)
    .replace(/%NODE_PATH%/ig, String(env && env.NODE_PATH || ''));
}

function buildNodeShimEnvPatch(cmdBody, shimDir, env = {}) {
  const nodePathValues = collectCmdSetValues(cmdBody, 'NODE_PATH');
  if (!nodePathValues.length) return {};
  const currentNodePath = String(env && env.NODE_PATH || '');
  const selected = currentNodePath
    ? (nodePathValues.find((value) => /%NODE_PATH%/i.test(value)) || nodePathValues[nodePathValues.length - 1])
    : (nodePathValues.find((value) => !/%NODE_PATH%/i.test(value)) || nodePathValues[0]);
  const nodePath = expandCmdEnvValue(selected, shimDir, env);
  return nodePath ? { NODE_PATH: nodePath } : {};
}

function resolveWindowsNodeShimLaunch(cliBin, args, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return null;
  const shimPath = String(cliBin || '').trim();
  if (!shimPath || !hasWindowsCmdShimExtension(shimPath)) return null;

  const fsImpl = options.fsImpl || fs;
  try {
    if (!fsImpl.existsSync(shimPath)) return null;
    const body = fsImpl.readFileSync(shimPath, 'utf8');
    if (!/\bnode(?:\.exe)?\b|%_prog%/i.test(body) || !/%\*/.test(body)) return null;
    const shimDir = path.win32.dirname(shimPath);
    const targetScript = findNodeShimTargetScript(body, shimDir);
    if (!targetScript) return null;
    const normalizedArgs = Array.isArray(args) ? args.map((x) => String(x)) : [];
    return {
      command: resolveNodeShimCommand(body, shimDir, options),
      args: [targetScript, ...normalizedArgs],
      envPatch: buildNodeShimEnvPatch(body, shimDir, options.env || {}),
      shimPath,
      targetScript
    };
  } catch (_error) {
    return null;
  }
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
  resolveWindowsNodeShimLaunch,
  resolvePosixShellScriptWrapper,
  resolveWindowsBatchLaunch
};
