'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openModelUsageStore } = require('../lib/usage/model-usage-store');
const {
  discoverCodebuddyUsageFiles,
  scanCodebuddyUsageFile
} = require('../lib/usage/codebuddy-model-usage-scanner');
const { stableHash } = require('../lib/usage/model-usage-stable-hash');
const { __private: scannerPrivate } = require('../lib/usage/model-usage-scanner');
const { buildAccountOutcomesView } = require('../lib/server/account-outcomes-view');

const SESSION_ID = '01a1a0eb-d350-7449-ba39-d9487becf888';
const ACCOUNT_REF = 'acct_0123456789abcdef0123';

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codebuddy-usage-'));
  const home = path.join(root, 'home');
  const aiHome = path.join(root, 'aihome');
  fs.mkdirSync(path.join(home, '.codebuddy', 'projects', 'p1'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codebuddy-cn', 'projects', 'p1'), { recursive: true });
  fs.mkdirSync(aiHome, { recursive: true });
  return { root, home, aiHome };
}

function writeSession(home, entries) {
  const filePath = path.join(home, '.codebuddy', 'projects', 'p1', SESSION_ID + '.jsonl');
  fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  // 同族两个站点共享同一份物理会话：硬链接，模拟真实 .codebuddy / .codebuddy-cn。
  fs.linkSync(filePath, path.join(home, '.codebuddy-cn', 'projects', 'p1', SESSION_ID + '.jsonl'));
  return filePath;
}

function stubOwnership() {
  return {
    fingerprint: 'fingerprint',
    writerFingerprint: () => 'writer',
    resolveNative: () => ({ provider: 'codebuddy', accountRef: ACCOUNT_REF, userId: 'u1' }),
    normalizeScope: () => null,
    resolve: () => ({ provider: 'codebuddy', accountRef: ACCOUNT_REF })
  };
}

test('CodeBuddy 会话按物理文件去重：硬链接的两个站点只扫一次', () => {
  const { root, home, aiHome } = makeWorkspace();
  try {
    writeSession(home, [
      { id: 'm1', type: 'message', role: 'assistant', timestamp: 1793700000000, sessionId: SESSION_ID,
        providerData: { model: 'deepseek-v4.1-flash', rawUsage: { prompt_tokens: 100, completion_tokens: 20 } } }
    ]);
    const files = discoverCodebuddyUsageFiles({
      fs, path, hostHomeDir: home, providers: ['codebuddy', 'codebuddycn']
    });
    assert.equal(files.length, 1);
    assert.equal(files[0].sessionId, SESSION_ID);
    assert.ok(fs.existsSync(aiHome));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('扫描派生用量与健康结果，重复扫描幂等', () => {
  const { root, home, aiHome } = makeWorkspace();
  const store = openModelUsageStore({ fs, aiHomeDir: aiHome });
  try {
    writeSession(home, [
      { id: 'm1', type: 'message', role: 'assistant', timestamp: 1793700000000, sessionId: SESSION_ID,
        providerData: { model: 'deepseek-v4.1-flash', rawUsage: { prompt_tokens: 100, completion_tokens: 20 } } },
      { id: 'm2', type: 'message', role: 'assistant', timestamp: 1793700100000, sessionId: SESSION_ID,
        providerData: { error: { message: '429 usage exceeds frequency limit', isRetryable: true } } },
      { id: 'm3', type: 'message', role: 'user', timestamp: 1793700050000, sessionId: SESSION_ID }
    ]);
    const files = discoverCodebuddyUsageFiles({
      fs, path, hostHomeDir: home, providers: ['codebuddy', 'codebuddycn']
    });
    const ownership = stubOwnership();
    const first = scanCodebuddyUsageFile({
      fs, path, store, file: files[0], ownership,
      readJsonlFromOffset: scannerPrivate.readJsonlFromOffset
    });
    assert.deepEqual(first, { records: 1, prompts: 1, outcomes: 2 });
    const second = scanCodebuddyUsageFile({
      fs, path, store, file: files[0], ownership,
      readJsonlFromOffset: scannerPrivate.readJsonlFromOffset
    });
    assert.deepEqual(second, { records: 0, prompts: 0, outcomes: 0 });

    const outcomes = store.queryNativeOutcomes(0);
    assert.deepEqual(outcomes.map((row) => row.outcome).sort(), ['rate_limited', 'success']);
    assert.ok(outcomes.every((row) => row.account_ref === ACCOUNT_REF && row.provider === 'codebuddy'));
  } finally {
    if (store) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('扫描时清理同会话同消息的跨站点重复行', () => {
  const { root, home, aiHome } = makeWorkspace();
  const store = openModelUsageStore({ fs, aiHomeDir: aiHome });
  try {
    const filePath = writeSession(home, [
      { id: 'm1', type: 'message', role: 'assistant', timestamp: 1793700000000, sessionId: SESSION_ID,
        providerData: { model: 'deepseek-v4.1-flash', rawUsage: { prompt_tokens: 100, completion_tokens: 20 } } }
    ]);
    const duplicateKey = `codebuddy:message:${'b'.repeat(16)}:${stableHash('m1')}:usage`;
    store.db.prepare(`
      INSERT INTO model_usage_records (event_key, provider, session_id, model, total_tokens, timestamp_ms, created_at_ms)
      VALUES (?, 'codebuddycn', ?, 'deepseek-v4.1-flash', 120, ?, ?)
    `).run(duplicateKey, SESSION_ID, 1793700000000, Date.now());

    const files = discoverCodebuddyUsageFiles({
      fs, path, hostHomeDir: home, providers: ['codebuddy', 'codebuddycn']
    });
    // 强制从头重建，让 m1 重新进入 reconcile（真实场景由 PROJECTION_VERSION 升级触发）。
    store.setFileState(filePath, { size: 0, offset: 0, scanContext: null });
    scanCodebuddyUsageFile({
      fs, path, store, file: files[0], ownership: stubOwnership(),
      readJsonlFromOffset: scannerPrivate.readJsonlFromOffset
    });

    const rows = store.db.prepare('SELECT provider, event_key FROM model_usage_records').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider, 'codebuddy');
    assert.notEqual(rows[0].event_key, duplicateKey);
  } finally {
    if (store) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('健康视图合并原生会话结果到账号的日/小时桶', () => {
  const nowMs = Date.now();
  const at = nowMs - 60 * 1000;
  const view = buildAccountOutcomesView({
    nodeAccountRefs: [ACCOUNT_REF],
    nativeRows: [
      { account_ref: ACCOUNT_REF, outcome: 'success', timestamp_ms: at },
      { account_ref: ACCOUNT_REF, outcome: 'rate_limited', timestamp_ms: at }
    ],
    nowMs
  });
  assert.equal(view.accounts.length, 1);
  const account = view.accounts[0];
  assert.equal(account.accountRef, ACCOUNT_REF);
  const day = account.days[0];
  assert.equal(day.success, 1);
  assert.equal(day.failures.rate_limited, 1);
  const hour = account.hours[0];
  assert.equal(hour.success, 1);
  assert.equal(hour.failures.rate_limited, 1);
});
