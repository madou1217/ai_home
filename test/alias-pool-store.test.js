'use strict';

// 账号级「是否进入别名自动选号池」的持久化边界。
// 默认参与（没有记录 = true），显式 false 才是退出；写入前必须能解析到真实账号。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ALIAS_POOL_KEY_PREFIX,
  buildAliasPoolConfigKey,
  normalizeAliasPoolConfig,
  readAliasPoolConfig,
  readAliasPoolParticipationMap,
  writeAliasPoolConfig
} = require('../lib/account/alias-pool-store');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeJsonValue } = require('../lib/server/app-state-store');

function createFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-alias-pool-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: 'oauth:codex:alias-pool@example.com'
  });
  assert.ok(accountRef);
  return { aiHomeDir, accountRef };
}

test('没有记录的账号默认参与别名选号', (t) => {
  const { aiHomeDir, accountRef } = createFixture(t);
  assert.equal(readAliasPoolConfig(fs, aiHomeDir, accountRef), null);
  const map = readAliasPoolParticipationMap(fs, aiHomeDir);
  assert.equal(map.size, 0);
  // 调用方用 Map.has 判定：没有条目 = 走默认 true。
  assert.equal(map.has(accountRef), false);
});

test('写入 false 后读取得到退出状态，并出现在批量映射里', (t) => {
  const { aiHomeDir, accountRef } = createFixture(t);
  assert.equal(
    writeAliasPoolConfig(fs, aiHomeDir, accountRef, { participates: false }, 1700000000000),
    true
  );
  const config = readAliasPoolConfig(fs, aiHomeDir, accountRef);
  assert.deepEqual(config, { participates: false, updatedAt: 1700000000000 });
  const map = readAliasPoolParticipationMap(fs, aiHomeDir);
  assert.equal(map.get(accountRef), false);
});

test('显式 true 是可读记录，删除后回到默认参与', (t) => {
  const { aiHomeDir, accountRef } = createFixture(t);
  writeAliasPoolConfig(fs, aiHomeDir, accountRef, { participates: true }, 1700000000001);
  assert.deepEqual(
    readAliasPoolConfig(fs, aiHomeDir, accountRef),
    { participates: true, updatedAt: 1700000000001 }
  );

  writeAliasPoolConfig(fs, aiHomeDir, accountRef, null);
  assert.equal(readAliasPoolConfig(fs, aiHomeDir, accountRef), null);
  assert.equal(readAliasPoolParticipationMap(fs, aiHomeDir).size, 0);
});

test('账号位无法解析时写入失败而不是落一条孤儿配置', (t) => {
  const { aiHomeDir } = createFixture(t);
  assert.throws(
    () => writeAliasPoolConfig(fs, aiHomeDir, 'acct_ffffffffffffffffffff', { participates: false }),
    /invalid_alias_pool_account/
  );
  assert.equal(readAliasPoolParticipationMap(fs, aiHomeDir).size, 0);
});

test('批读取跳过形状不合法或账号位非法的记录', (t) => {
  const { aiHomeDir, accountRef } = createFixture(t);
  // 直接写库：模拟旧版本/手改数据。
  writeJsonValue(fs, aiHomeDir, buildAliasPoolConfigKey(accountRef), { participates: false });
  writeJsonValue(fs, aiHomeDir, `${ALIAS_POOL_KEY_PREFIX}not-an-account-ref`, { participates: false });
  writeJsonValue(fs, aiHomeDir, `${ALIAS_POOL_KEY_PREFIX}acct_1111111111111111aaaa`, 'garbage');

  const map = readAliasPoolParticipationMap(fs, aiHomeDir);
  assert.deepEqual([...map.keys()], [accountRef]);
  assert.equal(map.get(accountRef), false);
});

test('单条读取遇到损坏记录显式报错', (t) => {
  const { aiHomeDir, accountRef } = createFixture(t);
  writeJsonValue(fs, aiHomeDir, buildAliasPoolConfigKey(accountRef), 'garbage');
  assert.throws(
    () => readAliasPoolConfig(fs, aiHomeDir, accountRef),
    /invalid_alias_pool_config_record/
  );
});

test('配置归一化只认对象，缺省字段按参与处理', () => {
  assert.equal(normalizeAliasPoolConfig(null), null);
  assert.equal(normalizeAliasPoolConfig([]), null);
  assert.equal(normalizeAliasPoolConfig('x'), null);
  assert.deepEqual(normalizeAliasPoolConfig({}), { participates: true, updatedAt: 0 });
  assert.deepEqual(
    normalizeAliasPoolConfig({ participates: false, updatedAt: '1700000000000.9' }),
    { participates: false, updatedAt: 1700000000000 }
  );
  assert.equal(buildAliasPoolConfigKey('not-a-ref'), '');
});
