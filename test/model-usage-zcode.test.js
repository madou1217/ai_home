'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeAccountCredentials, writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const { openModelUsageStore } = require('../lib/usage/model-usage-store');
const {
  scanModelUsageSources,
  __private: {
    discoverZcodeUsageFile,
    readZcodeDbChangeFingerprint,
    scanZcodeUsageFile
  }
} = require('../lib/usage/model-usage-scanner');
const { resolveZcodeUsageAttribution } = require('../lib/usage/zcode-session-ownership');

function zcodeDbPath(root) {
  return path.join(root, '.zcode', 'cli', 'db', 'db.sqlite');
}

function createZcodeTestDb(dbPath, options = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      directory TEXT NOT NULL,
      path TEXT,
      title TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_usage (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      provider_total_tokens INTEGER,
      computed_total_tokens INTEGER NOT NULL DEFAULT 0,
      parent_user_message_id TEXT
    );
  `);

  for (const s of options.sessions || []) {
    db.prepare(`
      INSERT INTO session (id, directory, path, title, time_created, time_updated)
      VALUES (?, ?, NULL, ?, ?, ?)
    `).run(s.id, s.directory, s.title || s.id, s.timeCreated, s.timeUpdated || s.timeCreated);
  }

  for (const u of options.usage || []) {
    db.prepare(`
      INSERT INTO model_usage (
        id, session_id, model_id, status, started_at, completed_at,
        input_tokens, output_tokens, reasoning_tokens,
        cache_creation_input_tokens, cache_read_input_tokens,
        provider_total_tokens, computed_total_tokens, parent_user_message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      u.id,
      u.sessionId,
      u.modelId,
      u.status || 'completed',
      u.startedAt,
      u.completedAt || null,
      u.inputTokens || 0,
      u.outputTokens || 0,
      u.reasoningTokens || 0,
      u.cacheCreation || 0,
      u.cacheRead || 0,
      u.providerTotal || null,
      u.computedTotal || 0,
      u.parentUserMessageId || null
    );
  }

  db.close();
}

function setupZcodeAccount(aiHomeDir, options = {}) {
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: options.cliAccountId || '1',
    identitySeed: `test:zcode:usage:${options.seed || Math.random().toString(36).slice(2)}`
  });
  if (options.apiKey) {
    writeAccountCredentials(fs, aiHomeDir, accountRef, { ZCODE_API_KEY: options.apiKey });
  } else {
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
      credentials: { zcodejwttoken: 'jwt' }
    });
  }
  return accountRef;
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-usage-'));
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  return { root, aiHomeDir };
}

test('discoverZcodeUsageFile finds only the shared host zcode db', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-discover-'));
  assert.deepEqual(discoverZcodeUsageFile({ fs, path, hostHomeDir: root }), [], '库不存在时返回空');

  const dbPath = zcodeDbPath(root);
  createZcodeTestDb(dbPath, {});
  assert.deepEqual(discoverZcodeUsageFile({ fs, path, hostHomeDir: root }), [dbPath]);
});

