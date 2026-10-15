const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createModelUsageService } = require('../lib/usage/model-usage-service');
const { openModelUsageStore } = require('../lib/usage/model-usage-store');
const {
  scanModelUsageSources,
  __private: {
    discoverOpenCodeUsageFiles,
    scanOpenCodeFile
  }
} = require('../lib/usage/model-usage-scanner');

function createOpenCodeTestDb(dbPath, options = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // opencode 2.x 起只写 session_v2/session_message；旧表在纯新库里可以完全缺席。
  const legacyTablesSql = options.legacyTables === false ? '' : `
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      revert TEXT,
      permission TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER,
      workspace_id TEXT,
      path TEXT,
      agent TEXT,
      model TEXT,
      cost REAL DEFAULT 0 NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
      metadata TEXT
    );
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `;
  db.exec(`
    CREATE TABLE IF NOT EXISTS project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      vcs TEXT,
      name TEXT,
      icon_url TEXT,
      icon_color TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_initialized INTEGER,
      sandboxes TEXT NOT NULL,
      commands TEXT,
      icon_url_override TEXT
    );
    CREATE TABLE IF NOT EXISTS session_v2 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      path TEXT,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      model TEXT,
      cost REAL DEFAULT 0 NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER
    );
    CREATE TABLE IF NOT EXISTS session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    ${legacyTablesSql}
  `);

  if (options.project) {
    db.prepare(`
      INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
      VALUES (?, ?, ?, ?, ?, '[]')
    `).run(
      options.project.id || 'proj-1',
      options.project.worktree || '/Users/model/projects/demo',
      options.project.name || 'demo',
      options.project.time_created || 1718000000000,
      options.project.time_updated || 1718000000000
    );
  }

  if (Array.isArray(options.sessions)) {
    for (const s of options.sessions) {
      db.prepare(`
        INSERT INTO session (
          id, project_id, parent_id, slug, directory, title, version,
          time_created, time_updated, time_archived, model,
          tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        s.id,
        s.projectId || 'proj-1',
        s.parentId || null,
        s.slug || 'slug-' + s.id,
        s.directory || '/Users/model/projects/demo',
        s.title || 'Demo Session',
        s.version || '1.0',
        s.timeCreated || 1718000000000,
        s.timeUpdated || 1718000010000,
        typeof s.model === 'object' ? JSON.stringify(s.model) : (s.model || '{"id":"glm-5.2","providerID":"opencode-go"}'),
        s.tokensInput || 0,
        s.tokensOutput || 0,
        s.tokensReasoning || 0,
        s.tokensCacheRead || 0,
        s.tokensCacheWrite || 0,
        s.cost || 0
      );
    }
  }

  if (Array.isArray(options.messages)) {
    for (const m of options.messages) {
      db.prepare(`
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        m.id,
        m.sessionId,
        m.timeCreated || 1718000000000,
        m.timeUpdated || 1718000005000,
        typeof m.data === 'object' ? JSON.stringify(m.data) : m.data
      );
    }
  }

  if (Array.isArray(options.v2Sessions)) {
    for (const s of options.v2Sessions) {
      db.prepare(`
        INSERT INTO session_v2 (
          id, project_id, parent_id, slug, directory, path, title, version,
          model, time_created, time_updated, time_archived,
          tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        s.id,
        s.projectId || 'proj-1',
        s.slug || 'slug-' + s.id,
        s.directory || '/Users/model/projects/demo',
        s.path || null,
        s.title || 'Demo Session',
        s.version || '2.0.29',
        typeof s.model === 'object' ? JSON.stringify(s.model) : (s.model || null),
        s.timeCreated || 1718000000000,
        s.timeUpdated || 1718000010000,
        s.tokensInput || 0,
        s.tokensOutput || 0,
        s.tokensReasoning || 0,
        s.tokensCacheRead || 0,
        s.tokensCacheWrite || 0,
        s.cost || 0
      );
    }
  }

  if (Array.isArray(options.v2Messages)) {
    for (const m of options.v2Messages) {
      db.prepare(`
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        m.id,
        m.sessionId,
        m.type || 'assistant',
        m.seq || 0,
        m.timeCreated || 1718000000000,
        m.timeUpdated || 1718000005000,
        typeof m.data === 'object' ? JSON.stringify(m.data) : m.data
      );
    }
  }

  db.close();
}

