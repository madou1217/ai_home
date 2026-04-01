const path = require('path');

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
  resolveWindowsBatchLaunch
};
