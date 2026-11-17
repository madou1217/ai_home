'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const digestCache = new Map();

function managedCodexSelection(options = {}) {
  const processObj = options.processObj || process;
  const env = processObj.env || process.env;
  const hostHome = processObj.platform === 'win32' ? (env.USERPROFILE || env.HOME) : (env.HOME || env.USERPROFILE);
  const home = options.hostHomeDir || env.AIH_HOST_HOME || hostHome || os.homedir();
  const root = processObj.platform === 'win32'
    ? path.join(home, 'AppData', 'Local', 'aih-cli', 'codex')
    : path.join(home, '.local', 'share', 'aih-cli', 'codex');
  const file = path.join(root, 'runtime.json');
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    if (fs.fstatSync(fd).size > 32768) throw new Error('codex_managed_receipt_invalid');
    const receipt = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (receipt.format === 1 && receipt.disabled === true) return { root, disabled: true };
    const selected = receipt.current;
    if (receipt.format !== 1 || !selected || !/^runtime-[0-9]+$/.test(selected.generation)
      || !selected.executable || path.isAbsolute(selected.executable)
      || path.normalize(selected.executable) !== selected.executable
      || !/^[a-f0-9]{64}$/i.test(selected.sha256) || !selected.version || !(selected.size > 0)) {
      throw new Error('codex_managed_receipt_invalid');
    }
    const releases = fs.realpathSync(path.join(root, 'releases'));
    const generation = fs.realpathSync(path.join(releases, selected.generation));
    if (path.relative(releases, generation) !== selected.generation) throw new Error('codex_managed_generation_invalid');
    const binary = fs.realpathSync(path.join(generation, selected.executable));
    const relative = path.relative(generation, binary);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('codex_managed_path_invalid');
    }
    const stat = fs.statSync(binary);
    if (!stat.isFile() || stat.size !== selected.size) throw new Error('codex_managed_binary_changed');
    fs.accessSync(binary, processObj.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    const cacheKey = [binary, stat.size, stat.mtimeMs, stat.ino, selected.sha256].join(':');
    if (!digestCache.has(cacheKey)) {
      const executable = fs.openSync(binary, 'r');
      try {
        const hash = crypto.createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let count;
        while ((count = fs.readSync(executable, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
        if (hash.digest('hex') !== selected.sha256.toLowerCase()) throw new Error('codex_managed_digest_changed');
      } finally {
        fs.closeSync(executable);
      }
      if (digestCache.size >= 16) digestCache.clear();
      digestCache.set(cacheKey, true);
    }
    return { root, binary, version: selected.version };
  } finally {
    fs.closeSync(fd);
  }
}

// Legacy wrappers retain their proxy behavior, but delegate to the explicitly
// activated runtime. The backup remains untouched and usable for diagnostics.
function resolveManagedCodexUpstream(fallback, options = {}) {
  const processObj = options.processObj || process;
  const env = processObj.env || process.env;
  if (Object.prototype.hasOwnProperty.call(env, 'AIH_CODEX_BINARY')) return fallback;
  const selected = managedCodexSelection(options);
  if (selected && selected.disabled) throw new Error('Codex 尚未安装；请在应用管理中点击安装并修复。');
  return selected ? selected.binary : fallback;
}

module.exports = { managedCodexSelection, resolveManagedCodexUpstream };