test('discoverOpenCodeUsageFiles discovers only the canonical host opencode.db', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-discovery-'));
  const canonicalDb = path.join(root, '.local', 'share', 'opencode', 'opencode.db');
  const conflictDb = path.join(root, '.local', 'share', 'opencode', '.aih-migration-conflicts', 'acct_123', 'opencode.db');
  fs.mkdirSync(path.dirname(canonicalDb), { recursive: true });
  fs.writeFileSync(canonicalDb, '');
  fs.mkdirSync(path.dirname(conflictDb), { recursive: true });
  fs.writeFileSync(conflictDb, '');

  const files = discoverOpenCodeUsageFiles({
    fs,
    path,
    hostHomeDir: root,
    aiHomeDir: path.join(root, '.ai_home')
  });

  assert.deepEqual(files, [canonicalDb]);
});

test('scanOpenCodeFile extracts usage records, prompts and upserts sessions from opencode.db', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-scan-'));
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const store = openModelUsageStore({ fs, path, aiHomeDir, DatabaseSync });

  const dbPath = path.join(root, '.local', 'share', 'opencode', 'opencode.db');
  createOpenCodeTestDb(dbPath, {
    project: {
      id: 'proj-1',
      worktree: '/Users/model/projects/demo',
      name: 'demo'
    },
    sessions: [{
      id: 'ses-1',
      projectId: 'proj-1',
      title: 'Fix issue #123',
      directory: '/Users/model/projects/demo',
      timeCreated: 1718000000000,
      timeUpdated: 1718000010000,
      model: { id: 'glm-5.2', providerID: 'opencode-go' }
    }],
    messages: [
      {
        id: 'msg-user-1',
        sessionId: 'ses-1',
        timeCreated: 1718000000000,
        timeUpdated: 1718000000000,
        data: {
          role: 'user',
          time: { created: 1718000000000 },
          agent: 'build'
        }
      },
      {
        id: 'msg-asst-1',
        sessionId: 'ses-1',
        timeCreated: 1718000005000,
        timeUpdated: 1718000005000,
        data: {
          role: 'assistant',
          modelID: 'glm-5.2',
          providerID: 'opencode-go',
          time: { created: 1718000005000, completed: 1718000005000 },
          tokens: {
            input: 1200,
            output: 450,
            reasoning: 80,
            cache: {
              read: 200,
              write: 0
            },
            total: 1730
          }
        }
      }
    ]
  });

  const scanResult = scanOpenCodeFile({
    fs,
    path,
    store,
    filePath: dbPath,
    DatabaseSync
  });

  assert.equal(scanResult.records, 1);
  assert.equal(scanResult.prompts, 1);

  const stats = store.queryStats({ provider: 'opencode' });
  assert.equal(stats.totalCalls, 1);
  assert.equal(stats.totalPrompts, 1);
  assert.equal(stats.inputTokens, 1000); // 1200 - 200 cached
  assert.equal(stats.outputTokens, 450);
  assert.equal(stats.cacheReadInputTokens, 200);
  assert.equal(stats.reasoningOutputTokens, 80);
  assert.equal(stats.totalTokens, 1730);

  const sessions = store.querySessions({ provider: 'opencode' });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'ses-1');
  assert.equal(sessions[0].project, 'demo');
  assert.equal(sessions[0].promptCount, 1);

  // Incremental scan should skip without changes
  const repeatScan = scanOpenCodeFile({
    fs,
    path,
    store,
    filePath: dbPath,
    DatabaseSync
  });
  assert.equal(repeatScan.records, 0);
  assert.equal(repeatScan.prompts, 0);

  store.close();
});

test('modelUsageService.scan and getDashboard includes opencode stats end-to-end', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-service-'));
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });

  const dbPath = path.join(root, '.local', 'share', 'opencode', 'opencode.db');
  createOpenCodeTestDb(dbPath, {
    project: {
      id: 'proj-opencode',
      worktree: '/Users/model/projects/ai_home',
      name: 'ai_home'
    },
    sessions: [{
      id: 'ses-opencode-1',
      projectId: 'proj-opencode',
      title: 'Analyze usage issue',
      directory: '/Users/model/projects/ai_home',
      timeCreated: 1718000000000,
      timeUpdated: 1718000020000,
      model: { id: 'glm-5.2', providerID: 'opencode-go' }
    }],
    messages: [
      {
        id: 'msg-user-1',
        sessionId: 'ses-opencode-1',
        timeCreated: 1718000000000,
        timeUpdated: 1718000000000,
        data: { role: 'user', time: { created: 1718000000000 } }
      },
      {
        id: 'msg-asst-1',
        sessionId: 'ses-opencode-1',
        timeCreated: 1718000010000,
        timeUpdated: 1718000010000,
        data: {
          role: 'assistant',
          modelID: 'glm-5.2',
          providerID: 'opencode-go',
          time: { created: 1718000010000 },
          tokens: {
            input: 500,
            output: 250,
            reasoning: 0,
            cache: { read: 0, write: 0 },
            total: 750
          }
        }
      }
    ]
  });

  const service = createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: root,
    DatabaseSync
  });

  const scanResult = service.scan({ provider: 'opencode' });
  assert.equal(scanResult.records, 1);
  assert.equal(scanResult.prompts, 1);
  assert.equal(scanResult.providers.opencode.records, 1);
  assert.equal(scanResult.providers.opencode.prompts, 1);

  const dashboard = await service.getDashboardAsync({ provider: 'opencode' });
  assert.equal(dashboard.stats.totalCalls, 1);
  assert.equal(dashboard.stats.totalPrompts, 1);
  assert.equal(dashboard.stats.inputTokens, 500);
  assert.equal(dashboard.stats.outputTokens, 250);
  assert.equal(dashboard.models.length, 1);
  assert.equal(dashboard.models[0].model, 'opencode-go/glm-5.2');
  assert.equal(dashboard.sessions.length, 1);
  assert.equal(dashboard.sessions[0].sessionId, 'ses-opencode-1');

  await service.close();
});