test('scanZcodeUsageFile records attributed usage rows and skips zero-token rows', () => {
  const { root, aiHomeDir } = makeRoot();
  const store = openModelUsageStore({ fs, path, aiHomeDir, DatabaseSync });
  const dbPath = zcodeDbPath(root);
  createZcodeTestDb(dbPath, {
    sessions: [
      { id: 'sess-1', directory: '/Users/model/projects/demo', title: '熟悉当前项目', timeCreated: 1787300000000, timeUpdated: 1787300100000 }
    ],
    usage: [
      {
        id: 'usage-1',
        sessionId: 'sess-1',
        modelId: 'GLM-5.3',
        startedAt: 1787300001000,
        completedAt: 1787300007000,
        inputTokens: 269347,
        outputTokens: 241,
        cacheRead: 268800,
        computedTotal: 269588,
        parentUserMessageId: 'msg-user-1'
      },
      {
        id: 'usage-retry-1',
        sessionId: 'sess-1',
        modelId: 'GLM-5.3',
        status: 'error',
        startedAt: 1787300008000,
        inputTokens: 0,
        outputTokens: 0
      },
      {
        id: 'usage-zero',
        sessionId: 'sess-1',
        modelId: 'GLM-5.3',
        startedAt: 1787300009000,
        inputTokens: 0,
        outputTokens: 0,
        computedTotal: 0
      }
    ]
  });
  const oauthRef = setupZcodeAccount(aiHomeDir);
  const scan = scanZcodeUsageFile({
    fs,
    path,
    store,
    filePath: dbPath,
    accountRef: oauthRef,
    DatabaseSync
  });
  assert.equal(scan.records, 1, '零 token 行跳过，只记 usage-1');
  assert.equal(scan.prompts, 1, 'parent_user_message_id 派生 prompt 事件');

  const stats = store.queryStats({ provider: 'zcode' });
  assert.equal(stats.totalCalls, 1);
  assert.equal(stats.totalPrompts, 1);
  assert.equal(stats.inputTokens, 269347);
  assert.equal(stats.cacheReadInputTokens, 268800);
  assert.equal(stats.totalTokens, 269588);

  const sessions = store.querySessions({ provider: 'zcode' });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'sess-1');
  assert.equal(sessions[0].promptCount, 1, 'prompt 数按 distinct parent_user_message_id 统计');

  const accountUsage = store.queryAccountTokenUsage({});
  const account = accountUsage[oauthRef];
  assert.ok(account, '归属账号进入柱状图聚合');
  assert.equal(account.total, 269588);
  assert.equal(account.models[0].model, 'glm-5.3', '模型 ID 归一化为小写');
  assert.equal(account.models[0].total, 269588);

  store.close();
});

test('scanZcodeUsageFile rescan is incremental and dedups by event key', () => {
  const { root, aiHomeDir } = makeRoot();
  const store = openModelUsageStore({ fs, path, aiHomeDir, DatabaseSync });
  const dbPath = zcodeDbPath(root);
  createZcodeTestDb(dbPath, {
    sessions: [{ id: 'sess-1', directory: '/repo', timeCreated: 1787300000000 }],
    usage: [
      { id: 'usage-1', sessionId: 'sess-1', modelId: 'GLM-5.3', startedAt: 1787300001000, inputTokens: 10, outputTokens: 5, computedTotal: 15 }
    ]
  });

  const first = scanZcodeUsageFile({ fs, path, store, filePath: dbPath, accountRef: 'acct_aa000000000000000001', DatabaseSync });
  assert.equal(first.records, 1);

  const fingerprint = readZcodeDbChangeFingerprint(fs, dbPath);
  store.setFileState(dbPath, { size: fingerprint.size, offset: fingerprint.size, scanContext: { mtimeMs: fingerprint.mtimeMs } });
  const skipped = scanZcodeUsageFile({ fs, path, store, filePath: dbPath, accountRef: 'acct_aa000000000000000001', DatabaseSync });
  assert.equal(skipped.records, 0, '指纹未变化时跳过');

  // 追加新 usage 行（主库 mtime 变化）+ 伪造 -wal 增长，重扫时按行级游标只取增量、
  // 旧行按 event_key 去重；旧行事后被修改也不回读（游标语义，幂等优先）。
  const reopen = new DatabaseSync(dbPath);
  reopen.exec(`
    INSERT INTO model_usage (id, session_id, model_id, status, started_at, input_tokens, output_tokens, computed_total_tokens)
      VALUES ('usage-2', 'sess-1', 'GLM-5.3', 'completed', 1787300002000, 7, 3, 10);
    UPDATE model_usage SET input_tokens = 999, computed_total_tokens = 1004 WHERE id = 'usage-1';
  `);
  reopen.close();
  fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(4096, 1));

  const second = scanZcodeUsageFile({ fs, path, store, filePath: dbPath, accountRef: 'acct_aa000000000000000001', DatabaseSync });
  assert.equal(second.records, 1, '游标增量：只新增 usage-2，旧行修改不回读');

  const stats = store.queryStats({ provider: 'zcode' });
  assert.equal(stats.totalCalls, 2);
  assert.equal(stats.totalTokens, 25, 'usage-1 保持首次扫描值 15 + usage-2 的 10');
  store.close();
});

