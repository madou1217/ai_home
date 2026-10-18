'use strict';

// kiro 账号库的 CLI schema 自举回归。
//
// 守的是「换台电脑重新登录后 kiro-cli 打不开库」：aih 原生登录只写 auth_kv 一张表，
// kiro-cli 补跑迁移时 `CREATE TABLE auth_kv` 冲突（2026-10-18 用真 CLI 复现）。
// 修法是让 CLI 自己建 schema 再合并凭据；这里用假 CLI 钉住每条分支，尤其是
// 「任何一步失败都不能弄丢现有凭据」。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { bootstrapKiroCliDatabase, isBareKiroDatabase } = require('../lib/account/kiro-cli-database-bootstrap');
const { ensureCliCompatibleDatabase } = require('../lib/cli/services/ai-cli/launch-profile/kiro-strategy');
const { writeKiroCredentialDatabase, buildKiroAuthRow } = require('../lib/account/kiro-device-login');
const { readKiroTokenRecord } = require('../lib/account/kiro-auth-metadata');

const GRANT = { accessToken: 'aoa-x', refreshToken: 'aor-x', expiresAtMs: Date.UTC(2030, 0, 1), region: 'us-east-1' };

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-bootstrap-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeBareDatabase(dir) {
  const databasePath = path.join(dir, 'data.sqlite3');
  writeKiroCredentialDatabase(fs, databasePath, {
    registration: null,
    auth: buildKiroAuthRow(GRANT, { authMethod: 'social', provider: 'Google', profileArn: 'arn:p' })
  });
  return databasePath;
}

/** 假 CLI：按 KIRO_TEST_DB_PATH 建出与真 CLI 同类的 schema（migrations + auth_kv + state）。 */
function fakeCliSpawn(calls, { status = 0 } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (status !== 0) return { status };
    const database = new DatabaseSync(options.env.KIRO_TEST_DB_PATH);
    database.exec('CREATE TABLE migrations (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, migration_time INTEGER NOT NULL)');
    database.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)');
    database.exec('CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB)');
    database.exec("INSERT INTO migrations(version, migration_time) VALUES (0, 1)");
    database.close();
    return { status: 0 };
  };
}

function tables(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name).sort();
  } finally {
    database.close();
  }
}

test('裸库：让 CLI 建 schema 后合并凭据，原子替换，临时目录不残留', (t) => {
  const dir = tempDir(t);
  const databasePath = writeBareDatabase(dir);
  assert.equal(isBareKiroDatabase(databasePath), true);

  const calls = [];
  const result = bootstrapKiroCliDatabase(
    { databasePath, cliPath: '/fake/kiro-cli', hostHomeDir: '/host', env: { KIRO_HOME: '/x', KIRO_API_KEY: 'k', PATH: '/bin' } },
    { spawnSync: fakeCliSpawn(calls) }
  );

  assert.deepEqual(result, { repaired: true, reason: 'bootstrapped' });
  // 只用不登录、不联网的本地命令自举；剥掉会改变 CLI 行为的两个变量。
  assert.deepEqual(calls[0].args, ['settings', 'list']);
  assert.equal(calls[0].env.KIRO_HOME, undefined);
  assert.equal(calls[0].env.KIRO_API_KEY, undefined);
  assert.equal(calls[0].env.HOME, '/host');
  assert.equal(isBareKiroDatabase(databasePath), false);
  assert.deepEqual(tables(databasePath), ['auth_kv', 'migrations', 'state']);
  const record = readKiroTokenRecord(databasePath);
  assert.equal(record.slot, 'kirocli:social:token');
  assert.equal(record.token.access_token, 'aoa-x');
  assert.equal(record.token.authMethod, 'social', 'aih 私有元数据行一起搬过去');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('.aih-kiro-schema-')), []);
});

test('CLI 不可用 / CLI 失败：原库一字不动（宁可按旧行为启动，也不弄丢凭据）', (t) => {
  const dir = tempDir(t);
  const databasePath = writeBareDatabase(dir);
  const before = fs.readFileSync(databasePath);

  assert.deepEqual(bootstrapKiroCliDatabase({ databasePath, cliPath: '' }),
    { repaired: false, reason: 'cli_unavailable' });

  const calls = [];
  assert.deepEqual(
    bootstrapKiroCliDatabase({ databasePath, cliPath: '/fake/kiro-cli' }, { spawnSync: fakeCliSpawn(calls, { status: 1 }) }),
    { repaired: false, reason: 'cli_bootstrap_failed' }
  );
  assert.deepEqual(fs.readFileSync(databasePath), before);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('.aih-kiro-schema-')), []);
});

test('已经是 CLI 的库（或库不存在）：不动、不解析 CLI 路径（常规启动零开销）', (t) => {
  const dir = tempDir(t);
  const resolved = [];
  const deps = {
    resolveProviderCliPath: (...args) => { resolved.push(args); return '/fake/kiro-cli'; },
    bootstrapKiroCliDatabase: () => { throw new Error('不应被调用'); }
  };
  // 库不存在。
  assert.deepEqual(ensureCliCompatibleDatabase({ fs, path, sandboxDir: dir }, deps),
    { repaired: false, reason: 'not_bare' });
  // CLI 自己的库。
  const database = new DatabaseSync(path.join(dir, 'data.sqlite3'));
  database.exec('CREATE TABLE migrations (id INTEGER PRIMARY KEY, version INTEGER, migration_time INTEGER)');
  database.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)');
  database.close();
  assert.deepEqual(ensureCliCompatibleDatabase({ fs, path, sandboxDir: dir }, deps),
    { repaired: false, reason: 'not_bare' });
  assert.equal(resolved.length, 0);
});

test('启动策略：裸库时解析 CLI 路径并交给自举', (t) => {
  const dir = tempDir(t);
  writeBareDatabase(dir);
  const seen = [];
  const result = ensureCliCompatibleDatabase({ fs, path, sandboxDir: dir, hostHomeDir: '/host', baseEnv: { A: '1' } }, {
    resolveProviderCliPath: (provider) => { seen.push(provider); return '/fake/kiro-cli'; },
    bootstrapKiroCliDatabase: (input) => { seen.push(input); return { repaired: true, reason: 'bootstrapped' }; }
  });
  assert.deepEqual(result, { repaired: true, reason: 'bootstrapped' });
  assert.equal(seen[0], 'kiro');
  assert.equal(seen[1].databasePath, path.join(dir, 'data.sqlite3'));
  assert.equal(seen[1].cliPath, '/fake/kiro-cli');
  assert.equal(seen[1].hostHomeDir, '/host');
});