test('scanOpenCodeFile reads the opencode 2.x session_v2/session_message layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-v2-scan-'));
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const store = openModelUsageStore({ fs, path, aiHomeDir, DatabaseSync });

  const dbPath = path.join(root, '.local', 'share', 'opencode', 'opencode.db');
  createOpenCodeTestDb(dbPath, {
    legacyTables: false,
    project: {
      id: 'proj-v2',
      worktree: '/Users/model/projects/demo',
      name: 'demo'
    },
    v2Sessions: [{
      id: 'ses-v2-1',
      projectId: 'proj-v2',
      title: 'V2 layout session',
      directory: '/Users/model/projects/demo',
      version: '2.0.29',
      timeCreated: 1792000000000,
      timeUpdated: 1792000020000,
      model: { id: 'deepseek-v4.1-flash-free', providerID: 'opencode', variant: 'max' }
    }],
    v2Messages: [
      {
        id: 'msg-v2-user-1',
        sessionId: 'ses-v2-1',
        type: 'user',
        seq: 1,
        timeCreated: 1792000000000,
        timeUpdated: 1792000000000,
        data: { time: { created: 1792000000000 }, text: '帮我看看用量统计' }
      },
      {
        id: 'msg-v2-asst-1',
        sessionId: 'ses-v2-1',
        type: 'assistant',
        seq: 2,
        timeCreated: 1792000005000,
        timeUpdated: 1792000005000,
        data: {
          time: { created: 1792000005000, completed: 1792000005000 },
          agent: 'build',
          model: { id: 'deepseek-v4.1-flash-free', providerID: 'opencode', variant: 'max' },
          tokens: { input: 1200, output: 450, reasoning: 80, cache: { read: 200, write: 0 } }
        }
      },
      {
        id: 'msg-v2-compaction-1',
        sessionId: 'ses-v2-1',
        type: 'compaction',
        seq: 3,
        timeCreated: 1792000010000,
        timeUpdated: 1792000010000,
        data: {
          time: { created: 1792000010000 },
          status: 'completed',
          reason: 'auto',
          model: { id: 'deepseek-v4.1-flash-free', providerID: 'opencode' },
          summary: '上下文压缩',
          tokens: { input: 300, output: 120, reasoning: 0, cache: { read: 100, write: 0 } }
        }
      },
      {
        id: 'msg-v2-idle-1',
        sessionId: 'ses-v2-1',
        type: 'idle',
        seq: 4,
        timeCreated: 1792000015000,
        timeUpdated: 1792000015000,
        data: { time: { created: 1792000015000 } }
      }
    ]
  });

  const scanResult = scanOpenCodeFile({
    fs,
    path,
    store,
    filePath: dbPath,
    DatabaseSync
  });

  assert.equal(scanResult.records, 2);
  assert.equal(scanResult.prompts, 1);

  const stats = store.queryStats({ provider: 'opencode' });
  assert.equal(stats.totalCalls, 2);
  assert.equal(stats.totalPrompts, 1);
  assert.equal(stats.inputTokens, 1200); // (1200 - 200) + (300 - 100)
  assert.equal(stats.outputTokens, 570);
  assert.equal(stats.cacheReadInputTokens, 300);
  assert.equal(stats.reasoningOutputTokens, 80);
  assert.equal(stats.totalTokens, 2450); // 1930 + 520

  const sessions = store.querySessions({ provider: 'opencode' });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'ses-v2-1');
  assert.equal(sessions[0].project, 'demo');
  assert.equal(sessions[0].promptCount, 1);

  // 无变化时增量跳过
  const repeatScan = scanOpenCodeFile({
    fs,
    path,
    store,
    filePath: dbPath,
    DatabaseSync
  });
  assert.equal(repeatScan.records, 0);
  assert.equal(repeatScan.prompts, 0);

  store.close();
});

