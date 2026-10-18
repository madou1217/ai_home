'use strict';

// kiro 账号库的 **CLI schema 自举** —— 让 aih 原生登录写出的库能被 kiro-cli 打开。
//
// 问题（2026-10-18 用真 kiro-cli 复现）：aih 的原生登录（设备码 / 粘贴 refresh_token / social 设备流）
// 只写一张 `auth_kv` 表（kiro-device-login.js 的 writeKiroCredentialDatabase）。kiro-cli 打开库时
// 会按自己的 `migrations` 表补跑迁移，其中一条是 `CREATE TABLE auth_kv`，于是直接失败：
//   error: Failed to open database: table auth_kv already exists ...
// 本机从 CLI 抓来的账号带的是 CLI 自己的完整库，所以「本机能用、换台电脑重新登录就报错」。
//
// 修法：**schema 归 CLI 自己**，aih 不硬编码它的表结构（迁移会随 CLI 版本增加）。
//   1. 让 kiro-cli 在一个新路径上建库：`settings list` 只读设置、不登录、不联网，
//      但会打开数据库并跑完全部迁移（实测 11 条，退出码 0）；
//   2. 把裸库里的 auth_kv 行搬进去；
//   3. 原子替换账号库。
// 任何一步失败都保持原样返回（调用方按旧行为继续启动），绝不删掉现有凭据。

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawnSync: nodeSpawnSync } = require('node:child_process');

const BOOTSTRAP_TIMEOUT_MS = 30000;
// 只剥这两个：KIRO_HOME 会把会话写进账号目录，KIRO_API_KEY 会让 CLI 换认证方式（与启动策略同口径）。
const STRIPPED_ENV_KEYS = Object.freeze(['KIRO_HOME', 'KIRO_API_KEY']);

function loadDatabaseSync() {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    return null;
  }
}

function listTables(DatabaseSync, databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((row) => String(row.name)));
  } finally {
    database.close();
  }
}

/** 是不是「aih 写的裸库」：有 auth_kv、没有 CLI 的 migrations 表。读不了一律当「不是」（不动它）。 */
function isBareKiroDatabase(databasePath, options = {}) {
  const fs = options.fs || nodeFs;
  const DatabaseSync = options.DatabaseSync || loadDatabaseSync();
  if (!DatabaseSync || !databasePath || !fs.existsSync(databasePath)) return false;
  try {
    const tables = listTables(DatabaseSync, databasePath);
    return tables.has('auth_kv') && !tables.has('migrations');
  } catch (_error) {
    return false;
  }
}

function buildBootstrapEnv(baseEnv, hostHomeDir, schemaPath) {
  const env = { ...baseEnv };
  for (const key of STRIPPED_ENV_KEYS) delete env[key];
  if (hostHomeDir) {
    env.HOME = hostHomeDir;
    env.USERPROFILE = hostHomeDir;
  }
  env.KIRO_TEST_DB_PATH = schemaPath;
  return env;
}

/**
 * 把裸库升级成 kiro-cli 能打开的库。
 *
 * @param {{databasePath: string, cliPath: string, hostHomeDir?: string, env?: object}} input
 * @returns {{repaired: boolean, reason: string}}
 */
function bootstrapKiroCliDatabase(input = {}, options = {}) {
  const fs = options.fs || nodeFs;
  const path = options.path || nodePath;
  const spawnSync = options.spawnSync || nodeSpawnSync;
  const DatabaseSync = options.DatabaseSync || loadDatabaseSync();
  const databasePath = String(input.databasePath || '').trim();
  const cliPath = String(input.cliPath || '').trim();
  if (!DatabaseSync) return { repaired: false, reason: 'sqlite_unavailable' };
  if (!isBareKiroDatabase(databasePath, { fs, DatabaseSync })) return { repaired: false, reason: 'not_bare' };
  if (!cliPath) return { repaired: false, reason: 'cli_unavailable' };

  // 临时目录放在账号库旁边：同一文件系统，最后一步 rename 才是原子的。
  const tempDir = fs.mkdtempSync(path.join(path.dirname(databasePath), '.aih-kiro-schema-'));
  const schemaPath = path.join(tempDir, 'data.sqlite3');
  let target = null;
  let source = null;
  try {
    const result = spawnSync(cliPath, ['settings', 'list'], {
      env: buildBootstrapEnv(input.env || process.env, input.hostHomeDir, schemaPath),
      stdio: 'ignore',
      timeout: BOOTSTRAP_TIMEOUT_MS
    });
    if (!result || result.error || result.status !== 0) return { repaired: false, reason: 'cli_bootstrap_failed' };
    if (!fs.existsSync(schemaPath) || !listTables(DatabaseSync, schemaPath).has('migrations')) {
      return { repaired: false, reason: 'cli_bootstrap_no_schema' };
    }

    source = new DatabaseSync(databasePath, { readOnly: true });
    const rows = source.prepare('SELECT key, value FROM auth_kv').all();
    source.close();
    source = null;

    target = new DatabaseSync(schemaPath);
    target.exec('BEGIN IMMEDIATE');
    target.exec('DELETE FROM auth_kv');
    const insert = target.prepare('INSERT INTO auth_kv(key, value) VALUES(?, ?)');
    for (const row of rows) insert.run(row.key, row.value);
    target.exec('COMMIT');
    target.close();
    target = null;

    fs.chmodSync(schemaPath, 0o600);
    fs.renameSync(schemaPath, databasePath);
    return { repaired: true, reason: 'bootstrapped' };
  } catch (_error) {
    try { target?.exec('ROLLBACK'); } catch (_rollbackError) { /* 事务可能未开始 */ }
    return { repaired: false, reason: 'bootstrap_error' };
  } finally {
    try { source?.close(); } catch (_closeError) { /* ignore */ }
    try { target?.close(); } catch (_closeError) { /* ignore */ }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  BOOTSTRAP_TIMEOUT_MS,
  bootstrapKiroCliDatabase,
  isBareKiroDatabase
};
