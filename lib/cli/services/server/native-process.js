'use strict';

const { resolveEntryProjectRoot, samePath } = require('../../../server/source-fingerprint');
const { resolveGoServerBinary } = require('./go-core-supervisor');

function nativeServerArgs(command, options = {}) {
  const { fs, path, entryFilePath } = options;
  if (!fs || !path || !entryFilePath) return null;
  const platform = options.platform || process.platform;
  const root = resolveEntryProjectRoot(fs, path, entryFilePath);
  if (!root) return null;
  const binary = resolveGoServerBinary({
    path, repositoryRoot: root, platform, arch: options.arch || process.arch,
    binaryPath: options.env && options.env.AIH_GO_SERVER_BINARY
  });
  const candidates = new Set([binary]);
  try { candidates.add(fs.realpathSync(binary)); } catch (_error) {}
  const text = String(command || '').trim();
  const compare = (value) => platform === 'win32' ? value.toLowerCase() : value;
  for (const candidate of candidates) {
    for (const prefix of [candidate, `"${candidate}"`, `'${candidate}'`]) {
      if (compare(text) !== compare(prefix) && !compare(text).startsWith(compare(`${prefix} `))) continue;
      return text.slice(prefix.length).trim();
    }
  }
  return null;
}

// Same executable also hosts MCP and remote workspace helpers. Only daemon flag
// invocations belong to lifecycle management; never terminate helper subcommands.
function isNativeServerCommand(command, options = {}) {
  const args = nativeServerArgs(command, options);
  return args !== null && (!args || (args.startsWith('-') && !/^(?:--help|-h)(?:\s|$)/.test(args)));
}

function isNativeSupervisorCommand(command, options = {}) {
  const args = nativeServerArgs(command, options);
  return isNativeServerCommand(command, options) && /(?:^|\s)--supervise-node(?:=true)?(?:\s|$)/.test(args);
}

function readParentPID(pid, options = {}) {
  const { spawnSync, platform } = options;
  if (!spawnSync || !Number.isInteger(pid) || pid <= 0) return 0;
  try {
    const result = platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`], { encoding: 'utf8', windowsHide: true, timeout: 2000 })
      : spawnSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8', timeout: 2000 });
    const parent = Number(String(result.stdout || '').trim());
    return result.status === 0 && Number.isSafeInteger(parent) && parent > 0 ? parent : 0;
  } catch (_error) { return 0; }
}

function isDirectChild(pid, parentPid, options = {}) {
  return Number.isInteger(parentPid) && parentPid > 0 && readParentPID(pid, options) === parentPid;
}

// PID alone is reusable. Use the OS process creation identity when a local
// identity record or captured child snapshot authorizes later lifecycle actions.
function readProcessStartID(pid, options = {}) {
  const { fs, spawnSync, platform } = options;
  if (!Number.isSafeInteger(pid) || pid <= 0) return '';
  try {
    if (platform === 'linux') {
      const raw = String(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
      const fields = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/);
      return /^\d+$/.test(fields[19] || '') ? `linux:${fields[19]}` : '';
    }
    const result = platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){([DateTimeOffset]$p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()}`], { encoding: 'utf8', windowsHide: true, timeout: 2000 })
      : spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
    const value = String(result.stdout || '').trim().replace(/\s+/g, ' ');
    if (result.status !== 0 || !value) return '';
    return `${platform === 'win32' ? 'windows' : 'unix'}:${value}`;
  } catch (_error) { return ''; }
}

function readNativeIdentity(options = {}) {
  try {
    const { fs, path, aiHomeDir } = options;
    const record = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'run', 'go-server-runtime.json'), 'utf8'));
    if (record.version !== 1 || !Number.isSafeInteger(record.pid) || record.pid <= 0
      || !samePath(path, { platform: options.platform }, record.aiHomeDir, aiHomeDir, fs)
      || !record.processStartId || readProcessStartID(record.pid, options) !== record.processStartId) return null;
    return record;
  } catch (_error) { return null; }
}

module.exports = { isNativeServerCommand, isNativeSupervisorCommand, isDirectChild, readParentPID, readProcessStartID, readNativeIdentity };