test('scanOpenCodeFile merges dual-write rows by message id without double counting', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-dual-scan-'));
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const store = openModelUsageStore({ fs, path, aiHomeDir, DatabaseSync });

  const dbPath = path.join(root, '.local', 'share', 'opencode', 'opencode.db');
  const sessionColumns = {
    id: 'ses-dual-1',
    projectId: 'proj-dual',
    title: 'Dual write session',
    directory: '/Users/model/projects/demo',
    timeCreated: 1718000000000,
    timeUpdated: 1718000030000,
    model: { id: 'glm-5.2', providerID: 'opencode-go' }
  };
  const dualSession = { id: 'ses-dual-1' };
  createOpenCodeTestDb(dbPath, {
    project: {
      id: 'proj-dual',
      worktree: '/Users/model/projects/demo',
      name: 'demo'
    },
    sessions: [sessionColumns],
    messages: [
      {
        id: 'msg-dual-user-1',
        sessionId: dualSession.id,
        timeCreated: 1718000000000,
        timeUpdated: 1718000000000,
        data: { role: 'user', time: { created: 1718000000000 } }
      },
      {
        // 旧表是终值、新表是占位零值：取旧表
        id: 'msg-dual-legacy-final',
        sessionId: dualSession.id,
        timeCreated: 1718000010000,
        timeUpdated: 1718000010000,
        data: {
          role: 'assistant',
          modelID: 'glm-5.2',
          providerID: 'opencode-go',
          time: { created: 1718000010000, completed: 1718000010000 },
          tokens: { input: 1200, output: 450, reasoning: 80, cache: { read: 200, write: 0 }, total: 1730 }
        }
      },
      {
        // 旧表是占位零值、新表是终值：取新表
        id: 'msg-dual-v2-final',
        sessionId: dualSession.id,
        timeCreated: 1718000020000,
        timeUpdated: 1718000020000,
        data: {
          role: 'assistant',
          modelID: 'glm-5.2',
          providerID: 'opencode-go',
          time: { created: 1718000020000, completed: 1718000020000 },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 0 }
        }
      }
    ],
    v2Sessions: [sessionColumns],
    v2Messages: [
      {
        id: 'msg-dual-user-1',
        sessionId: dualSession.id,
        type: 'user',
        seq: 1,
        timeCreated: 1718000000000,
        timeUpdated: 1718000000000,
        data: { time: { created: 1718000000000 }, text: '同一个提问' }
      },
      {
        id: 'msg-dual-legacy-final',
        sessionId: dualSession.id,
        type: 'assistant',
        seq: 2,
        timeCreated: 1718000010000,
        timeUpdated: 1718000010000,
        data: {
          time: { created: 1718000010000, completed: 1718000010000 },
          model: { id: 'glm-5.2', providerID: 'opencode-go' },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        }
      },
      {
        id: 'msg-dual-v2-final',
        sessionId: dualSession.id,
        type: 'assistant',
        seq: 3,
        timeCreated: 1718000020000,
        timeUpdated: 1718000020000,
        data: {
          time: { created: 1718000020000, completed: 1718000020000 },
          model: { id: 'glm-5.2', providerID: 'opencode-go' },
          tokens: { input: 500, output: 250, reasoning: 0, cache: { read: 0, write: 0 } }
        }
      }
    ]
  });

  const scanResult = scanOpenCodeFile({
    fs,
    path,
    store,
    filePath: dbPath,
    DatabaseSync
  });

  assert.equal(scanResult.records, 2);
  assert.equal(scanResult.prompts, 1);

  const stats = store.queryStats({ provider: 'opencode' });
  assert.equal(stats.totalCalls, 2);
  assert.equal(stats.totalPrompts, 1);
  assert.equal(stats.inputTokens, 1500); // (1200 - 200) + 500
  assert.equal(stats.outputTokens, 700);
  assert.equal(stats.cacheReadInputTokens, 200);
  assert.equal(stats.reasoningOutputTokens, 80);
  assert.equal(stats.totalTokens, 2480); // 1730 + 750

  const sessions = store.querySessions({ provider: 'opencode' });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'ses-dual-1');
  assert.equal(sessions[0].promptCount, 1);

  store.close();
});