test('resolveZcodeUsageAttribution: single oauth wins, api-key excluded, multi oauth degrades', () => {
  const { root, aiHomeDir } = makeRoot();

  // 0 个 zcode 账号
  assert.deepEqual(
    resolveZcodeUsageAttribution({ fs, aiHomeDir }),
    { accountRef: '', mode: 'none', oauthAccountCount: 0, unreadableAccountCount: 0 }
  );

  // 1 个 OAuth + 1 个 api-key：api-key 不算共享库写入者，仍精确归属 OAuth
  const oauthRef = setupZcodeAccount(aiHomeDir, { seed: 'one' });
  setupZcodeAccount(aiHomeDir, { seed: 'two', apiKey: 'sk-key', cliAccountId: '2' });
  assert.deepEqual(
    resolveZcodeUsageAttribution({ fs, aiHomeDir }),
    { accountRef: oauthRef, mode: 'single', oauthAccountCount: 1, unreadableAccountCount: 0 }
  );

  // 2 个 OAuth：共享库无法区分写入者，诚实降级为未归属
  setupZcodeAccount(aiHomeDir, { seed: 'three', cliAccountId: '3' });
  assert.deepEqual(
    resolveZcodeUsageAttribution({ fs, aiHomeDir }),
    { accountRef: '', mode: 'ambiguous', oauthAccountCount: 2, unreadableAccountCount: 0 }
  );
});

test('resolveZcodeUsageAttribution skips accounts whose credentials cannot be read', () => {
  const { root, aiHomeDir } = makeRoot();
  const oauthRef = setupZcodeAccount(aiHomeDir, { seed: 'readable' });
  setupZcodeAccount(aiHomeDir, { seed: 'broken', cliAccountId: '2' });

  // 第二个账号凭据读取抛错：按「无法分类」跳过，不得被误算成第二个 OAuth
  // 而把归属打成 ambiguous（丢失柱状图）。
  const resolved = resolveZcodeUsageAttribution({
    fs,
    aiHomeDir,
    readCredentialRecord: (fsImpl, dir, accountRef) => {
      if (String(accountRef) === oauthRef) {
        return { env: {}, nativeAuth: {} };
      }
      throw new Error('credential_read_failed');
    }
  });
  assert.deepEqual(
    resolved,
    { accountRef: oauthRef, mode: 'single', oauthAccountCount: 1, unreadableAccountCount: 1 }
  );
});

test('scanModelUsageSources dispatches zcode via the usage_scan capability', () => {
  const { root, aiHomeDir } = makeRoot();
  const store = openModelUsageStore({ fs, path, aiHomeDir, DatabaseSync });
  const dbPath = zcodeDbPath(root);
  createZcodeTestDb(dbPath, {
    sessions: [{ id: 'sess-1', directory: '/repo', timeCreated: 1787300000000 }],
    usage: [
      { id: 'usage-1', sessionId: 'sess-1', modelId: 'GLM-5.3', startedAt: 1787300001000, inputTokens: 100, outputTokens: 40, computedTotal: 140 }
    ]
  });
  const dispatchRef = setupZcodeAccount(aiHomeDir, { seed: 'dispatch' });

  const result = scanModelUsageSources({
    fs,
    path,
    store,
    hostHomeDir: root,
    aiHomeDir,
    providers: ['zcode'],
    DatabaseSync
  });

  assert.equal(result.providers.zcode.attributionMode, 'single');
  assert.equal(result.providers.zcode.attributionAccountCount, 1);
  assert.equal(result.providers.zcode.records, 1);
  assert.equal(result.records, 1);

  const accountUsage = store.queryAccountTokenUsage({});
  assert.equal(accountUsage[dispatchRef].total, 140);
  store.close();
});
