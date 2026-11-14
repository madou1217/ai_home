'use strict';

// A host-wide service label is not proof that the job belongs to this AIH_HOME.
// Inspect only local launcher configuration; no stop/install operation happens here.
function configuredAutostartHome(status, options) {
  const { fs, path, spawnSync, hostHomeDir } = options;
  const file = String(status && (status.file || status.plist) || '');
  if (!file) return '';
  try {
    const source = String(fs.readFileSync(file, 'utf8'));
    if (status.type === 'launchd') {
      const result = spawnSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8', timeout: 2000 });
      if (result.status !== 0) return '';
      const env = JSON.parse(result.stdout).EnvironmentVariables || {};
      return String(env.AIH_HOME_DIR || env.AI_HOME || (env.HOME ? path.join(env.HOME, '.ai_home') : '')).trim();
    }
    if (status.type === 'systemd-user') {
      const match = source.match(/^Environment="AIH_HOME_DIR=((?:\\.|[^"\\])*)"\s*$/m);
      return match ? match[1].replace(/\\([\\"])/g, '$1').replace(/%%/g, '%') : '';
    }
    if (status.type === 'windows-startup' || status.type === 'windows-scheduled-task') {
      const match = source.match(/^set "AIH_HOME_DIR=([^"\r\n]+)"\s*$/im);
      if (match) return match[1];
      const vbs = source.match(/shell\.Environment\("PROCESS"\)\("AIH_HOME_DIR"\)\s*=\s*"((?:""|[^"])*)"/i);
      if (vbs) return vbs[1].replace(/""/g, '"');
    }
    // Older launchers without an explicit home belong only to the standard home.
    return !source.includes('AIH_HOME_DIR') && hostHomeDir ? path.join(hostHomeDir, '.ai_home') : '';
  } catch (_error) { return ''; }
}

module.exports = { configuredAutostartHome };
