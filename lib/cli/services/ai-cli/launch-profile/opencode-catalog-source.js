'use strict';

// `aih opencode` 改道目录的来源：opencode **自己**维护的 models.dev 目录缓存。
//
// 为什么不只读 `~/.cache/opencode/models.json`（2026-10-18）：那是 opencode 1.x 的缓存文件。
// 2.x 起目录缓存改存在数据库 `opencode.db` 的 `kv` 表（键 `models-dev:catalog`；用户自定义
// `OPENCODE_MODELS_URL` 时为 `models-dev:catalog:<hash>`），启动时及之后定时刷新，旧文件
// 再也不会更新。照抄旧文件，上游新上的模型在改道后的 opencode 里就是「Model unavailable」
// （实测 glm-5.3-flash-free：旧文件停在 10-15，kv 当天刚刷新过）。
//
// 所以两处都读、谁新用谁。aih 不自己拉目录，也不写死任何模型：经 aih 启动的 opencode
// 照样刷新 kv（目录文件只决定它用哪份目录，不影响它刷新缓存），下次启动自然跟上。
// 用户自己设了 `OPENCODE_MODELS_PATH` 时与 opencode 的行为一致：只用那份。

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const KV_CATALOG_KEY = 'models-dev:catalog';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isCatalog(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** opencode 1.x 的目录缓存文件：`$XDG_CACHE_HOME/opencode/models.json`。 */
function resolveLegacyCachePath({ path, hostHomeDir, baseEnv }) {
  const cacheHome = normalizeString(baseEnv && baseEnv.XDG_CACHE_HOME)
    || (hostHomeDir ? path.join(hostHomeDir, '.cache') : '');
  return cacheHome ? path.join(cacheHome, 'opencode', 'models.json') : '';
}

/** opencode 2.x 的数据库：`$XDG_DATA_HOME/opencode/opencode.db`（各账号桥接目录软链到这一份）。 */
function resolveDataDbPath({ path, hostHomeDir, baseEnv }) {
  const dataHome = normalizeString(baseEnv && baseEnv.XDG_DATA_HOME)
    || (hostHomeDir ? path.join(hostHomeDir, '.local', 'share') : '');
  return dataHome ? path.join(dataHome, 'opencode', 'opencode.db') : '';
}

function readFileCatalog(fs, filePath) {
  if (!filePath) return null;
  try {
    const catalog = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isCatalog(catalog)) return null;
    return { catalog, updatedAt: Number(fs.statSync(filePath).mtimeMs) || 0, source: filePath };
  } catch (_error) {
    return null;
  }
}

function loadDatabaseSync(injected) {
  if (injected) return injected;
  try {
    return require('node:sqlite').DatabaseSync || null;
  } catch (_error) {
    return null;
  }
}

/**
 * 读 opencode 2.x 的 kv 目录缓存。值形如 `{ updatedAt, digest, body }`，body 是 api.json 原文。
 * 只读打开；opencode 正在运行（WAL）也不受影响。读不到一律返回 null。
 */
function readKvCatalog(fs, dbPath, DatabaseSync) {
  if (!dbPath || !DatabaseSync || !fs.existsSync(dbPath)) return null;
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // 用户换过 OPENCODE_MODELS_URL 时会有多行：opencode 正在用的那份刷新得最晚。
    const row = db.prepare(
      'SELECT value FROM kv WHERE key = ? OR key LIKE ? ORDER BY time_updated DESC LIMIT 1'
    ).get(KV_CATALOG_KEY, `${KV_CATALOG_KEY}:%`);
    if (!row) return null;
    const entry = JSON.parse(String(row.value));
    const catalog = typeof entry.body === 'string' ? JSON.parse(entry.body) : entry.body;
    if (!isCatalog(catalog)) return null;
    return { catalog, updatedAt: Number(entry.updatedAt) || 0, source: `${dbPath}#kv:${KV_CATALOG_KEY}` };
  } catch (_error) {
    return null;
  } finally {
    try { if (db) db.close(); } catch (_closeError) { /* best effort */ }
  }
}

/**
 * 取 opencode 当前会用的目录。
 *
 * @param {{ fs?: any, path?: any, hostHomeDir?: string, baseEnv?: object,
 *           excludePath?: string, DatabaseSync?: Function }} input
 *   excludePath：aih 自己生成的改道文件。嵌套启动时它会出现在继承来的
 *   `OPENCODE_MODELS_PATH` 里，不能把它当成用户指定的目录（否则永远停在旧的那份）。
 * @returns {{ catalog: object, updatedAt: number, source: string }|null}
 */
function readOpenCodeCatalog(input = {}) {
  const fs = input.fs || nodeFs;
  const path = input.path || nodePath;
  const hostHomeDir = normalizeString(input.hostHomeDir);
  const baseEnv = input.baseEnv || {};

  const explicitPath = normalizeString(baseEnv.OPENCODE_MODELS_PATH);
  const excludePath = normalizeString(input.excludePath);
  if (explicitPath && path.resolve(explicitPath) !== (excludePath && path.resolve(excludePath))) {
    return readFileCatalog(fs, explicitPath);
  }

  const candidates = [
    readKvCatalog(fs, resolveDataDbPath({ path, hostHomeDir, baseEnv }), loadDatabaseSync(input.DatabaseSync)),
    readFileCatalog(fs, resolveLegacyCachePath({ path, hostHomeDir, baseEnv }))
  ].filter(Boolean);
  if (candidates.length === 0) return null;
  return candidates.reduce((newest, item) => (item.updatedAt > newest.updatedAt ? item : newest));
}

module.exports = {
  KV_CATALOG_KEY,
  readOpenCodeCatalog,
  resolveDataDbPath,
  resolveLegacyCachePath
};
