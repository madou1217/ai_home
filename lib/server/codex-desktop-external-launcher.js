'use strict';

function installExternalLauncher({ fs, path, targetBinaryPath, upstreamBinaryPath, wrapper, isWrapperInstalled }) {
  if (isWrapperInstalled(upstreamBinaryPath)) {
    const backupPath = `${upstreamBinaryPath}.aih-original`;
    if (!fs.existsSync(backupPath) || isWrapperInstalled(backupPath)) {
      return { ok: false, reason: 'missing_upstream_backup' };
    }
    fs.renameSync(backupPath, upstreamBinaryPath);
  }
  if (!fs.existsSync(upstreamBinaryPath)) return { ok: false, reason: 'upstream_binary_missing' };
  const unchanged = isWrapperInstalled(targetBinaryPath)
    && fs.readFileSync(targetBinaryPath, 'utf8') === wrapper;
  if (!unchanged) {
    fs.mkdirSync(path.dirname(targetBinaryPath), { recursive: true });
    fs.writeFileSync(targetBinaryPath, wrapper, { mode: 0o755 });
    fs.chmodSync(targetBinaryPath, 0o755);
  }
  return { ok: true, installed: true, updated: !unchanged, unchanged, targetBinaryPath, upstreamBinaryPath };
}

function readDesktopLaunchEnv(fs, path, aiHomeDir) {
  if (!aiHomeDir) return {};
  try {
    const directory = path.join(aiHomeDir, 'run', 'codex');
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'desktop-hook-state.json'), 'utf8'));
    const launcher = path.join(directory, 'desktop-cli');
    if (state.enabled !== true || state.hookStrategy !== 'external-launcher' || state.targetBinaryPath !== launcher) return {};
    if (!fs.existsSync(launcher)) return {};
    return { CODEX_CLI_PATH: launcher };
  } catch (_) {
    return {};
  }
}

module.exports = { installExternalLauncher, readDesktopLaunchEnv };
