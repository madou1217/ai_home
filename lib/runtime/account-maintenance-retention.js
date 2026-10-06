'use strict';

const path = require('node:path');

// 账号重键迁移的目录（migration/oauth-rekey-<id>）在迁移结束后只剩一个用途：
// 短时间内允许用户撤销一次已完成的迁移（recoverMaintenance(..., { rollback: true })）。
// 撤销要求数据库与迁移完成时逐行一致，服务一旦继续写入就不再可能，所以这份数据
// 只在很短的窗口内有价值；之后它只是一份整库副本（database.sqlite）加日志，
// 违背"不留备份、不复制数据"的约定。终态目录保留 MAINTENANCE_RETENTION_MS 后删除。
const MAINTENANCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAINTENANCE_DIRECTORY_PATTERN = /^oauth-rekey-[a-f0-9-]{36}$/;
const TERMINAL_STATES = new Set(['completed', 'rolled_back']);

function readTerminalJournalTime(fs, directory) {
  const file = path.join(directory, 'journal.json');
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) return null;
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  return journal && TERMINAL_STATES.has(journal.state) ? info.mtimeMs : null;
}

/**
 * 删除已结束且超过保留期的迁移目录。未结束的迁移（恢复仍需要它）、无法解析的
 * 日志、符号链接一律不动。永不抛出：清理失败不能挡住启动或新的迁移。
 *
 * @returns {{ removed: string[] }}
 */
function pruneExpiredMaintenanceDirectories(fs, aiHomeDir, options = {}) {
  const removed = [];
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const retentionMs = Number.isFinite(options.retentionMs) ? options.retentionMs : MAINTENANCE_RETENTION_MS;
  const root = path.join(aiHomeDir, 'migration');
  let names;
  try { names = fs.readdirSync(root); } catch (_error) { return { removed }; }
  for (const name of names) {
    if (!MAINTENANCE_DIRECTORY_PATTERN.test(name)) continue;
    const directory = path.join(root, name);
    try {
      const info = fs.lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const finishedAt = readTerminalJournalTime(fs, directory);
      if (finishedAt === null || now - finishedAt < retentionMs) continue;
      fs.rmSync(directory, { recursive: true, force: true });
      removed.push(name);
    } catch (_error) {
      // 读不懂的目录留给恢复流程判断，这里不替它做决定。
    }
  }
  return { removed };
}

module.exports = {
  MAINTENANCE_RETENTION_MS,
  pruneExpiredMaintenanceDirectories
};
