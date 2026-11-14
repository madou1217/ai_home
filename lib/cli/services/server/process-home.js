'use strict';

// Read only the scope needed for ownership. Never log process environment data.
function readProcessHome(pid, command, options = {}) {
  const { fs, path, platform, spawnSync } = options;
  if (!Number.isSafeInteger(pid) || pid <= 0) return '';
  try {
    let values;
    if (platform === 'linux') {
      values = String(fs.readFileSync(`/proc/${pid}/environ`, 'utf8')).split('\0');
    } else if (platform === 'darwin') {
      const result = spawnSync('ps', ['eww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000, maxBuffer: 2 * 1024 * 1024 });
      const output = String(result.stdout || '').trim();
      if (result.status !== 0 || !command || !output.startsWith(command)) return '';
      const environment = output.slice(command.length).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(environment)) return '';
      values = environment.split(/\s+(?=[A-Za-z_][A-Za-z0-9_]*=)/);
    } else {
      // Windows lacks an equivalent supported process-environment query. The
      // instance-local runtime identity/verified child relation must establish it.
      return '';
    }
    const read = (key) => {
      const hits = values.filter((entry) => entry.startsWith(`${key}=`));
      return hits.length === 1 ? hits[0].slice(key.length + 1).trim() : '';
    };
    if (options.native === true) {
      // Go's resolver intentionally ignores Node's AI_HOME/AIH_HOST_HOME aliases.
      return read('AIH_HOME_DIR') || (read('HOME') ? path.join(read('HOME'), '.ai_home') : '');
    }
    const explicit = read('AIH_HOME_DIR') || read('AI_HOME');
    if (explicit) return explicit;
    const host = read('AIH_HOST_HOME') || read('HOME');
    if (!host) return '';
    const normalized = require('../../../runtime/host-home').resolveHostHomeDir({ env: { AIH_HOST_HOME: host }, platform });
    return path.join(normalized, '.ai_home');
  } catch (_error) { return ''; }
}

module.exports = { readProcessHome };
