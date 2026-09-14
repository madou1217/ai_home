'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  HISTORY_LIMIT,
  SCHEMA_VERSION,
  ledgerPath,
  emptyLedger,
  readLedger,
  writeLedger,
  readProviderRecord,
  writeProviderRecord,
  appendHistory
} = require('../lib/server/provider-cli-upgrade/upgrade-ledger');
const {
  classifyInstallFailure,
  CATEGORIES
} = require('../lib/server/provider-cli-upgrade/upgrade-error-classifier');

function makeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-upgrade-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('账本写入走 tmp+rename,读回一致且文件权限私有', (t) => {
  const home = makeHome(t);
  const ledger = writeProviderRecord(emptyLedger(), 'codex', { installedVersion: '0.154.0' });

  assert.equal(writeLedger(home, ledger), true);
  const target = ledgerPath(home);
  assert.equal(fs.existsSync(`${target}.tmp`), false, 'tmp 文件不该残留');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(readProviderRecord(readLedger(home), 'codex').installedVersion, '0.154.0');
});

// 账本读不出来不该拖垮 server 启动，一律回落默认值。
test('账本损坏或不存在时回落默认值且不抛', (t) => {
  const home = makeHome(t);
  assert.deepEqual(readLedger(home), emptyLedger());

  fs.mkdirSync(path.dirname(ledgerPath(home)), { recursive: true });
  fs.writeFileSync(ledgerPath(home), '{ not json');
  assert.deepEqual(readLedger(home), emptyLedger());

  fs.writeFileSync(ledgerPath(home), '[]');
  assert.deepEqual(readLedger(home), emptyLedger());
});

// 未来版本写的账本不要强行解读：按错误语义动手升级比从头来过危险得多。
test('schemaVersion 不匹配时视作空账本', (t) => {
  const home = makeHome(t);
  fs.mkdirSync(path.dirname(ledgerPath(home)), { recursive: true });
  fs.writeFileSync(ledgerPath(home), JSON.stringify({
    schemaVersion: SCHEMA_VERSION + 1,
    providers: { codex: { installedVersion: '9.9.9' } }
  }));

  assert.deepEqual(readLedger(home), emptyLedger());
});

test('记录读取带默认值,数组是副本不会被外部改坏', () => {
  const ledger = writeProviderRecord(emptyLedger(), 'codex', { blockedVersions: ['0.1.0'] });
  const record = readProviderRecord(ledger, 'codex');
  record.blockedVersions.push('mutated');

  assert.deepEqual(readProviderRecord(ledger, 'codex').blockedVersions, ['0.1.0']);
  assert.equal(readProviderRecord(ledger, 'missing').state, 'unknown');
  assert.equal(readProviderRecord(ledger, 'missing').knownGoodRollbackable, false);
});

test('history 按上限截断,保留最近的', () => {
  let record = readProviderRecord(emptyLedger(), 'codex');
  for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
    record = { ...record, history: appendHistory(record, { at: i }) };
  }
  const ledger = writeProviderRecord(emptyLedger(), 'codex', record);
  const history = readProviderRecord(ledger, 'codex').history;

  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(history.at(-1).at, HISTORY_LIMIT + 4);
});

// 分类决定「算不算熔断」。lock_busy 与 network 必须排除在外，
// 否则常年繁忙或走代理的机器会把熔断额度烧光，功能带着绿仪表盘静默自停。
test('安装失败分类:只有 hard_failure 计入熔断', () => {
  const cases = [
    ["EPERM: operation not permitted, unlink 'C:\\x\\codex.exe'", CATEGORIES.LOCK_BUSY, false],
    ['EBUSY: resource busy or locked', CATEGORIES.LOCK_BUSY, false],
    ['The process cannot access the file because it is being used by another process', CATEGORIES.LOCK_BUSY, false],
    ['npm error code E404 - No matching version found for @openai/codex@9.9.9', CATEGORIES.NOT_FOUND, false],
    ['request to https://registry.npmjs.org failed, reason getaddrinfo ENOTFOUND', CATEGORIES.NETWORK, false],
    ['tunneling socket could not be established, 407', CATEGORIES.NETWORK, false],
    ['checksum mismatch while installing', CATEGORIES.HARD_FAILURE, true]
  ];

  for (const [stderr, expected, counts] of cases) {
    const result = classifyInstallFailure({ stderr });
    assert.equal(result.category, expected, stderr);
    assert.equal(result.countsTowardBreaker, counts, stderr);
  }
});

// not_found 的文案里常带 registry 字样，顺序必须让它先于 network 命中。
test('版本不存在优先于网络类判定', () => {
  const result = classifyInstallFailure({
    stderr: 'npm error 404 Not Found - GET https://registry.npmjs.org/@openai/codex - version not found'
  });
  assert.equal(result.category, CATEGORIES.NOT_FOUND);
});
