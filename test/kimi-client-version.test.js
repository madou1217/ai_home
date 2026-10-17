'use strict';

// kimi 客户端版本的动态解析：三级顺序、缓存 TTL、失败不污染缓存。
//
// 为什么值得测：自报版本是上游识别客户端代际的依据。此前它被硬编码成 '0.36.0'，
// 而本机真实 CLI 已是 2.2.0 —— 差 6 个大版本。写死会让「本机 CLI 升级」与
// 「上游按版本下发能力」之间永久漂移。

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  KIMI_CODE_VERSION_FALLBACK,
  compareKimiClientVersions,
  detectLocalKimiClientVersion,
  fetchLatestKimiClientVersion,
  getKimiClientVersionSync,
  parseKimiClientVersion,
  refreshKimiClientVersion,
  resetKimiClientVersionCacheForTest
} = require('../lib/server/kimi-client-version');

test('parseKimiClientVersion extracts the three-part version from CLI output', () => {
  assert.equal(parseKimiClientVersion('kimi-code-cli 2.2.0'), '2.2.0');
  assert.equal(parseKimiClientVersion('2.2.0\n'), '2.2.0');
  assert.equal(parseKimiClientVersion('no version here'), '');
  assert.equal(parseKimiClientVersion(''), '');
  assert.equal(parseKimiClientVersion(null), '');
});

test('compareKimiClientVersions orders three-part versions', () => {
  assert.equal(compareKimiClientVersions('2.2.0', '2.2.0'), 0);
  assert.equal(compareKimiClientVersions('0.36.0', '2.2.0'), -1);
  assert.equal(compareKimiClientVersions('2.2.0', '0.36.0'), 1);
  assert.equal(compareKimiClientVersions('2.10.0', '2.9.0'), 1, '按段比较而非字典序');
});

test('explicit version wins over probing', () => {
  const detected = detectLocalKimiClientVersion({ kimiClientVersion: '9.9.9' });
  assert.equal(detected, '9.9.9');
});

test('probe failure returns empty instead of throwing', () => {
  // 「这台机器没装 CLI」是正常情况，不是错误 —— 调用方据此走下一档。
  const detected = detectLocalKimiClientVersion({
    execFileSync: () => { throw new Error('ENOENT'); }
  });
  assert.equal(detected, '');
});

test('probe parses a successful exec', () => {
  const detected = detectLocalKimiClientVersion({
    execFileSync: () => 'kimi-code-cli 3.1.4\n'
  });
  assert.equal(detected, '3.1.4');
});

test('sync resolver prefers the local CLI version', () => {
  resetKimiClientVersionCacheForTest();
  const version = getKimiClientVersionSync({ execFileSync: () => 'kimi-code-cli 4.5.6' });
  assert.equal(version, '4.5.6');
  resetKimiClientVersionCacheForTest();
});

test('sync resolver falls back to the constant when nothing is available', () => {
  resetKimiClientVersionCacheForTest();
  const version = getKimiClientVersionSync({
    execFileSync: () => { throw new Error('ENOENT'); }
  });
  assert.equal(version, KIMI_CODE_VERSION_FALLBACK, '本地与远端都不可用时用兜底常量');
  resetKimiClientVersionCacheForTest();
});

test('remote lookup returns empty on any failure instead of throwing', async () => {
  // 网络抖动不该被当成「上游没有新版」。
  const cases = [
    { fetchImpl: null },
    { fetchImpl: async () => ({ ok: false }) },
    { fetchImpl: async () => { throw new Error('network'); } },
    { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }
  ];
  for (const options of cases) {
    assert.equal(await fetchLatestKimiClientVersion(options), '');
  }
});

test('remote lookup parses the registry payload', async () => {
  const version = await fetchLatestKimiClientVersion({
    fetchImpl: async (url) => {
      // npm 的 scoped 包名必须把 `/` 编码成 %2F，否则 registry 返回 404。
      assert.match(String(url), /moonshot-ai%2Fkimi-code/, '必须查 kimi 的包名（scoped 路径要编码）');
      return { ok: true, json: async () => ({ version: '5.6.7' }) };
    }
  });
  assert.equal(version, '5.6.7');
});

test('refresh keeps the previous cache when the lookup fails', async () => {
  resetKimiClientVersionCacheForTest();
  // 先成功一次，建立缓存。
  await refreshKimiClientVersion({
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: '7.8.9' }) })
  });
  // 再失败一次：缓存必须保留，不能因为一次网络抖动退回兜底常量。
  const kept = await refreshKimiClientVersion({ fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(kept, '7.8.9', '失败时保留原缓存');

  // 本地没有 CLI 时，同步解析走远端缓存。
  const version = getKimiClientVersionSync({ execFileSync: () => { throw new Error('ENOENT'); } });
  assert.equal(version, '7.8.9');
  resetKimiClientVersionCacheForTest();
});

test('remote lookup does not require a locally installed CLI', async () => {
  // 这一档存在的理由：没装客户端也能跟进上游新版。
  resetKimiClientVersionCacheForTest();
  const version = await refreshKimiClientVersion({
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: '8.0.0' }) })
  });
  assert.equal(version, '8.0.0');
  resetKimiClientVersionCacheForTest();
});
