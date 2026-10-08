'use strict';

const { normalizeClientPlatform } = require('./client-platform');

function ensurePrivateDirectory(fs, directory) {
  let stat;
  try { stat = fs.lstatSync(directory); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('kiro_runtime_directory_not_private');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

// The desktop/umbrella binaries ignore KIRO_TEST_DB_PATH. Their native database
// path must resolve to the same account-private SQLite file used by chat/login.
// SQLite canonicalizes this file symlink, keeping WAL/SHM beside the target.
function prepareKiroRuntimeHome({ fs, path, sandboxDir, hostHomeDir, platform }) {
  if (!fs || !path || !sandboxDir) return;
  if (hostHomeDir && path.resolve(sandboxDir) === path.resolve(hostHomeDir)) {
    throw new Error('kiro_runtime_home_not_isolated');
  }
  const platformKey = normalizeClientPlatform(platform);
  const segments = platformKey === 'macos'
    ? ['Library', 'Application Support', 'kiro-cli']
    : platformKey === 'linux' ? ['.local', 'share', 'kiro-cli'] : [];
  ensurePrivateDirectory(fs, sandboxDir);
  const summary = { migrated: 0, linked: 0 };
  const ensureAccountDirectory = (relative) => {
    const directory = path.join(sandboxDir, ...relative);
    let existing;
    try { existing = fs.lstatSync(directory); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing?.isSymbolicLink() && hostHomeDir
      && path.resolve(path.dirname(directory), fs.readlinkSync(directory)) === path.resolve(hostHomeDir, ...relative)) {
      // Older generic reconciliation linked the host HOME into Kiro's account.
      // Detach only that exact legacy alias; never read/copy/remove its target.
      fs.unlinkSync(directory);
      summary.migrated += 1;
    }
    ensurePrivateDirectory(fs, directory);
  };
  // .kiro 不在这里：会话与设置用宿主原生 ~/.kiro（KIRO_HOME 指向它）。
  for (const relative of [['tmp'], ['.config'], ['.local']]) {
    ensureAccountDirectory(relative);
  }
  if (segments.length === 0) return summary;
  for (let length = 1; length <= segments.length; length++) {
    ensureAccountDirectory(segments.slice(0, length));
  }
  const target = path.join(sandboxDir, 'data.sqlite3');
  const nativePath = path.join(sandboxDir, ...segments, 'data.sqlite3');
  let existing;
  try { existing = fs.lstatSync(nativePath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing) {
    if (existing.isSymbolicLink()
      && path.resolve(path.dirname(nativePath), fs.readlinkSync(nativePath)) === path.resolve(target)) return summary;
    throw new Error('kiro_native_database_path_conflict');
  }
  fs.symlinkSync(path.relative(path.dirname(nativePath), target), nativePath, 'file');
  summary.linked += 1;
  return summary;
}

module.exports = { prepareKiroRuntimeHome };
