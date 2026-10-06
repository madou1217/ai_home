'use strict';

// 长寿 Codex 线程会在不同作用域下续跑（先按账号、后走网关，或反过来）。转写文件里的
// 用量行只能归属给「写入它时」的作用域：
//   - since 之后的行跟随当前作用域，网关作用域不归属任何账号（网关已按实际账号记账）；
//   - since 之前的行保留原有归属，重建也不能回改；
//   - 注册表查不到线程时保留历史归属。
// 2026-10-06 真实事故：一个 09-05 的线程在 09-30 按账号续跑后被整份归给该账号，
// 之后改走网关的每一轮仍被记到这个账号（已变 free），与网关记录重复计数。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { __private: scannerPrivate } = require('../lib/usage/model-usage-scanner');
const { openModelUsageStore } = require('../lib/usage/model-usage-store');
const { createCodexSessionOwnershipIndex } = require('../lib/usage/codex-session-ownership');

const ACCOUNT_OLD = 'acct_0123456789abcdef0123';
const ACCOUNT_NEW = 'acct_1123456789abcdef0123';
const THREAD = '019f698a-a7b0-7041-b4a2-41cfb5f0de60';
const THREAD_ACCOUNT = '019f698a-a7b0-7041-b4a2-41cfb5f0de61';
const THREAD_MIXED = '019f698a-a7b0-7041-b4a2-41cfb5f0de62';
const THREAD_MISSING = '019f698a-a7b0-7041-b4a2-41cfb5f0de63';
const T0 = Date.parse('2026-10-01T00:00:00Z');
const MINUTE = 60_000;

function requireDatabaseSync(t) {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return null;
  }
}

// 一条用量行：累计用量逐次递增，扫描器据此算出单次增量。
function usageLine(minute, cumulativeInput) {
  return {
    timestamp: new Date(T0 + minute * MINUTE).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: cumulativeInput, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
        last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }
      }
    }
  };
}

function setup(t) {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-scoped-attribution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'rollout.jsonl');
  const header = [
    { timestamp: new Date(T0).toISOString(), type: 'session_meta', payload: { id: THREAD, cwd: '/work/long' } },
    { timestamp: new Date(T0).toISOString(), type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }
  ];
  fs.writeFileSync(filePath, `${header.map((row) => JSON.stringify(row)).join('\n')}\n`);
  let cumulative = 0;
  const append = (minute) => {
    cumulative += 10;
    fs.appendFileSync(filePath, `${JSON.stringify(usageLine(minute, cumulative))}\n`);
  };
  const store = openModelUsageStore({ fs, path, aiHomeDir: path.join(root, '.ai_home'), DatabaseSync });
  t.after(() => store.close());
  const scan = (ownership) => scannerPrivate.scanCodexFile({
    fs,
    path,
    store,
    filePath,
    resolveOwnership: () => ownership
  });
  const accountsByMinute = () => store.db.prepare(
    'SELECT timestamp_ms, account_ref FROM model_usage_records WHERE session_id = ? ORDER BY timestamp_ms'
  ).all(THREAD).map((row) => [Math.round((row.timestamp_ms - T0) / MINUTE), row.account_ref]);
  return { store, filePath, append, scan, accountsByMinute };
}

const accountScope = (accountRef, sinceMinute) => ({ accountRef, gateway: false, since: T0 + sinceMinute * MINUTE });
const gatewayScope = (sinceMinute) => ({ accountRef: '', gateway: true, since: T0 + sinceMinute * MINUTE });
const unknownScope = { accountRef: '', gateway: false, since: 0 };

test('lines written after a thread turns gateway-scoped are not attributed to the old account', (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.append(1);
  ctx.append(2);
  ctx.scan(accountScope(ACCOUNT_OLD, 0));
  ctx.append(10);
  ctx.append(11);
  ctx.scan(gatewayScope(5));

  assert.deepEqual(ctx.accountsByMinute(), [[1, ACCOUNT_OLD], [2, ACCOUNT_OLD], [10, ''], [11, '']]);
  assert.equal(ctx.store.getFileState(ctx.filePath).scanContext.attributedAccountRef, '');
});

test('the gateway transition also clears lines already scanned under the stale account', (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.append(1);
  ctx.scan(accountScope(ACCOUNT_OLD, 0));
  // 线程已改走网关，但扫描器还没看到网关注册项，就按旧账号扫了这两行。
  ctx.append(10);
  ctx.append(11);
  ctx.scan(unknownScope);
  assert.deepEqual(ctx.accountsByMinute(), [[1, ACCOUNT_OLD], [10, ACCOUNT_OLD], [11, ACCOUNT_OLD]]);

  ctx.scan(gatewayScope(5));
  assert.deepEqual(ctx.accountsByMinute(), [[1, ACCOUNT_OLD], [10, ''], [11, '']]);
});

test('no registry entry keeps the stored attribution', (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.append(1);
  ctx.scan(accountScope(ACCOUNT_OLD, 0));
  ctx.append(2);
  ctx.scan(unknownScope);

  assert.deepEqual(ctx.accountsByMinute(), [[1, ACCOUNT_OLD], [2, ACCOUNT_OLD]]);
});

test('a new account owner re-attributes only lines after its launch', (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.append(1);
  ctx.scan(accountScope(ACCOUNT_OLD, 0));
  ctx.append(10);
  ctx.scan(gatewayScope(5));
  ctx.append(20);
  ctx.append(21);
  ctx.scan(unknownScope);
  ctx.scan(accountScope(ACCOUNT_NEW, 15));

  assert.deepEqual(ctx.accountsByMinute(), [[1, ACCOUNT_OLD], [10, ''], [20, ACCOUNT_NEW], [21, ACCOUNT_NEW]]);
  assert.equal(ctx.store.getFileState(ctx.filePath).scanContext.attributedAccountRef, ACCOUNT_NEW);
});

test('ownership index reports gateway scope and the launch time', () => {
  const index = createCodexSessionOwnershipIndex({
    aiHomeDir: '/tmp/aih-test',
    registry: {
      listEntries() {
        return [
          { provider: 'codex', gateway: true, accountRef: '', nativeSessionId: THREAD, createdAt: 500 },
          { provider: 'codex', accountRef: ACCOUNT_OLD, nativeSessionId: THREAD_ACCOUNT, createdAt: 300 },
          { provider: 'codex', accountRef: ACCOUNT_OLD, nativeSessionId: THREAD_MIXED, createdAt: 100 },
          { provider: 'codex', gateway: true, accountRef: '', nativeSessionId: THREAD_MIXED, createdAt: 200 }
        ];
      }
    }
  });

  assert.deepEqual(index.resolveOwnership(THREAD), { accountRef: '', gateway: true, since: 500 });
  assert.deepEqual(index.resolveOwnership(THREAD_ACCOUNT), { accountRef: ACCOUNT_OLD, gateway: false, since: 300 });
  assert.deepEqual(index.resolveOwnership(THREAD_MIXED), { accountRef: '', gateway: false, since: 0 });
  assert.deepEqual(index.resolveOwnership(THREAD_MISSING), { accountRef: '', gateway: false, since: 0 });
  assert.equal(index.resolveAccountRef(THREAD), '');
  assert.equal(index.resolveAccountRef(THREAD_ACCOUNT), ACCOUNT_OLD);
});
