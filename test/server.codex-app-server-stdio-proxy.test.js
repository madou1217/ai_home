const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const {
  AGGREGATE_THREAD_LIST_MAX_ITEMS,
  buildFastResumeHydrationRequest,
  buildTurnStartHydrationRequest,
  buildTurnLiveThreadHydrationRequest,
  buildFastThreadReadResponse,
  buildCodexAppServerSpawnEnv,
  buildCodexCliResumeArgs,
  shouldAggregateThreadList,
  buildAggregatePageRequest,
  mergeThreadListData,
  patchAccountReadResponse,
  patchAuthStatusResponse,
  patchThreadTitleFieldsResponse,
  patchThreadConfigResponse,
  parseRecentCodexRolloutTurns,
  parseProxyArgs,
  readHookState,
  runCodexResumeVisibilityRepair,
  repairMissingOptimizedRolloutPaths,
  repairMissingThreadTitleFields,
  reconcileSelectedThreadConfig,
  reconcileResumeThreadProvider,
  restoreOptimizedRolloutPathInStateDbs,
  rewriteThreadResumeRuntimeConfig,
  sanitizeTraceText,
  shouldSuppressHydrationNotification,
  summarizeJsonRpcForTrace,
  runCodexCliResume,
  runCodexAppServerStdioProxy
} = require('../lib/server/codex-app-server-stdio-proxy');

function createJwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

test('parseProxyArgs splits helper args from upstream args', () => {
  const parsed = parseProxyArgs([
    '--upstream', '/tmp/original',
    '--state-file', '/tmp/state.json',
    '--',
    'app-server',
    '--analytics-default-enabled'
  ]);
  assert.equal(parsed.upstream, '/tmp/original');
  assert.equal(parsed.stateFile, '/tmp/state.json');
  assert.equal(parsed.runCliResume, false);
  assert.deepEqual(parsed.forwardArgs, ['app-server', '--analytics-default-enabled']);
});

test('parseProxyArgs recognizes cli resume hook mode', () => {
  const parsed = parseProxyArgs([
    '--run-cli-resume',
    '--upstream', '/tmp/original',
    '--state-file', '/tmp/state.json',
    '--',
    'resume',
    '--last'
  ]);
  assert.equal(parsed.runCliResume, true);
  assert.equal(parsed.upstream, '/tmp/original');
  assert.deepEqual(parsed.forwardArgs, ['resume', '--last']);
});

test('buildCodexCliResumeArgs injects remote options after resume command', () => {
  const args = buildCodexCliResumeArgs(['resume', '--last'], {
    remoteUrl: 'ws://127.0.0.1:9527',
    authToken: 'secret'
  });
  assert.deepEqual(args, [
    'resume',
    '--remote',
    'ws://127.0.0.1:9527',
    '--remote-auth-token-env',
    'AIH_CODEX_REMOTE_AUTH_TOKEN',
    '--last'
  ]);
  assert.deepEqual(
    buildCodexCliResumeArgs(['resume', '--remote', 'ws://custom', '--last'], { remoteUrl: 'ws://127.0.0.1:9527' }),
    ['resume', '--remote', 'ws://custom', '--last']
  );
});

test('runCodexCliResume scopes shared app-server remote to current cwd', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cli-resume-remote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const upstreamServer = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  t.after(() => upstreamServer.close());
  await once(upstreamServer, 'listening');
  const upstreamPort = upstreamServer.address().port;
  let upstreamAuth = '';
  let resolveUpstreamMessage;
  const upstreamMessage = new Promise((resolve) => {
    resolveUpstreamMessage = resolve;
  });
  upstreamServer.on('connection', (socket, req) => {
    upstreamAuth = String(req.headers.authorization || '');
    socket.on('message', (data) => {
      resolveUpstreamMessage(JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)));
    });
  });

  const aiHomeDir = path.join(root, '.ai_home');
  const stateFile = path.join(aiHomeDir, 'codex-cli-hook-state.json');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ enabled: true }), 'utf8');
  fs.writeFileSync(path.join(aiHomeDir, 'server-config.json'), JSON.stringify({
    host: '0.0.0.0',
    port: upstreamPort,
    apiKey: 'secret'
  }), 'utf8');

  const spawns = [];
  const child = new EventEmitter();
  await runCodexCliResume([
    '--run-cli-resume',
    '--upstream', '/tmp/codex-original',
    '--state-file', stateFile,
    '--',
    'resume',
    '--last'
  ], {
    fs,
    spawn(command, args, options) {
      spawns.push({ command, args, options });
      return child;
    },
    canConnectToTcpEndpoint: async () => true,
    processObj: {
      env: { CODEX_HOME: '/tmp/profile/.codex' },
      cwd: () => '/tmp/profile/project',
      stderr: { write() {} },
      exit() {}
    }
  });

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, '/tmp/codex-original');
  assert.equal(spawns[0].args[0], 'resume');
  assert.equal(spawns[0].args[1], '--remote');
  assert.match(spawns[0].args[2], /^ws:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(spawns[0].args.slice(3), ['--last']);
  assert.equal(spawns[0].options.env.AIH_CODEX_REMOTE_AUTH_TOKEN, undefined);
  assert.equal(spawns[0].options.env.CODEX_HOME, '/tmp/profile/.codex');

  const client = new WebSocket(spawns[0].args[2]);
  t.after(() => client.close());
  await once(client, 'open');
  client.send(JSON.stringify({
    id: 'list-1',
    method: 'thread/list',
    params: { limit: 50 }
  }));
  const payload = await upstreamMessage;
  assert.equal(upstreamAuth, 'Bearer secret');
  assert.equal(payload.method, 'thread/list');
  assert.equal(payload.params.cwd, '/tmp/profile/project');
  assert.deepEqual(payload.params.modelProviders, []);
  assert.equal(payload.params.useStateDbOnly, true);
  child.emit('exit', 0);
});

test('runCodexCliResume falls back to native resume when remote server is unavailable', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cli-resume-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const stateFile = path.join(aiHomeDir, 'codex-cli-hook-state.json');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ enabled: true }), 'utf8');

  const spawns = [];
  const child = new EventEmitter();
  await runCodexCliResume([
    '--run-cli-resume',
    '--upstream', '/tmp/codex-original',
    '--state-file', stateFile,
    '--',
    'resume',
    '--last'
  ], {
    fs,
    spawn(command, args, options) {
      spawns.push({ command, args, options });
      return child;
    },
    canConnectToTcpEndpoint: async () => false,
    processObj: {
      env: {},
      stderr: { write() {} },
      exit() {}
    }
  });

  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['resume', '--last']);
  assert.equal(spawns[0].options.env.AIH_CODEX_REMOTE_AUTH_TOKEN, undefined);
});

test('runCodexCliResume keeps remote resume global when --all is requested', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cli-resume-all-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const stateFile = path.join(aiHomeDir, 'codex-cli-hook-state.json');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ enabled: true }), 'utf8');

  const spawns = [];
  const child = new EventEmitter();
  await runCodexCliResume([
    '--run-cli-resume',
    '--upstream', '/tmp/codex-original',
    '--state-file', stateFile,
    '--',
    'resume',
    '--all'
  ], {
    fs,
    spawn(command, args, options) {
      spawns.push({ command, args, options });
      return child;
    },
    canConnectToTcpEndpoint: async () => true,
    processObj: {
      env: {},
      cwd: () => '/tmp/current-project',
      stderr: { write() {} },
      exit() {}
    }
  });

  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['resume', '--remote', 'ws://127.0.0.1:9527', '--all']);
});

test('resume visibility repair helper is read-only compatibility mode', (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-resume-provider-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, '.codex');
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '05', '22');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model_provider = "aih_1"\n', 'utf8');
  const stateFile = path.join(root, '.ai_home', 'codex-cli-hook-state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ enabled: true }), 'utf8');

  const rolloutPath = path.join(sessionsDir, 'rollout-2026-05-22T12-00-00-thread-openai.jsonl');
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'thread-openai', cwd: '/tmp/project' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'openai session' } }),
    ''
  ].join('\n'), 'utf8');

  const dbPath = path.join(codexHome, 'state_5.sqlite');
  let db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      source TEXT,
      model_provider TEXT,
      cwd TEXT,
      title TEXT,
      first_user_message TEXT,
      archived INTEGER DEFAULT 0
    )
  `);
  db.prepare(`
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
      source, model_provider, cwd, title, first_user_message, archived
    ) VALUES (?, ?, 1, 1, 1000, 1000, 'cli', 'openai', '/tmp/project', 'openai session', 'openai session', 0)
  `).run('thread-openai', rolloutPath);
  db.close();

  const result = runCodexResumeVisibilityRepair([
    '--repair-resume-visibility',
    '--state-file', stateFile,
    '--',
    'resume'
  ], {
    fs,
    processObj: {
      env: { HOME: root },
      platform: process.platform,
      cwd: () => '/tmp/project'
    },
    DatabaseSync
  });

  assert.equal(result.providerAligned, 0);
  db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare('SELECT model_provider FROM threads WHERE id = ?').get('thread-openai');
  db.close();
  assert.equal(row.model_provider, 'openai');
});

test('readHookState defaults to disabled when state file is missing', () => {
  const state = readHookState({
    existsSync: () => false
  }, '/tmp/missing.json');
  assert.equal(state.enabled, false);
});

test('readHookState accepts a numeric desktop account preference', () => {
  const state = readHookState({
    existsSync: () => true,
    readFileSync: () => JSON.stringify({
      enabled: true,
      traceResponses: true,
      traceRemoteControl: true,
      remoteControlProxy: true,
      desktopAccountId: '10009'
    })
  }, '/tmp/state.json');
  assert.equal(state.enabled, true);
  assert.equal(state.traceResponses, true);
  assert.equal(state.traceRemoteControl, true);
  assert.equal(state.remoteControlProxy, true);
  assert.equal(state.desktopAccountId, '10009');
});

test('remote trace helpers summarize and sanitize diagnostic payloads', () => {
  const summary = summarizeJsonRpcForTrace({
    id: 'list-1',
    method: 'thread/list',
    params: {
      modelProviders: [],
      useStateDbOnly: true,
      cwd: '/tmp/project'
    }
  });
  assert.deepEqual(summary, {
    id: 'list-1',
    method: 'thread/list',
    modelProviders: [],
    useStateDbOnly: true,
    hasCwd: true
  });
  assert.equal(
    sanitizeTraceText('Authorization: Bearer eyJabc.def.ghi token="secret" "access_token":"abc"'),
    'Authorization: Bearer [redacted] token="secret" "access_token":"[redacted]"'
  );
});

test('shouldAggregateThreadList matches first-page requests for global and cwd lists', () => {
  assert.equal(shouldAggregateThreadList({
    method: 'thread/list',
    params: {
      limit: 50,
      cursor: null,
      archived: false,
      sourceKinds: []
    }
  }), true);
  assert.equal(shouldAggregateThreadList({
    method: 'thread/list',
    params: {
      cwd: '/tmp/x',
      cursor: null,
      archived: false,
      sourceKinds: []
    }
  }), true);
  assert.equal(shouldAggregateThreadList({
    method: 'thread/list',
    params: {
      cwd: '/tmp/x',
      cursor: null,
      archived: false,
      sourceKinds: ['cli', 'vscode']
    }
  }), true);
  assert.equal(shouldAggregateThreadList({
    method: 'thread/list',
    params: {
      cwd: '/tmp/x',
      cursor: null,
      archived: false,
      sourceKinds: ['vscode', 'cli']
    }
  }), true);
  assert.equal(shouldAggregateThreadList({
    method: 'thread/list',
    params: {
      cwd: '/tmp/x',
      cursor: null,
      archived: false,
      sourceKinds: ['cli', 'exec']
    }
  }), false);
  assert.equal(shouldAggregateThreadList({
    method: 'thread/list',
    params: {
      cwd: '/tmp/x',
      cursor: null,
      archived: false
    }
  }), true);
  assert.equal(shouldAggregateThreadList({
    method: 'thread/list',
    params: {
      cwd: '/tmp/x',
      limit: 50,
      cursor: 'abc',
      archived: false,
      sourceKinds: []
    }
  }), false);
});

test('buildAggregatePageRequest rewrites cursor and limit deterministically', () => {
  const out = buildAggregatePageRequest({
    id: 'abc',
    method: 'thread/list',
    params: {
      limit: 50,
      cursor: null,
      archived: false,
      sourceKinds: []
    }
  }, 'CURSOR-2', 'abc:2', 30);
  assert.equal(out.id, 'abc:2');
  assert.equal(out.params.cursor, 'CURSOR-2');
  assert.equal(out.params.limit, 30);
  assert.equal(out.params.useStateDbOnly, true);
});

test('mergeThreadListData dedupes by thread id', () => {
  const merged = mergeThreadListData(
    [{ id: '1', cwd: '/a' }, { id: '2', cwd: '/b' }],
    [{ id: '2', cwd: '/b' }, { id: '3', cwd: '/c' }]
  );
  assert.deepEqual(merged.map((item) => item.id), ['1', '2', '3']);
});

test('parseRecentCodexRolloutTurns builds recent display turns from event messages', () => {
  const text = [
    JSON.stringify({ timestamp: '2026-05-09T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }),
    JSON.stringify({ timestamp: '2026-05-09T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'hello', images: [], local_images: [], text_elements: [] } }),
    JSON.stringify({ timestamp: '2026-05-09T00:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'world', phase: 'final_answer', memory_citation: null } }),
    JSON.stringify({ timestamp: '2026-05-09T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } })
  ].join('\n');

  const turns = parseRecentCodexRolloutTurns(text, { threadId: 'thread-1' });

  assert.equal(turns.length, 1);
  assert.equal(turns[0].id, 'turn-1');
  assert.equal(turns[0].status, 'completed');
  assert.deepEqual(turns[0].items.map((item) => item.type), ['userMessage', 'agentMessage']);
  assert.equal(turns[0].items[0].content[0].text, 'hello');
  assert.equal(turns[0].items[1].text, 'world');
});

test('parseRecentCodexRolloutTurns marks old incomplete turns interrupted', () => {
  const text = [
    JSON.stringify({ timestamp: '2026-05-09T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }),
    JSON.stringify({ timestamp: '2026-05-09T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'stuck hello', images: [], local_images: [], text_elements: [] } })
  ].join('\n');

  const turns = parseRecentCodexRolloutTurns(text, {
    threadId: 'thread-1',
    nowMs: Date.parse('2026-05-09T00:31:00.000Z'),
    staleInProgressAfterMs: 30 * 60 * 1000
  });

  assert.equal(turns.length, 1);
  assert.equal(turns[0].id, 'turn-1');
  assert.equal(turns[0].status, 'interrupted');
  assert.equal(turns[0].completedAt, 1778284801);
  assert.equal(Object.prototype.hasOwnProperty.call(turns[0], '_lastActivityAt'), false);
});

test('buildFastThreadReadResponse returns recent turns for large thread/read without upstream parsing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fast-read-'));
  const rolloutPath = path.join(tmpDir, 'rollout.jsonl');
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({ timestamp: '2026-05-09T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }),
    JSON.stringify({ timestamp: '2026-05-09T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'large hello', images: [], local_images: [], text_elements: [] } }),
    JSON.stringify({ timestamp: '2026-05-09T00:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'large world', phase: 'final_answer', memory_citation: null } }),
    JSON.stringify({ timestamp: '2026-05-09T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } })
  ].join('\n'));

  class FakeDatabase {
    exec() {}
    prepare(sql) {
      assert.match(sql, /FROM threads/);
      return {
        get(threadId) {
          assert.equal(threadId, 'thread-1');
          return {
            id: 'thread-1',
            rollout_path: rolloutPath,
            created_at: 1778284800,
            updated_at: 1778284803,
            source: 'cli',
            model_provider: 'openai',
            model: 'gpt-5.3-codex',
            cwd: '/tmp/project',
            title: 'Title',
            sandbox_policy: '{"type":"danger-full-access"}',
            approval_mode: 'never',
            cli_version: '0.128.0',
            first_user_message: 'large hello',
            reasoning_effort: 'high'
          };
        }
      };
    }
    close() {}
  }

  const response = buildFastThreadReadResponse({
    id: 'read-1',
    method: 'thread/read',
    params: { threadId: 'thread-1', includeTurns: true }
  }, {
    fs: {
      existsSync: () => true,
      readFileSync: () => 'model_provider = "aih_10"\nmodel = "gpt-5.5"\n',
      readdirSync: () => ['state_5.sqlite'],
      statSync: fs.statSync.bind(fs),
      openSync: fs.openSync.bind(fs),
      readSync: fs.readSync.bind(fs),
      closeSync: fs.closeSync.bind(fs)
    },
    processObj: {
      env: { CODEX_HOME: '/tmp/codex' }
    },
    DatabaseSync: FakeDatabase,
    fastReadMinBytes: 1,
    fastReadInitialBytes: 4096,
    fastReadMaxBytes: 4096
  });

  assert.equal(response.id, 'read-1');
  assert.equal(response.result.thread.modelProvider, 'aih_10');
  assert.equal(response.result.thread.title, 'Title');
  assert.equal(response.result.thread.name, 'Title');
  assert.equal(response.result.thread.turns.length, 1);
  assert.equal(response.result.thread.turns[0].items[0].content[0].text, 'large hello');
});

test('buildFastThreadReadResponse does not expose untracked incomplete turns as active', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fast-read-stale-turn-'));
  const rolloutPath = path.join(tmpDir, 'rollout.jsonl');
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({ timestamp: '2026-05-09T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }),
    JSON.stringify({ timestamp: '2026-05-09T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'unfinished', images: [], local_images: [], text_elements: [] } })
  ].join('\n'));

  class FakeDatabase {
    exec() {}
    prepare(sql) {
      assert.match(sql, /FROM threads/);
      return {
        get(threadId) {
          assert.equal(threadId, 'thread-1');
          return {
            id: 'thread-1',
            rollout_path: rolloutPath,
            created_at: 1778284800,
            updated_at: 1778284801,
            source: 'cli',
            model_provider: 'openai',
            model: 'gpt-5.3-codex',
            cwd: '/tmp/project',
            title: 'Title',
            sandbox_policy: '{"type":"danger-full-access"}',
            approval_mode: 'never',
            cli_version: '0.128.0',
            first_user_message: 'unfinished',
            reasoning_effort: 'high'
          };
        }
      };
    }
    close() {}
  }

  const baseDeps = {
    fs: {
      existsSync: () => true,
      readFileSync: () => 'model_provider = "aih_10"\nmodel = "gpt-5.5"\n',
      readdirSync: () => ['state_5.sqlite'],
      statSync: fs.statSync.bind(fs),
      openSync: fs.openSync.bind(fs),
      readSync: fs.readSync.bind(fs),
      closeSync: fs.closeSync.bind(fs)
    },
    processObj: {
      env: { CODEX_HOME: '/tmp/codex' }
    },
    DatabaseSync: FakeDatabase,
    fastReadMinBytes: 1,
    fastReadInitialBytes: 4096,
    fastReadMaxBytes: 4096,
    nowMs: Date.parse('2026-05-09T00:00:02.000Z')
  };

  const untracked = buildFastThreadReadResponse({
    id: 'read-1',
    method: 'thread/read',
    params: { threadId: 'thread-1', includeTurns: true }
  }, {
    ...baseDeps,
    activeTurnIdsByThreadId: new Map()
  });
  assert.equal(untracked.result.thread.turns[0].status, 'interrupted');

  const tracked = buildFastThreadReadResponse({
    id: 'read-2',
    method: 'thread/read',
    params: { threadId: 'thread-1', includeTurns: true }
  }, {
    ...baseDeps,
    activeTurnIdsByThreadId: new Map([['thread-1', 'turn-1']])
  });
  assert.equal(tracked.result.thread.turns[0].status, 'inProgress');
});

test('buildFastThreadReadResponse prefers host codex config when running from account sandbox', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fast-read-host-config-'));
  const rolloutPath = path.join(tmpDir, 'rollout.jsonl');
  fs.writeFileSync(
    rolloutPath,
    JSON.stringify({ timestamp: '2026-05-09T00:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'hello' } }) + '\n',
    'utf8'
  );

  class FakeDatabase {
    exec() {}
    prepare(sql) {
      if (String(sql).startsWith('PRAGMA')) {
        return { all: () => [{ name: 'id' }, { name: 'rollout_path' }] };
      }
      return {
        get: () => ({
          id: 'thread-1',
          rollout_path: rolloutPath,
          created_at: 1778284800,
          updated_at: 1778284800,
          source: 'cli',
          model_provider: 'aih',
          model: 'gpt-5.4',
          cwd: '/tmp/project',
          title: 'Title'
        })
      };
    }
    close() {}
  }

  const response = buildFastThreadReadResponse({
    id: 'resume-1',
    method: 'thread/resume',
    params: { threadId: 'thread-1' }
  }, {
    fs: {
      existsSync: () => true,
      readFileSync: (filePath) => String(filePath).startsWith('/Users/model/.codex/')
        ? 'model_provider = "aih_10014"\nmodel = "gpt-5.5"\n'
        : 'model_provider = "aih"\nmodel = "gpt-5.4"\n',
      readdirSync: () => ['state_5.sqlite'],
      statSync: fs.statSync.bind(fs),
      openSync: fs.openSync.bind(fs),
      readSync: fs.readSync.bind(fs),
      closeSync: fs.closeSync.bind(fs)
    },
    processObj: {
      platform: 'darwin',
      env: {
        HOME: '/Users/model/.ai_home/profiles/codex/10019',
        CODEX_HOME: '/Users/model/.ai_home/profiles/codex/10019/.codex'
      }
    },
    DatabaseSync: FakeDatabase,
    fastReadMinBytes: 1
  });

  assert.equal(response.result.thread.modelProvider, 'aih_10014');
  assert.equal(response.result.modelProvider, 'aih_10014');
  assert.equal(response.result.model, 'gpt-5.5');
});

test('patchThreadConfigResponse rewrites stale thread and resume model metadata', () => {
  const raw = JSON.stringify({
    id: 'resume-1',
    result: {
      thread: { id: 'thread-1', modelProvider: 'aih' },
      modelProvider: 'aih',
      model: 'gpt-5.4'
    }
  });
  const patched = JSON.parse(patchThreadConfigResponse(raw, {
    modelProvider: 'aih_10',
    model: 'gpt-5.5'
  }));
  assert.equal(patched.result.thread.modelProvider, 'aih_10');
  assert.equal(patched.result.modelProvider, 'aih_10');
  assert.equal(patched.result.model, 'gpt-5.5');
});

test('patchThreadTitleFieldsResponse fills blank thread titles from state sqlite metadata', () => {
  class FakeDatabase {
    exec() {}
    prepare() {
      return {
        get(threadId) {
          assert.equal(threadId, 'thread-1');
          return {
            id: 'thread-1',
            title: '',
            first_user_message: '真实会话标题'
          };
        }
      };
    }
    close() {}
  }

  const raw = JSON.stringify({
    id: 'list-1',
    result: {
      data: [
        { id: 'thread-1', title: '', name: null, preview: '' }
      ]
    }
  });

  const patched = JSON.parse(patchThreadTitleFieldsResponse(raw, {
    fs: {
      readdirSync: () => ['state_5.sqlite']
    },
    processObj: {
      env: { CODEX_HOME: '/tmp/codex' }
    },
    DatabaseSync: FakeDatabase
  }));

  assert.equal(patched.result.data[0].title, '真实会话标题');
  assert.equal(patched.result.data[0].name, '真实会话标题');
  assert.equal(patched.result.data[0].preview, '真实会话标题');
});

test('patchAccountReadResponse exposes a real local OAuth account without changing runtime default', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-desktop-account-'));
  const codexHome = path.join(tmpHome, '.codex');
  const accountDir = path.join(tmpHome, '.ai_home', 'profiles', 'codex', '10038', '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(accountDir, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model_provider = "aih_10"\nmodel = "gpt-5.5"\n', 'utf8');
  fs.writeFileSync(path.join(accountDir, 'auth.json'), JSON.stringify({
    tokens: {
      access_token: createJwt({
        'https://api.openai.com/profile': { email: 'real@example.com' },
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'team',
          chatgpt_account_id: 'acc_real',
          organizations: [{ id: 'org_real', is_default: true }]
        }
      }),
      refresh_token: 'refresh-real'
    }
  }), 'utf8');

  const raw = JSON.stringify({
    id: 'account-1',
    result: {
      account: null,
      requiresOpenaiAuth: false
    }
  });
  const patched = JSON.parse(patchAccountReadResponse(raw, {
    fs,
    processObj: {
      platform: 'darwin',
      env: {
        HOME: tmpHome,
        CODEX_HOME: codexHome
      }
    }
  }));

  assert.deepEqual(patched.result.account, {
    type: 'chatgpt',
    email: 'real@example.com',
    planType: 'team'
  });
  assert.equal(patched.result.requiresOpenaiAuth, false);
});

test('patchAccountReadResponse does not swap in OAuth account when Codex App target is api-key', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-desktop-account-apikey-'));
  const codexHome = path.join(tmpHome, '.codex');
  const apiKeyAccountDir = path.join(tmpHome, '.ai_home', 'profiles', 'codex', '1');
  const oauthAccountDir = path.join(tmpHome, '.ai_home', 'profiles', 'codex', '4', '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(apiKeyAccountDir, '.codex'), { recursive: true });
  fs.mkdirSync(oauthAccountDir, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model_provider = "aih_10"\nmodel = "gpt-5.5"\n', 'utf8');
  fs.writeFileSync(path.join(tmpHome, '.ai_home', 'profiles', 'codex', '.aih_default'), '1', 'utf8');
  fs.writeFileSync(path.join(apiKeyAccountDir, '.aih_env.json'), JSON.stringify({
    OPENAI_API_KEY: 'sk-api-key',
    OPENAI_BASE_URL: 'https://api.example.test/v1'
  }), 'utf8');
  fs.writeFileSync(path.join(apiKeyAccountDir, '.codex', 'auth.json'), JSON.stringify({
    OPENAI_API_KEY: 'sk-api-key'
  }), 'utf8');
  fs.writeFileSync(path.join(oauthAccountDir, 'auth.json'), JSON.stringify({
    tokens: {
      access_token: createJwt({
        'https://api.openai.com/profile': { email: 'real@example.com' },
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'team',
          chatgpt_account_id: 'acc_real'
        }
      }),
      refresh_token: 'refresh-real'
    }
  }), 'utf8');

  const raw = JSON.stringify({
    id: 'account-1',
    result: {
      account: null,
      requiresOpenaiAuth: false
    }
  });
  const patched = JSON.parse(patchAccountReadResponse(raw, {
    fs,
    processObj: {
      platform: 'darwin',
      env: {
        HOME: tmpHome,
        CODEX_HOME: codexHome
      }
    }
  }));

  assert.equal(patched.result.account, null);
  assert.equal(patched.result.requiresOpenaiAuth, false);
});

test('patchAccountReadResponse leaves non-ai-home and existing account responses untouched', () => {
  const emptyAccount = JSON.stringify({
    id: 'account-1',
    result: {
      account: null,
      requiresOpenaiAuth: false
    }
  });
  const existingAccount = JSON.stringify({
    id: 'account-2',
    result: {
      account: { type: 'apiKey' },
      requiresOpenaiAuth: false
    }
  });
  const options = {
    fs: {
      existsSync: () => true,
      readFileSync: () => 'model_provider = "openai"\nmodel = "gpt-5.5"\n'
    },
    processObj: {
      platform: 'darwin',
      env: {
        HOME: '/tmp/home',
        CODEX_HOME: '/tmp/home/.codex'
      }
    }
  };

  assert.equal(patchAccountReadResponse(emptyAccount, options), emptyAccount);
  assert.equal(patchAccountReadResponse(existingAccount, {
    ...options,
    fs: {
      existsSync: () => true,
      readFileSync: () => 'model_provider = "aih_10014"\nmodel = "gpt-5.5"\n'
    }
  }), existingAccount);
  assert.equal(patchAccountReadResponse(JSON.stringify({
    id: 'account-3',
    error: { message: 'failed' }
  }), options), JSON.stringify({
    id: 'account-3',
    error: { message: 'failed' }
  }));
});

test('reconcileResumeThreadProvider resolves old ai-home provider without mutating state db', () => {
  class FakeDatabase {
    constructor(dbPath) {
      this.dbPath = dbPath;
    }
    exec() {}
    prepare(sql) {
      if (sql.startsWith('SELECT')) {
        return {
          get(threadId) {
            assert.equal(threadId, 'thread-1');
            return { model_provider: 'aih_10014' };
          }
        };
      }
      return {
        run() {
          throw new Error('state db should not be mutated');
        }
      };
    }
    close() {}
  }

  const result = reconcileResumeThreadProvider({
    method: 'thread/resume',
    params: { threadId: 'thread-1' }
  }, {
    fs: {
      existsSync: () => true,
      readFileSync: () => 'model_provider = "aih_10"\n',
      readdirSync: () => ['state_5.sqlite']
    },
    processObj: {
      env: { CODEX_HOME: '/tmp/codex' }
    },
    DatabaseSync: FakeDatabase
  });

  assert.equal(result.changed, true);
  assert.equal(result.persistedProvider, 'aih_10014');
  assert.equal(result.currentProvider, 'aih_10');
});

test('reconcileSelectedThreadConfig resolves non-current providers without mutating state db', () => {
  class FakeDatabase {
    exec() {}
    prepare(sql) {
      if (sql.startsWith('SELECT')) {
        return { get: () => ({ model_provider: 'openai', model: 'gpt-5.3-codex' }) };
      }
      return {
        run() {
          throw new Error('state db should not be mutated');
        }
      };
    }
    close() {}
  }

  const result = reconcileSelectedThreadConfig({
    method: 'thread/read',
    params: { threadId: 'thread-1' }
  }, {
    fs: {
      existsSync: () => true,
      readFileSync: () => 'model_provider = "aih_10"\nmodel = "gpt-5.5"\n',
      readdirSync: () => ['state_5.sqlite']
    },
    processObj: {
      env: { CODEX_HOME: '/tmp/codex' }
    },
    DatabaseSync: FakeDatabase
  });

  assert.equal(result.changed, true);
  assert.equal(result.persistedProvider, 'openai');
  assert.equal(result.currentProvider, 'aih_10');
});

test('reconcileSelectedThreadConfig resolves stale model even when provider already matches current config', () => {
  class FakeDatabase {
    exec() {}
    prepare(sql) {
      if (sql.startsWith('SELECT')) {
        return { get: () => ({ model_provider: 'aih_10', model: 'gpt-5.4' }) };
      }
      return {
        run() {
          throw new Error('state db should not be mutated');
        }
      };
    }
    close() {}
  }

  const result = reconcileSelectedThreadConfig({
    method: 'thread/resume',
    params: { threadId: 'thread-1' }
  }, {
    fs: {
      existsSync: () => true,
      readFileSync: () => 'model_provider = "aih_10"\nmodel = "gpt-5.5"\n',
      readdirSync: () => ['state_5.sqlite']
    },
    processObj: {
      env: { CODEX_HOME: '/tmp/codex' }
    },
    DatabaseSync: FakeDatabase
  });

  assert.equal(result.changed, true);
  assert.equal(result.persistedProvider, 'aih_10');
  assert.equal(result.persistedModel, 'gpt-5.4');
  assert.equal(result.currentProvider, 'aih_10');
  assert.equal(result.currentModel, 'gpt-5.5');
});

test('rewriteThreadResumeRuntimeConfig injects current provider and model for stale sessions', () => {
  const out = rewriteThreadResumeRuntimeConfig({
    id: 'resume-1',
    method: 'thread/resume',
    params: {
      threadId: 'thread-1'
    }
  }, {
    currentProvider: 'aih_10',
    currentModel: 'gpt-5.5'
  });

  assert.equal(out.params.modelProvider, 'aih_10');
  assert.equal(out.params.model, 'gpt-5.5');
});

test('buildFastResumeHydrationRequest registers a large resumed thread without turns', () => {
  const out = buildFastResumeHydrationRequest({
    id: 'resume-1',
    method: 'thread/resume',
    params: {
      threadId: 'thread-1'
    }
  }, {
    currentProvider: 'aih_10',
    currentModel: 'gpt-5.5'
  }, 7);

  assert.equal(out.id, 'aih-hydrate-thread-resume:resume-1:7');
  assert.equal(out.method, 'thread/resume');
  assert.equal(out.params.threadId, 'thread-1');
  assert.equal(out.params.excludeTurns, true);
  assert.equal(Object.prototype.hasOwnProperty.call(out.params, 'path'), false);
  assert.equal(out.params.modelProvider, 'aih_10');
  assert.equal(out.params.model, 'gpt-5.5');
});

test('buildTurnStartHydrationRequest resumes a missing live thread before retrying a turn', () => {
  const out = buildTurnStartHydrationRequest({
    id: 'turn-1',
    method: 'turn/start',
    params: {
      threadId: 'thread-1',
      input: []
    }
  }, {
    currentProvider: 'aih_10',
    currentModel: 'gpt-5.5'
  }, 3);

  assert.equal(out.id, 'aih-hydrate-turn-start:turn-1:3');
  assert.equal(out.method, 'thread/resume');
  assert.equal(out.params.threadId, 'thread-1');
  assert.equal(out.params.excludeTurns, true);
  assert.equal(out.params.modelProvider, 'aih_10');
  assert.equal(out.params.model, 'gpt-5.5');
  assert.equal(Object.prototype.hasOwnProperty.call(out.params, 'input'), false);
});

test('buildTurnLiveThreadHydrationRequest resumes a missing live thread before steering a turn', () => {
  const out = buildTurnLiveThreadHydrationRequest({
    id: 'steer-1',
    method: 'turn/steer',
    params: {
      threadId: 'thread-1',
      expectedTurnId: 'active-turn-1',
      input: [{ type: 'text', text: 'more context' }]
    }
  }, {
    currentProvider: 'aih_10',
    currentModel: 'gpt-5.5'
  }, 4);

  assert.equal(out.id, 'aih-hydrate-turn-steer:steer-1:4');
  assert.equal(out.method, 'thread/resume');
  assert.equal(out.params.threadId, 'thread-1');
  assert.equal(out.params.excludeTurns, true);
  assert.equal(out.params.modelProvider, 'aih_10');
  assert.equal(out.params.model, 'gpt-5.5');
  assert.equal(Object.prototype.hasOwnProperty.call(out.params, 'input'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out.params, 'expectedTurnId'), false);
});

test('repairMissingOptimizedRolloutPaths restores slim rollout pointers even when sidecar exists', () => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    return;
  }

  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-rollout-repair-'));
  const sessionId = '019e2ae6-e189-7b20-9f67-dd05d2cf3b03';
  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '15');
  fs.mkdirSync(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, `rollout-2026-05-15T17-10-34-${sessionId}.jsonl`);
  const staleSlimPath = `${rolloutPath}.aih-slim-2026-05-16T04-45-29-122Z-8795.jsonl`;
  fs.writeFileSync(rolloutPath, JSON.stringify({
    timestamp: '2026-05-15T17:10:34.000Z',
    type: 'session_meta',
    payload: { id: sessionId, cwd: '/tmp/project-admin' }
  }) + '\n', 'utf8');
  fs.writeFileSync(staleSlimPath, fs.readFileSync(rolloutPath, 'utf8'), 'utf8');

  const dbPath = path.join(codexHome, 'state_5.sqlite');
  let db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT)');
  db.prepare('INSERT INTO threads (id, rollout_path, cwd, title) VALUES (?, ?, ?, ?)')
    .run(sessionId, staleSlimPath, '/tmp/project-admin', 'Project admin');
  db.close();

  const summary = repairMissingOptimizedRolloutPaths({ fs, codexHome, DatabaseSync });

  db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(sessionId);
  db.close();

  assert.equal(summary.checked, 1);
  assert.equal(summary.repaired, 1);
  assert.equal(row.rollout_path, rolloutPath);
});

test('repairMissingThreadTitleFields restores blank titles from canonical rollout', () => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    return;
  }

  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-title-repair-'));
  const sessionId = '019e2ae6-e189-7b20-9f67-dd05d2cf3b03';
  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '15');
  fs.mkdirSync(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, `rollout-2026-05-15T17-10-34-${sessionId}.jsonl`);
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({
      timestamp: '2026-05-15T17:10:34.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: '/tmp/project-admin' }
    }),
    JSON.stringify({
      timestamp: '2026-05-15T17:10:35.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: '新增移动端适配Demo页' }
    })
  ].join('\n') + '\n', 'utf8');

  const dbPath = path.join(codexHome, 'state_5.sqlite');
  let db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, first_user_message TEXT, preview TEXT, archived INTEGER DEFAULT 0)');
  db.prepare('INSERT INTO threads (id, rollout_path, cwd, title, first_user_message, preview, archived) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sessionId, rolloutPath, '/tmp/project-admin', '', '', '', 0);
  db.close();

  const summary = repairMissingThreadTitleFields({ fs, codexHome, DatabaseSync });

  db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare('SELECT title, first_user_message, preview FROM threads WHERE id = ?').get(sessionId);
  db.close();

  assert.equal(summary.checked, 1);
  assert.equal(summary.repaired, 1);
  assert.equal(row.title, '新增移动端适配Demo页');
  assert.equal(row.first_user_message, '新增移动端适配Demo页');
  assert.equal(row.preview, '新增移动端适配Demo页');
});

test('repairMissingThreadTitleFields prefers session index title over synthetic context messages', () => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    return;
  }

  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-title-index-repair-'));
  const sessionId = '019e2ae6-e189-7b20-9f67-dd05d2cf3b03';
  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '15');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, 'session_index.jsonl'),
    JSON.stringify({ id: sessionId, thread_name: '新增移动端适配Demo页' }) + '\n',
    'utf8'
  );
  const rolloutPath = path.join(sessionDir, `rollout-2026-05-15T17-10-34-${sessionId}.jsonl`);
  fs.writeFileSync(rolloutPath, JSON.stringify({
    timestamp: '2026-05-15T17:10:34.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '# AGENTS.md instructions for /tmp/project\n<INSTRUCTIONS>synthetic</INSTRUCTIONS>' }]
    }
  }) + '\n', 'utf8');

  const dbPath = path.join(codexHome, 'state_5.sqlite');
  let db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, first_user_message TEXT, preview TEXT)');
  db.prepare('INSERT INTO threads (id, rollout_path, cwd, title, first_user_message, preview) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sessionId, rolloutPath, '/tmp/project-admin', '', '', '');
  db.close();

  const summary = repairMissingThreadTitleFields({ fs, codexHome, DatabaseSync });

  db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare('SELECT title, first_user_message, preview FROM threads WHERE id = ?').get(sessionId);
  db.close();

  assert.equal(summary.repaired, 1);
  assert.equal(row.title, '新增移动端适配Demo页');
  assert.equal(row.first_user_message, '新增移动端适配Demo页');
  assert.equal(row.preview, '新增移动端适配Demo页');
});

test('stdio proxy repairs stale optimized rollout path before forwarding thread/list', () => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    return;
  }

  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-thread-list-repair-'));
  const sessionId = '019e2ae6-e189-7b20-9f67-dd05d2cf3b03';
  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '15');
  fs.mkdirSync(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, `rollout-2026-05-15T17-10-34-${sessionId}.jsonl`);
  const staleSlimPath = `${rolloutPath}.aih-slim-2026-05-16T04-45-29-122Z-8795.jsonl`;
  fs.writeFileSync(rolloutPath, JSON.stringify({
    timestamp: '2026-05-15T17:10:34.000Z',
    type: 'session_meta',
    payload: { id: sessionId, cwd: '/tmp/project-admin' }
  }) + '\n', 'utf8');

  const dbPath = path.join(codexHome, 'state_5.sqlite');
  let db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT)');
  db.prepare('INSERT INTO threads (id, rollout_path, cwd, title) VALUES (?, ?, ?, ?)')
    .run(sessionId, staleSlimPath, '/tmp/project-admin', 'Project admin');
  db.close();

  const stdin = new EventEmitter();
  const stdout = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const stderr = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const upstreamStdout = new EventEmitter();
  const upstreamStdinWrites = [];
  const child = new EventEmitter();
  child.stdin = {
    write(chunk) {
      upstreamStdinWrites.push(String(chunk || ''));
    },
    end() {}
  };
  child.stdout = upstreamStdout;

  const stateFile = path.join(codexHome, 'hook-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ enabled: true }), 'utf8');

  runCodexAppServerStdioProxy([
    '--upstream', '/tmp/original',
    '--state-file', stateFile,
    '--',
    'app-server'
  ], {
    fs,
    DatabaseSync,
    spawn: () => child,
    processObj: {
      env: {
        HOME: codexHome,
        CODEX_HOME: codexHome
      },
      pid: 999,
      stdin,
      stdout,
      stderr,
      exit(code) {
        throw new Error(`EXIT:${code}`);
      },
      kill() {
        throw new Error('signal should not be used');
      }
    }
  });

  stdin.emit('data', Buffer.from('{"id":"list-1","method":"thread/list","params":{"cwd":"/tmp/project-admin","limit":50,"cursor":null,"archived":false,"sourceKinds":[]}}\n'));

  assert.equal(upstreamStdinWrites.length, 1);
  db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(sessionId);
  db.close();
  assert.equal(row.rollout_path, rolloutPath);
  assert.deepEqual(stderr.writes, []);
});

test('stdio proxy repairs blank thread titles before forwarding thread/list', () => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    return;
  }

  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-thread-list-title-repair-'));
  const sessionId = '019e2ae6-e189-7b20-9f67-dd05d2cf3b03';
  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '15');
  fs.mkdirSync(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, `rollout-2026-05-15T17-10-34-${sessionId}.jsonl`);
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({
      timestamp: '2026-05-15T17:10:34.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: '/tmp/project-admin' }
    }),
    JSON.stringify({
      timestamp: '2026-05-15T17:10:35.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: '新增移动端适配Demo页' }
    })
  ].join('\n') + '\n', 'utf8');

  const dbPath = path.join(codexHome, 'state_5.sqlite');
  let db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, first_user_message TEXT, preview TEXT)');
  db.prepare('INSERT INTO threads (id, rollout_path, cwd, title, first_user_message, preview) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sessionId, rolloutPath, '/tmp/project-admin', '', '', '');
  db.close();

  const stdin = new EventEmitter();
  const stdout = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const stderr = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const upstreamStdout = new EventEmitter();
  const upstreamStdinWrites = [];
  const child = new EventEmitter();
  child.stdin = {
    write(chunk) {
      upstreamStdinWrites.push(String(chunk || ''));
    },
    end() {}
  };
  child.stdout = upstreamStdout;

  const stateFile = path.join(codexHome, 'hook-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ enabled: true }), 'utf8');

  runCodexAppServerStdioProxy([
    '--upstream', '/tmp/original',
    '--state-file', stateFile,
    '--',
    'app-server'
  ], {
    fs,
    DatabaseSync,
    spawn: () => child,
    processObj: {
      env: {
        HOME: codexHome,
        CODEX_HOME: codexHome
      },
      pid: 999,
      stdin,
      stdout,
      stderr,
      exit(code) {
        throw new Error(`EXIT:${code}`);
      },
      kill() {
        throw new Error('signal should not be used');
      }
    }
  });

  stdin.emit('data', Buffer.from('{"id":"list-1","method":"thread/list","params":{"cwd":"/tmp/project-admin","limit":50,"cursor":null,"archived":false,"sourceKinds":[]}}\n'));

  assert.equal(upstreamStdinWrites.length, 1);
  db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare('SELECT title, first_user_message, preview FROM threads WHERE id = ?').get(sessionId);
  db.close();
  assert.equal(row.title, '新增移动端适配Demo页');
  assert.equal(row.first_user_message, '新增移动端适配Demo页');
  assert.equal(row.preview, '新增移动端适配Demo页');
  assert.deepEqual(stderr.writes, []);
});

test('restoreOptimizedRolloutPathInStateDbs moves hidden hydration rows back to canonical rollout', () => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    return;
  }

  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-rollout-restore-'));
  const sessionId = '019e2ae6-e189-7b20-9f67-dd05d2cf3b03';
  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '15');
  fs.mkdirSync(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, `rollout-2026-05-15T17-10-34-${sessionId}.jsonl`);
  const optimizedPath = `${rolloutPath}.aih-slim-2026-05-16T04-45-29-122Z-8795.jsonl`;
  fs.writeFileSync(rolloutPath, JSON.stringify({
    timestamp: '2026-05-15T17:10:34.000Z',
    type: 'session_meta',
    payload: { id: sessionId, cwd: '/tmp/project-admin' }
  }) + '\n', 'utf8');
  fs.writeFileSync(optimizedPath, fs.readFileSync(rolloutPath, 'utf8'), 'utf8');

  const dbPath = path.join(codexHome, 'state_5.sqlite');
  let db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT)');
  db.prepare('INSERT INTO threads (id, rollout_path, cwd, title) VALUES (?, ?, ?, ?)')
    .run(sessionId, optimizedPath, '/tmp/project-admin', 'Project admin');
  db.close();

  const result = restoreOptimizedRolloutPathInStateDbs({
    threadId: sessionId,
    originalPath: rolloutPath,
    optimizedPath
  }, { fs, codexHome, DatabaseSync });

  db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(sessionId);
  db.close();

  assert.equal(result.repaired, 1);
  assert.equal(row.rollout_path, rolloutPath);
});

test('shouldSuppressHydrationNotification filters only hidden resume thread lifecycle events', () => {
  const pending = new Map([['thread-1', { responseId: 'hydrate-1' }]]);

  assert.equal(shouldSuppressHydrationNotification({
    method: 'thread/started',
    params: { thread: { id: 'thread-1' } }
  }, pending), true);
  assert.equal(shouldSuppressHydrationNotification({
    method: 'thread/status/changed',
    params: { threadId: 'thread-1', status: { type: 'active', activeFlags: [] } }
  }, pending), true);
  assert.equal(shouldSuppressHydrationNotification({
    method: 'thread/tokenUsage/updated',
    params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: {} }
  }, pending), true);
  assert.equal(shouldSuppressHydrationNotification({
    method: 'thread/started',
    params: { thread: { id: 'thread-2' } }
  }, pending), false);
  assert.equal(shouldSuppressHydrationNotification({
    method: 'turn/started',
    params: { threadId: 'thread-1', turnId: 'turn-1' }
  }, pending), false);
  assert.equal(shouldSuppressHydrationNotification({
    id: 'hydrate-1',
    result: { thread: { id: 'thread-1' } }
  }, pending), false);
});

test('stdio proxy rewrites thread/list only when hook is enabled', () => {
  const stdin = new EventEmitter();
  const stdout = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const stderr = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const upstreamStdout = new EventEmitter();
  const upstreamStdinWrites = [];
  const child = new EventEmitter();
  child.stdin = {
    write(chunk) {
      upstreamStdinWrites.push(String(chunk || ''));
    },
    end() {}
  };
  child.stdout = upstreamStdout;

  runCodexAppServerStdioProxy([
    '--upstream', '/tmp/original',
    '--state-file', '/tmp/state.json',
    '--',
    'app-server'
  ], {
    fs: {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ enabled: true })
    },
    spawn: (command, args, options) => {
      assert.equal(command, '/tmp/original');
      assert.deepEqual(args, ['app-server']);
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
      return child;
    },
    processObj: {
      env: {},
      pid: 999,
      stdin,
      stdout,
      stderr,
      exit(code) {
        throw new Error(`EXIT:${code}`);
      },
      kill() {
        throw new Error('signal should not be used');
      }
    }
  });

  stdin.emit('data', Buffer.from('{"jsonrpc":"2.0","method":"thread/list","params":{"cwd":"/tmp/x"}}\n'));
  upstreamStdout.emit('data', Buffer.from('{"jsonrpc":"2.0","result":[]}\n'));

  const rewritten = JSON.parse(upstreamStdinWrites[0]);
  assert.deepEqual(rewritten.params.modelProviders, []);
  assert.equal(rewritten.params.useStateDbOnly, true);
  assert.deepEqual(stdout.writes, ['{"jsonrpc":"2.0","result":[]}\n']);
  assert.deepEqual(stderr.writes, []);
});

test('stdio proxy traces remote-control status and upstream stderr without full response tracing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-remote-trace-'));
  const statePath = path.join(root, 'state.json');
  const tracePath = path.join(root, 'trace.jsonl');
  fs.writeFileSync(statePath, JSON.stringify({
    enabled: true,
    traceFile: tracePath,
    traceResponses: false,
    traceRemoteControl: true
  }), 'utf8');

  const stdin = new EventEmitter();
  const stdout = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const stderr = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const upstreamStdout = new EventEmitter();
  const upstreamStderr = new EventEmitter();
  const upstreamStdinWrites = [];
  const child = new EventEmitter();
  child.stdin = {
    write(chunk) {
      upstreamStdinWrites.push(String(chunk || ''));
    },
    end() {}
  };
  child.stdout = upstreamStdout;
  child.stderr = upstreamStderr;

  try {
    runCodexAppServerStdioProxy([
      '--upstream', '/tmp/original',
      '--state-file', statePath,
      '--',
      'app-server'
    ], {
      spawn: () => child,
      processObj: {
        env: {
          HOME: root,
          CODEX_HOME: path.join(root, '.codex')
        },
        pid: 999,
        stdin,
        stdout,
        stderr,
        exit(code) {
          throw new Error(`EXIT:${code}`);
        },
        kill() {
          throw new Error('signal should not be used');
        }
      }
    });

    upstreamStdout.emit('data', Buffer.from('{"method":"remoteControl/status/changed","params":{"status":"connected","environmentId":"env_123"}}\n'));
    upstreamStderr.emit('data', Buffer.from('connected to app-server remote control websocket: wss://chatgpt.com/backend-api/wham/remote/control/server, request-id: req_1\n'));

    assert.equal(stdout.writes.length, 1);
    assert.equal(stderr.writes.join(''), 'connected to app-server remote control websocket: wss://chatgpt.com/backend-api/wham/remote/control/server, request-id: req_1\n');
    const traceEntries = fs.readFileSync(tracePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(traceEntries.some((entry) => entry.remoteControl && entry.summary && entry.summary.status === 'connected'), true);
    assert.equal(traceEntries.some((entry) => entry.direction === 'upstream_stderr' && entry.line.includes('remote control websocket')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stdio proxy patches tracked account/read response with a real local OAuth account', () => {
  const stdin = new EventEmitter();
  const stdout = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const stderr = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const upstreamStdout = new EventEmitter();
  const upstreamStdinWrites = [];
  const child = new EventEmitter();
  child.stdin = {
    write(chunk) {
      upstreamStdinWrites.push(String(chunk || ''));
    },
    end() {}
  };
  child.stdout = upstreamStdout;

  runCodexAppServerStdioProxy([
    '--upstream', '/tmp/original',
    '--state-file', '/tmp/state.json',
    '--',
    'app-server'
  ], {
    fs: {
      existsSync(filePath) {
        const normalized = String(filePath || '');
        return normalized === '/tmp/state.json'
          || normalized.endsWith('/.codex/config.toml')
          || normalized.endsWith('/.ai_home/profiles/codex/10038/.codex/auth.json');
      },
      readdirSync(filePath) {
        if (String(filePath || '').endsWith('/.ai_home/profiles/codex')) return ['10038'];
        return [];
      },
      statSync() {
        return { isDirectory: () => true };
      },
      readFileSync(filePath) {
        if (String(filePath || '') === '/tmp/state.json') {
          return JSON.stringify({ enabled: true });
        }
        if (String(filePath || '').endsWith('/.ai_home/profiles/codex/10038/.codex/auth.json')) {
          return JSON.stringify({
            tokens: {
              access_token: createJwt({
                'https://api.openai.com/profile': { email: 'desktop@example.com' },
                'https://api.openai.com/auth': {
                  chatgpt_plan_type: 'plus',
                  chatgpt_account_id: 'acc_desktop'
                }
              }),
              refresh_token: 'refresh-desktop'
            }
          });
        }
        return 'model_provider = "aih_10014"\nmodel = "gpt-5.5"\n';
      }
    },
    spawn: () => child,
    processObj: {
      platform: 'darwin',
      env: {
        HOME: '/tmp/home',
        CODEX_HOME: '/tmp/home/.codex'
      },
      pid: 999,
      stdin,
      stdout,
      stderr,
      exit(code) {
        throw new Error(`EXIT:${code}`);
      },
      kill() {
        throw new Error('signal should not be used');
      }
    }
  });

  stdin.emit('data', Buffer.from('{"id":"account-1","method":"account/read","params":{"refreshToken":false}}\n'));
  upstreamStdout.emit('data', Buffer.from('{"id":"account-1","result":{"account":null,"requiresOpenaiAuth":false}}\n'));

  assert.deepEqual(JSON.parse(upstreamStdinWrites[0]), {
    id: 'account-1',
    method: 'account/read',
    params: { refreshToken: false }
  });
  const patched = JSON.parse(stdout.writes[0]);
  assert.deepEqual(patched.result.account, {
    type: 'chatgpt',
    email: 'desktop@example.com',
    planType: 'plus'
  });
  assert.equal(patched.result.requiresOpenaiAuth, false);
  assert.deepEqual(stderr.writes, []);
});

test('patchAuthStatusResponse exposes desktop-only OAuth token for aih runtime', () => {
  const accessToken = createJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/profile': { email: 'desktop@example.com' },
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'plus',
      chatgpt_account_id: 'acc_desktop',
      chatgpt_account_user_id: 'user_acc_desktop'
    }
  });
  const fakeFs = {
    existsSync(filePath) {
      const normalized = String(filePath || '');
      return normalized.endsWith('/.codex/config.toml')
        || normalized.endsWith('/.ai_home/profiles/codex/10038/.codex/auth.json');
    },
    readdirSync(filePath) {
      if (String(filePath || '').endsWith('/.ai_home/profiles/codex')) return ['10038'];
      return [];
    },
    statSync() {
      return { isDirectory: () => true };
    },
    readFileSync(filePath) {
      if (String(filePath || '').endsWith('/.ai_home/profiles/codex/10038/.codex/auth.json')) {
        return JSON.stringify({
          tokens: {
            access_token: accessToken,
            refresh_token: 'refresh-desktop'
          }
        });
      }
      return 'model_provider = "aih_10014"\nmodel = "gpt-5.5"\n';
    }
  };

  const patched = JSON.parse(patchAuthStatusResponse(
    '{"id":"auth-1","result":{"authMethod":null,"authToken":null,"requiresOpenaiAuth":false}}',
    { includeToken: true },
    {
      fs: fakeFs,
      processObj: {
        platform: 'darwin',
        env: {
          HOME: '/tmp/home',
          CODEX_HOME: '/tmp/home/.codex'
        }
      }
    }
  ));

  assert.equal(patched.result.authMethod, 'chatgpt');
  assert.equal(patched.result.authToken, accessToken);
  assert.equal(patched.result.requiresOpenaiAuth, false);

  const withoutToken = JSON.parse(patchAuthStatusResponse(
    '{"id":"auth-2","result":{"authMethod":null,"authToken":null,"requiresOpenaiAuth":false}}',
    { includeToken: false },
    {
      fs: fakeFs,
      processObj: {
        platform: 'darwin',
        env: {
          HOME: '/tmp/home',
          CODEX_HOME: '/tmp/home/.codex'
        }
      }
    }
  ));
  assert.equal(withoutToken.result.authMethod, 'chatgpt');
  assert.equal(withoutToken.result.authToken, null);
});

test('patchAuthStatusResponse leaves api-key Codex App auth untouched', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-auth-status-apikey-'));
  const codexHome = path.join(tmpHome, '.codex');
  const apiKeyAccountDir = path.join(tmpHome, '.ai_home', 'profiles', 'codex', '1');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(apiKeyAccountDir, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model_provider = "aih_10"\nmodel = "gpt-5.5"\n', 'utf8');
  fs.writeFileSync(path.join(tmpHome, '.ai_home', 'profiles', 'codex', '.aih_default'), '1', 'utf8');
  fs.writeFileSync(path.join(apiKeyAccountDir, '.aih_env.json'), JSON.stringify({
    OPENAI_API_KEY: 'sk-api-key',
    OPENAI_BASE_URL: 'https://api.example.test/v1'
  }), 'utf8');
  fs.writeFileSync(path.join(apiKeyAccountDir, '.codex', 'auth.json'), JSON.stringify({
    OPENAI_API_KEY: 'sk-api-key'
  }), 'utf8');

  const patched = JSON.parse(patchAuthStatusResponse(
    '{"id":"auth-1","result":{"authMethod":null,"authToken":null,"requiresOpenaiAuth":false}}',
    { includeToken: true },
    {
      fs,
      processObj: {
        platform: 'darwin',
        env: {
          HOME: tmpHome,
          CODEX_HOME: codexHome
        }
      }
    }
  ));

  assert.equal(patched.result.authMethod, null);
  assert.equal(patched.result.authToken, null);
  assert.equal(patched.result.requiresOpenaiAuth, false);
});

test('buildCodexAppServerSpawnEnv gives upstream app-server a ChatGPT auth runtime home', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-runtime-'));
  const hostCodexHome = path.join(tmpHome, '.codex');
  const profileCodexHome = path.join(tmpHome, '.ai_home', 'profiles', 'codex', '10009', '.codex');
  fs.mkdirSync(hostCodexHome, { recursive: true });
  fs.mkdirSync(profileCodexHome, { recursive: true });
  fs.writeFileSync(path.join(hostCodexHome, 'config.toml'), [
    'preferred_auth_method = "apikey"',
    'model_provider = "aih_10"',
    'model = "gpt-5.5"',
    'cli_auth_credentials_store = "keyring"',
    '',
    '[model_providers.aih_10]',
    'name = "AIH 10"'
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(profileCodexHome, 'auth.json'), JSON.stringify({
    tokens: {
      access_token: createJwt({
        'https://api.openai.com/profile': { email: 'mobile@example.com' },
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'plus',
          chatgpt_account_id: 'acc_mobile'
        }
      }),
      refresh_token: 'refresh-mobile',
      account_id: 'acc_mobile'
    }
  }), 'utf8');

  const result = buildCodexAppServerSpawnEnv(fs, { enabled: true, desktopAccountId: '10009' }, {
    chatgptBaseUrl: 'http://127.0.0.1:18888/backend-api',
    processObj: {
      platform: 'darwin',
      env: {
        HOME: tmpHome,
        CODEX_HOME: hostCodexHome
      }
    }
  });

  assert.equal(result.runtime.accountId, '10009');
  assert.equal(result.env.CODEX_SQLITE_HOME, hostCodexHome);
  assert.match(result.env.CODEX_HOME, /codex-desktop-runtime\/app-server-10009$/);
  const runtimeAuth = JSON.parse(fs.readFileSync(path.join(result.env.CODEX_HOME, 'auth.json'), 'utf8'));
  assert.equal(runtimeAuth.auth_mode, 'chatgpt');
  assert.equal(runtimeAuth.OPENAI_API_KEY, undefined);
  assert.equal(runtimeAuth.tokens.refresh_token, 'refresh-mobile');
  assert.equal(runtimeAuth.tokens.account_id, 'acc_mobile');
  const runtimeConfig = fs.readFileSync(path.join(result.env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.match(runtimeConfig, /^model_provider = "aih_10"$/m);
  assert.match(runtimeConfig, /^chatgpt_base_url = "http:\/\/127\.0\.0\.1:18888\/backend-api"$/m);
  assert.match(runtimeConfig, new RegExp(`^sqlite_home = "${hostCodexHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm'));
  assert.match(runtimeConfig, /^cli_auth_credentials_store = "file"$/m);
  assert.equal(runtimeConfig.indexOf('cli_auth_credentials_store = "file"') < runtimeConfig.indexOf('[model_providers.aih_10]'), true);
});

test('buildCodexAppServerSpawnEnv prefers api-key Codex App accounts and avoids chatgpt runtime auth', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-runtime-apikey-'));
  const hostCodexHome = path.join(tmpHome, '.codex');
  const apiKeyProfileDir = path.join(tmpHome, '.ai_home', 'profiles', 'codex', '1');
  const oauthProfileDir = path.join(tmpHome, '.ai_home', 'profiles', 'codex', '4', '.codex');
  fs.mkdirSync(hostCodexHome, { recursive: true });
  fs.mkdirSync(path.join(apiKeyProfileDir, '.codex'), { recursive: true });
  fs.mkdirSync(oauthProfileDir, { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.ai_home', 'profiles', 'codex', '.aih_default'), '1', 'utf8');
  fs.writeFileSync(path.join(hostCodexHome, 'config.toml'), [
    'preferred_auth_method = "apikey"',
    'model_provider = "aih_10"',
    'model = "gpt-5.5"',
    'cli_auth_credentials_store = "keyring"',
    '',
    '[model_providers.aih_10]',
    'name = "AIH 10"'
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(apiKeyProfileDir, '.aih_env.json'), JSON.stringify({
    OPENAI_API_KEY: 'sk-api-key',
    OPENAI_BASE_URL: 'https://api.example.test/v1'
  }), 'utf8');
  fs.writeFileSync(path.join(apiKeyProfileDir, '.codex', 'auth.json'), JSON.stringify({
    OPENAI_API_KEY: 'sk-api-key'
  }), 'utf8');
  fs.writeFileSync(path.join(oauthProfileDir, 'auth.json'), JSON.stringify({
    tokens: {
      access_token: createJwt({
        'https://api.openai.com/profile': { email: 'fallback@example.com' },
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'plus',
          chatgpt_account_id: 'acc_fallback'
        }
      }),
      refresh_token: 'refresh-fallback',
      account_id: 'acc_fallback'
    }
  }), 'utf8');

  const result = buildCodexAppServerSpawnEnv(fs, { enabled: true }, {
    processObj: {
      platform: 'darwin',
      env: {
        HOME: tmpHome,
        CODEX_HOME: hostCodexHome
      }
    }
  });

  assert.equal(result.runtime.accountId, '1');
  assert.equal(result.runtime.authType, 'api-key');
  assert.equal(result.env.OPENAI_API_KEY, 'sk-api-key');
  assert.equal(result.env.OPENAI_BASE_URL, 'https://api.example.test/v1');
  assert.equal(result.env.CODEX_SQLITE_HOME, hostCodexHome);
  assert.match(result.env.CODEX_HOME, /codex-desktop-runtime\/app-server-1$/);
  const runtimeAuth = JSON.parse(fs.readFileSync(path.join(result.env.CODEX_HOME, 'auth.json'), 'utf8'));
  assert.equal(runtimeAuth.OPENAI_API_KEY, 'sk-api-key');
  assert.equal(runtimeAuth.auth_mode, undefined);
  assert.equal(runtimeAuth.tokens, undefined);
  const runtimeConfig = fs.readFileSync(path.join(result.env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.doesNotMatch(runtimeConfig, /^chatgpt_base_url = /m);
});

test('buildCodexAppServerSpawnEnv keeps state db home when hook CODEX_HOME is already runtime home', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-runtime-sqlite-home-'));
  const hostCodexHome = path.join(tmpHome, '.codex');
  const externalRuntimeHome = path.join(tmpHome, '.ai_home', 'codex-desktop-runtime', 'app-server-10009');
  const profileCodexHome = path.join(tmpHome, '.ai_home', 'profiles', 'codex', '10009', '.codex');
  fs.mkdirSync(hostCodexHome, { recursive: true });
  fs.mkdirSync(profileCodexHome, { recursive: true });
  fs.writeFileSync(path.join(hostCodexHome, 'config.toml'), [
    'model_provider = "aih_10"',
    'model = "gpt-5.5"'
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(profileCodexHome, 'auth.json'), JSON.stringify({
    tokens: {
      access_token: createJwt({
        'https://api.openai.com/profile': { email: 'mobile@example.com' },
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'plus',
          chatgpt_account_id: 'acc_mobile'
        }
      }),
      refresh_token: 'refresh-mobile',
      account_id: 'acc_mobile'
    }
  }), 'utf8');

  const result = buildCodexAppServerSpawnEnv(fs, { enabled: true, desktopAccountId: '10009' }, {
    processObj: {
      platform: 'darwin',
      env: {
        HOME: tmpHome,
        CODEX_HOME: externalRuntimeHome,
        CODEX_SQLITE_HOME: hostCodexHome
      }
    }
  });

  assert.equal(result.runtime.hostCodexHome, hostCodexHome);
  assert.equal(result.env.CODEX_SQLITE_HOME, hostCodexHome);
  assert.equal(result.env.CODEX_HOME, externalRuntimeHome);
  const runtimeConfig = fs.readFileSync(path.join(result.env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.match(runtimeConfig, new RegExp(`^sqlite_home = "${hostCodexHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm'));
  assert.doesNotMatch(runtimeConfig, new RegExp(`^sqlite_home = "${externalRuntimeHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm'));

  const fallbackResult = buildCodexAppServerSpawnEnv(fs, { enabled: true, desktopAccountId: '10009' }, {
    processObj: {
      platform: 'darwin',
      env: {
        HOME: tmpHome,
        CODEX_HOME: externalRuntimeHome
      }
    }
  });
  assert.equal(fallbackResult.runtime.hostCodexHome, hostCodexHome);
  assert.equal(fallbackResult.env.CODEX_SQLITE_HOME, hostCodexHome);
});

test('buildCodexAppServerSpawnEnv keeps original env when no desktop account auth is available', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-no-runtime-'));
  const hostCodexHome = path.join(tmpHome, '.codex');
  fs.mkdirSync(hostCodexHome, { recursive: true });
  fs.writeFileSync(path.join(hostCodexHome, 'config.toml'), 'model_provider = "aih_10"\nmodel = "gpt-5.5"\n', 'utf8');

  const result = buildCodexAppServerSpawnEnv(fs, { enabled: true }, {
    processObj: {
      platform: 'darwin',
      env: {
        HOME: tmpHome,
        CODEX_HOME: hostCodexHome,
        KEEP_ME: '1'
      }
    }
  });

  assert.equal(result.runtime, null);
  assert.equal(result.env.CODEX_HOME, hostCodexHome);
  assert.equal(result.env.CODEX_SQLITE_HOME, undefined);
  assert.equal(result.env.KEEP_ME, '1');
});

test('stdio proxy patches tracked getAuthStatus response without changing the upstream request', () => {
  const stdin = new EventEmitter();
  const stdout = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const stderr = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const upstreamStdout = new EventEmitter();
  const upstreamStdinWrites = [];
  const child = new EventEmitter();
  const fallbackAccessToken = createJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/profile': { email: 'desktop@example.com' },
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'team',
      chatgpt_account_id: 'acc_desktop',
      chatgpt_account_user_id: 'user_acc_desktop'
    }
  });
  const preferredAccessToken = createJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/profile': { email: 'preferred@example.com' },
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'plus',
      chatgpt_account_id: 'acc_preferred',
      chatgpt_account_user_id: 'user_acc_preferred'
    }
  });
  child.stdin = {
    write(chunk) {
      upstreamStdinWrites.push(String(chunk || ''));
    },
    end() {}
  };
  child.stdout = upstreamStdout;

  runCodexAppServerStdioProxy([
    '--upstream', '/tmp/original',
    '--state-file', '/tmp/state.json',
    '--',
    'app-server'
  ], {
    fs: {
      existsSync(filePath) {
        const normalized = String(filePath || '');
        return normalized === '/tmp/state.json'
          || normalized.endsWith('/.codex/config.toml')
          || normalized.endsWith('/.ai_home/profiles/codex/10009/.codex/auth.json')
          || normalized.endsWith('/.ai_home/profiles/codex/10038/.codex/auth.json');
      },
      readdirSync(filePath) {
        if (String(filePath || '').endsWith('/.ai_home/profiles/codex')) return ['10038', '10009'];
        return [];
      },
      statSync() {
        return { isDirectory: () => true };
      },
      readFileSync(filePath) {
        if (String(filePath || '') === '/tmp/state.json') {
          return JSON.stringify({ enabled: true, desktopAccountId: '10009' });
        }
        if (String(filePath || '').endsWith('/.ai_home/profiles/codex/10009/.codex/auth.json')) {
          return JSON.stringify({
            tokens: {
              access_token: preferredAccessToken,
              refresh_token: 'refresh-preferred'
            }
          });
        }
        if (String(filePath || '').endsWith('/.ai_home/profiles/codex/10038/.codex/auth.json')) {
          return JSON.stringify({
            tokens: {
              access_token: fallbackAccessToken,
              refresh_token: 'refresh-desktop'
            }
          });
        }
        return 'model_provider = "aih_10014"\nmodel = "gpt-5.5"\n';
      }
    },
    spawn: () => child,
    processObj: {
      platform: 'darwin',
      env: {
        HOME: '/tmp/home',
        CODEX_HOME: '/tmp/home/.codex'
      },
      pid: 999,
      stdin,
      stdout,
      stderr,
      exit(code) {
        throw new Error(`EXIT:${code}`);
      },
      kill() {
        throw new Error('signal should not be used');
      }
    }
  });

  stdin.emit('data', Buffer.from('{"id":"auth-1","method":"getAuthStatus","params":{"includeToken":true,"refreshToken":false}}\n'));
  upstreamStdout.emit('data', Buffer.from('{"id":"auth-1","result":{"authMethod":null,"authToken":null,"requiresOpenaiAuth":false}}\n'));

  assert.deepEqual(JSON.parse(upstreamStdinWrites[0]), {
    id: 'auth-1',
    method: 'getAuthStatus',
    params: { includeToken: true, refreshToken: false }
  });
  const patched = JSON.parse(stdout.writes[0]);
  assert.equal(patched.result.authMethod, 'chatgpt');
  assert.equal(patched.result.authToken, preferredAccessToken);
  assert.equal(patched.result.requiresOpenaiAuth, false);
  assert.deepEqual(stderr.writes, []);
});

test('stdio proxy downgrades thread/goal/get failures to a cached goal snapshot when available', () => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    return;
  }

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-goal-get-'));
  const codexHome = path.join(tmpHome, '.codex');
  const goalsDbPath = path.join(codexHome, 'goals_1.sqlite');
  const threadId = '019e4a55-9205-7e33-95d5-90e1077e5795';
  fs.mkdirSync(codexHome, { recursive: true });
  const db = new DatabaseSync(goalsDbPath);
  db.exec(`
    CREATE TABLE thread_goals (
      thread_id TEXT PRIMARY KEY NOT NULL,
      goal_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      token_budget INTEGER,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      time_used_seconds INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `);
  db.prepare(`
    INSERT INTO thread_goals (
      thread_id, goal_id, objective, status, token_budget,
      tokens_used, time_used_seconds, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    threadId,
    'goal-1',
    'Keep the current thread stable',
    'active',
    1200,
    30,
    12,
    1779363582469,
    1779364582469
  );
  db.close();

  const stdin = new EventEmitter();
  const stdout = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const stderr = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const upstreamStdout = new EventEmitter();
  const upstreamStdinWrites = [];
  const child = new EventEmitter();
  child.stdin = {
    write(chunk) {
      upstreamStdinWrites.push(String(chunk || ''));
    },
    end() {}
  };
  child.stdout = upstreamStdout;

  runCodexAppServerStdioProxy([
    '--upstream', '/tmp/original',
    '--state-file', '/tmp/state.json',
    '--',
    'app-server'
  ], {
    fs: {
      existsSync(filePath) {
        const normalized = String(filePath || '');
        return normalized === '/tmp/state.json'
          || normalized === goalsDbPath
          || normalized === codexHome;
      },
      statSync(filePath) {
        const normalized = String(filePath || '');
        if (normalized === goalsDbPath) return { isFile: () => true };
        if (normalized === codexHome) return { isDirectory: () => true };
        throw new Error(`missing stat for ${normalized}`);
      },
      readFileSync(filePath) {
        if (String(filePath || '') === '/tmp/state.json') {
          return JSON.stringify({ enabled: true });
        }
        throw new Error(`unexpected read: ${filePath}`);
      }
    },
    DatabaseSync,
    spawn: () => child,
    processObj: {
      platform: 'darwin',
      env: {
        HOME: tmpHome,
        CODEX_HOME: codexHome
      },
      pid: 999,
      stdin,
      stdout,
      stderr,
      exit(code) {
        throw new Error(`EXIT:${code}`);
      },
      kill() {
        throw new Error('signal should not be used');
      }
    }
  });

  stdin.emit('data', Buffer.from(`{"id":"goal-1","method":"thread/goal/get","params":{"threadId":"${threadId}"}}\n`));
  upstreamStdout.emit('data', Buffer.from('{"id":"goal-1","error":{"code":"internal_error","message":"failed to read thread goal: no such table: thread_goals"}}\n'));

  assert.deepEqual(JSON.parse(upstreamStdinWrites[0]), {
    id: 'goal-1',
    method: 'thread/goal/get',
    params: { threadId }
  });
  const patched = JSON.parse(stdout.writes[0]);
  assert.equal(patched.id, 'goal-1');
  assert.equal(patched.result.goal.threadId, threadId);
  assert.equal(patched.result.goal.objective, 'Keep the current thread stable');
  assert.equal(patched.result.goal.status, 'active');
  assert.equal(patched.result.goal.tokenBudget, 1200);
  assert.equal(patched.result.goal.tokensUsed, 30);
  assert.equal(patched.result.goal.timeUsedSeconds, 12);
  assert.equal(patched.result.goal.createdAt, 1779363582);
  assert.equal(patched.result.goal.updatedAt, 1779364582);
  assert.deepEqual(stderr.writes, []);
});

test('stdio proxy merges missing state-db threads into thread/list responses', () => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    return;
  }

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-thread-list-'));
  const codexHome = path.join(tmpHome, '.codex');
  const stateDbPath = path.join(codexHome, 'state_5.sqlite');
  const stateFilePath = path.join(tmpHome, '.ai_home', 'codex-desktop-hook-state.json');
  const threadId = '019e4a55-9205-7e33-95d5-90e1077e5795';
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(stateFilePath, JSON.stringify({ enabled: true }, null, 2), 'utf8');
  const db = new DatabaseSync(stateDbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY NOT NULL,
      rollout_path TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      source TEXT,
      model_provider TEXT,
      model TEXT,
      cwd TEXT,
      title TEXT,
      sandbox_policy TEXT,
      approval_mode TEXT,
      cli_version TEXT,
      first_user_message TEXT,
      agent_nickname TEXT,
      agent_role TEXT,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      reasoning_effort TEXT,
      thread_source TEXT,
      archived INTEGER DEFAULT 0
    )
  `);
  db.prepare(`
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
      source, model_provider, model, cwd, title, sandbox_policy, approval_mode,
      cli_version, first_user_message, agent_nickname, agent_role, git_sha,
      git_branch, git_origin_url, reasoning_effort, thread_source, archived
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    threadId,
    path.join(codexHome, 'sessions', '2026', '05', '21', `rollout-2026-05-21T19-39-42-${threadId}.jsonl`),
    1779363582,
    1779439999,
    1779363582469,
    1779439999469,
    'cli',
    'aih_1',
    'gpt-5.5',
    '/Users/model/projects/feature/ai_home',
    'please continue',
    '{"type":"danger-full-access"}',
    'never',
    '0.130.0',
    'please continue',
    null,
    null,
    '2ef4838c01925e86d1d646bcabab3d12a349f065',
    'main',
    'git@github.com:madou1217/ai_home.git',
    'high',
    'user',
    0
  );
  db.close();

  const stdin = new EventEmitter();
  const stdout = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const stderr = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const upstreamStdout = new EventEmitter();
  const upstreamStdinWrites = [];
  const child = new EventEmitter();
  child.stdin = {
    write(chunk) {
      upstreamStdinWrites.push(String(chunk || ''));
    },
    end() {}
  };
  child.stdout = upstreamStdout;
  child.stderr = new EventEmitter();

  runCodexAppServerStdioProxy([
    '--upstream', '/tmp/original',
    '--state-file', stateFilePath,
    '--',
    'app-server'
  ], {
    fs,
    DatabaseSync,
    spawn: () => child,
    processObj: {
      platform: 'darwin',
      env: {
        HOME: tmpHome,
        CODEX_HOME: path.join(tmpHome, '.ai_home', 'profiles', 'codex', '1', '.codex'),
        CODEX_SQLITE_HOME: codexHome
      },
      pid: 1001,
      stdin,
      stdout,
      stderr,
      exit(code) {
        throw new Error(`EXIT:${code}`);
      },
      kill() {
        throw new Error('signal should not be used');
      }
    }
  });

  stdin.emit('data', Buffer.from('{"id":"list-1","method":"thread/list","params":{"cwd":"/Users/model/projects/feature/ai_home","limit":50,"cursor":null,"archived":false,"sourceKinds":[]}}\n'));
  assert.equal(upstreamStdinWrites.length, 1);
  upstreamStdout.emit('data', Buffer.from('{"id":"list-1","result":{"data":[],"nextCursor":null,"backwardsCursor":null}}\n'));

  const patched = JSON.parse(stdout.writes[0]);
  const ids = (patched.result.data || []).map((item) => item.id);
  assert.equal(ids.includes(threadId), true);
  const target = (patched.result.data || []).find((item) => item.id === threadId);
  assert.equal(target.cwd, '/Users/model/projects/feature/ai_home');
  assert.equal(target.source, 'cli');
  assert.equal(target.modelProvider, 'aih_1');
  assert.equal(target.title, 'please continue');
  assert.deepEqual(stderr.writes, []);
});

test('stdio proxy lists shared sessions beyond unfiltered exec rows', () => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    return;
  }

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-thread-list-filtered-'));
  const codexHome = path.join(tmpHome, '.codex');
  const stateDbPath = path.join(codexHome, 'state_5.sqlite');
  const stateFilePath = path.join(tmpHome, '.ai_home', 'codex-desktop-hook-state.json');
  const cwd = '/Users/model/projects/feature/ai_home';
  const targetThreadId = '019e3e82-fddf-7ae2-b679-c3a93e008e05';
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(stateFilePath, JSON.stringify({ enabled: true }, null, 2), 'utf8');

  const db = new DatabaseSync(stateDbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY NOT NULL,
      rollout_path TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      source TEXT,
      model_provider TEXT,
      model TEXT,
      cwd TEXT,
      title TEXT,
      sandbox_policy TEXT,
      approval_mode TEXT,
      cli_version TEXT,
      first_user_message TEXT,
      agent_nickname TEXT,
      agent_role TEXT,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      reasoning_effort TEXT,
      thread_source TEXT,
      archived INTEGER DEFAULT 0
    )
  `);
  const insert = db.prepare(`
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
      source, model_provider, model, cwd, title, sandbox_policy, approval_mode,
      cli_version, first_user_message, agent_nickname, agent_role, git_sha,
      git_branch, git_origin_url, reasoning_effort, thread_source, archived
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let index = 0; index < 260; index += 1) {
    insert.run(
      `exec-${index}`,
      path.join(codexHome, 'sessions', `exec-${index}.jsonl`),
      1779500000 + index,
      1779500000 + index,
      1779500000000 + index,
      1779500000000 + index,
      'exec',
      'openai',
      'gpt-5.5',
      cwd,
      `exec ${index}`,
      '{"type":"danger-full-access"}',
      'never',
      '0.132.0',
      `exec ${index}`,
      null,
      null,
      null,
      null,
      null,
      'high',
      'user',
      0
    );
  }
  insert.run(
    targetThreadId,
    path.join(codexHome, 'sessions', 'rollout-target.jsonl'),
    1779300000,
    1779300000,
    1779300000000,
    1779300000000,
    'cli',
    'openai',
    'gpt-5.5',
    cwd,
    'expected shared session',
    '{"type":"danger-full-access"}',
    'never',
    '0.132.0',
    'expected shared session',
    null,
    null,
    null,
    null,
    null,
    'high',
    'user',
    0
  );
  db.close();

  const stdin = new EventEmitter();
  const stdout = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const stderr = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const upstreamStdout = new EventEmitter();
  const upstreamStdinWrites = [];
  const child = new EventEmitter();
  child.stdin = {
    write(chunk) {
      upstreamStdinWrites.push(String(chunk || ''));
    },
    end() {}
  };
  child.stdout = upstreamStdout;
  child.stderr = new EventEmitter();

  runCodexAppServerStdioProxy([
    '--upstream', '/tmp/original',
    '--state-file', stateFilePath,
    '--',
    'app-server'
  ], {
    fs,
    DatabaseSync,
    spawn: () => child,
    processObj: {
      platform: 'darwin',
      env: {
        HOME: tmpHome,
        CODEX_HOME: path.join(tmpHome, '.ai_home', 'profiles', 'codex', '1', '.codex'),
        CODEX_SQLITE_HOME: codexHome
      },
      pid: 1001,
      stdin,
      stdout,
      stderr,
      exit(code) {
        throw new Error(`EXIT:${code}`);
      },
      kill() {
        throw new Error('signal should not be used');
      }
    }
  });

  stdin.emit('data', Buffer.from(JSON.stringify({
    id: 'list-1',
    method: 'thread/list',
    params: {
      cwd,
      limit: 50,
      cursor: null,
      archived: false,
      sourceKinds: ['cli', 'vscode'],
      modelProviders: ['aih_1']
    }
  }) + '\n'));

  const upstreamRequest = JSON.parse(upstreamStdinWrites[0]);
  assert.deepEqual(upstreamRequest.params.modelProviders, []);
  assert.equal(upstreamRequest.params.useStateDbOnly, true);
  upstreamStdout.emit('data', Buffer.from('{"id":"list-1","result":{"data":[],"nextCursor":null,"backwardsCursor":null}}\n'));

  const patched = JSON.parse(stdout.writes[0]);
  const ids = (patched.result.data || []).map((item) => item.id);
  assert.equal(ids.includes(targetThreadId), true);
  assert.equal(ids.some((id) => String(id).startsWith('exec-')), false);
  assert.deepEqual(stderr.writes, []);
});

test('stdio proxy fast resume hydrates upstream without temporary rollout files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fast-resume-'));
  const rolloutPath = path.join(tmpDir, 'rollout-2026-05-09T00-00-00-thread-1.jsonl');
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({ timestamp: '2026-05-09T00:00:00.000Z', type: 'session_meta', payload: { id: 'thread-1', timestamp: '2026-05-09T00:00:00.000Z', cwd: '/tmp/project' } }),
    JSON.stringify({ timestamp: '2026-05-09T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }),
    JSON.stringify({ timestamp: '2026-05-09T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'resume hello', images: [], local_images: [], text_elements: [] } }),
    JSON.stringify({ timestamp: '2026-05-09T00:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'resume world', phase: 'final_answer', memory_citation: null } }),
    JSON.stringify({ timestamp: '2026-05-09T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } })
  ].join('\n'));
  const originalRolloutBytes = fs.statSync(rolloutPath).size;

  class FakeDatabase {
    exec() {}
    prepare(sql) {
      if (sql.includes('SELECT model_provider, model FROM threads')) {
        return { get: () => ({ model_provider: 'aih', model: 'gpt-5.4' }) };
      }
      if (sql.includes('FROM threads')) {
        return {
          get() {
            return {
              id: 'thread-1',
              rollout_path: rolloutPath,
              created_at: 1778284800,
              updated_at: 1778284803,
              source: 'cli',
              model_provider: 'aih',
              model: 'gpt-5.4',
              cwd: '/tmp/project',
              title: 'Title',
              sandbox_policy: '{"type":"danger-full-access"}',
              approval_mode: 'never',
              cli_version: '0.128.0',
              first_user_message: 'resume hello',
              reasoning_effort: 'high'
            };
          }
        };
      }
      return {
        run() {
          throw new Error('state db should not be mutated');
        }
      };
    }
    close() {}
  }

  const stdin = new EventEmitter();
  const stdout = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const stderr = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const upstreamStdout = new EventEmitter();
  const upstreamStdinWrites = [];
  const child = new EventEmitter();
  child.stdin = {
    write(chunk) {
      upstreamStdinWrites.push(String(chunk || ''));
    },
    end() {}
  };
  child.stdout = upstreamStdout;

  runCodexAppServerStdioProxy([
    '--upstream', '/tmp/original',
    '--state-file', '/tmp/state.json',
    '--',
    'app-server'
  ], {
    fs: {
      existsSync: () => true,
      readFileSync(filePath) {
        if (String(filePath).endsWith('config.toml')) {
          return 'model_provider = "aih_10"\nmodel = "gpt-5.5"\n';
        }
        return JSON.stringify({ enabled: true });
      },
      readdirSync: () => ['state_5.sqlite'],
      statSync: fs.statSync.bind(fs),
      openSync: fs.openSync.bind(fs),
      readSync: fs.readSync.bind(fs),
      closeSync: fs.closeSync.bind(fs)
    },
    DatabaseSync: FakeDatabase,
    fastReadMinBytes: 1,
    fastReadInitialBytes: 4096,
    fastReadMaxBytes: 4096,
    spawn: () => child,
    processObj: {
      env: { CODEX_HOME: '/tmp/codex' },
      pid: 999,
      stdin,
      stdout,
      stderr,
      exit(code) {
        throw new Error(`EXIT:${code}`);
      },
      kill() {
        throw new Error('signal should not be used');
      }
    }
  });

  stdin.emit('data', Buffer.from('{"id":"resume-1","method":"thread/resume","params":{"threadId":"thread-1"}}\n'));

  assert.equal(upstreamStdinWrites.length, 1);
  const hydrationRequest = JSON.parse(upstreamStdinWrites[0]);
  assert.equal(hydrationRequest.id, 'aih-hydrate-thread-resume:resume-1:1');
  assert.equal(hydrationRequest.method, 'thread/resume');
  assert.equal(hydrationRequest.params.threadId, 'thread-1');
  assert.equal(hydrationRequest.params.excludeTurns, true);
  assert.equal(hydrationRequest.params.modelProvider, 'aih_10');
  assert.equal(hydrationRequest.params.model, 'gpt-5.5');
  assert.equal(fs.statSync(rolloutPath).size, originalRolloutBytes);
  assert.equal(Object.prototype.hasOwnProperty.call(hydrationRequest.params, 'path'), false);
  assert.equal(fs.readdirSync(tmpDir).some((entryName) => entryName.includes('.aih-slim-')), false);
  assert.equal(stdout.writes.length, 1);
  const payload = JSON.parse(stdout.writes[0]);
  assert.equal(payload.id, 'resume-1');
  assert.equal(payload.result.modelProvider, 'aih_10');
  assert.equal(payload.result.model, 'gpt-5.5');
  assert.equal(payload.result.thread.status.type, 'idle');
  assert.equal(payload.result.thread.turns.length, 1);
  upstreamStdout.emit('data', Buffer.from(JSON.stringify({
    method: 'thread/started',
    params: {
      thread: { id: 'thread-1', status: { type: 'idle' } }
    }
  }) + '\n'));
  upstreamStdout.emit('data', Buffer.from(JSON.stringify({
    method: 'thread/status/changed',
    params: {
      threadId: 'thread-1',
      status: { type: 'active', activeFlags: [] }
    }
  }) + '\n'));
  upstreamStdout.emit('data', Buffer.from(JSON.stringify({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-1',
      turnId: 'old-turn',
      tokenUsage: {}
    }
  }) + '\n'));
  assert.equal(stdout.writes.length, 1);
  stdin.emit('data', Buffer.from('{"id":"turn-1","method":"turn/start","params":{"threadId":"thread-1","input":[]}}\n'));
  assert.equal(upstreamStdinWrites.length, 1);
  stdin.emit('data', Buffer.from('{"id":"steer-1","method":"turn/steer","params":{"threadId":"thread-1","expectedTurnId":"active-turn-1","input":[{"type":"text","text":"more"}]}}\n'));
  assert.equal(upstreamStdinWrites.length, 1);
  upstreamStdout.emit('data', Buffer.from(JSON.stringify({
    id: hydrationRequest.id,
    result: {
      thread: { id: 'thread-1', turns: [] },
      modelProvider: 'aih_10',
      model: 'gpt-5.5'
    }
  }) + '\n'));
  assert.equal(stdout.writes.length, 1);
  assert.equal(upstreamStdinWrites.length, 3);
  const queuedTurn = JSON.parse(upstreamStdinWrites[1]);
  assert.equal(queuedTurn.id, 'turn-1');
  assert.equal(queuedTurn.method, 'turn/start');
  assert.equal(queuedTurn.params.threadId, 'thread-1');
  const queuedSteer = JSON.parse(upstreamStdinWrites[2]);
  assert.equal(queuedSteer.id, 'steer-1');
  assert.equal(queuedSteer.method, 'turn/steer');
  assert.equal(queuedSteer.params.threadId, 'thread-1');
  assert.equal(queuedSteer.params.expectedTurnId, 'active-turn-1');
  assert.equal(queuedSteer.params.input[0].text, 'more');
  assert.deepEqual(stderr.writes, []);
});

test('stdio proxy hydrates persisted thread before retrying turn/start when live state is missing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-turn-hydrate-'));
  const rolloutPath = path.join(tmpDir, 'rollout.jsonl');
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({ timestamp: '2026-05-09T00:00:00.000Z', type: 'session_meta', payload: { id: 'thread-1', timestamp: '2026-05-09T00:00:00.000Z', cwd: '/tmp/project' } }),
    JSON.stringify({ timestamp: '2026-05-09T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'old hello', images: [], local_images: [], text_elements: [] } })
  ].join('\n'));

  class FakeDatabase {
    exec() {}
    prepare(sql) {
      if (sql.includes('SELECT model_provider, model FROM threads')) {
        return { get: () => ({ model_provider: 'aih', model: 'gpt-5.4' }) };
      }
      if (sql.includes('FROM threads')) {
        return {
          get() {
            return {
              id: 'thread-1',
              rollout_path: rolloutPath,
              created_at: 1778284800,
              updated_at: 1778284803,
              source: 'cli',
              model_provider: 'aih',
              model: 'gpt-5.4',
              cwd: '/tmp/project',
              title: 'Title',
              sandbox_policy: '{"type":"danger-full-access"}',
              approval_mode: 'never',
              cli_version: '0.128.0',
              first_user_message: 'old hello',
              reasoning_effort: 'high'
            };
          }
        };
      }
      return { run() {} };
    }
    close() {}
  }

  const stdin = new EventEmitter();
  const stdout = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const stderr = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const upstreamStdout = new EventEmitter();
  const upstreamStdinWrites = [];
  const child = new EventEmitter();
  child.stdin = {
    write(chunk) {
      upstreamStdinWrites.push(String(chunk || ''));
    },
    end() {}
  };
  child.stdout = upstreamStdout;

  runCodexAppServerStdioProxy([
    '--upstream', '/tmp/original',
    '--state-file', '/tmp/state.json',
    '--',
    'app-server'
  ], {
    fs: {
      existsSync: () => true,
      readFileSync(filePath) {
        if (String(filePath).endsWith('config.toml')) {
          return 'model_provider = "aih_10"\nmodel = "gpt-5.5"\n';
        }
        return JSON.stringify({ enabled: true });
      },
      readdirSync: () => ['state_5.sqlite'],
      statSync: fs.statSync.bind(fs),
      openSync: fs.openSync.bind(fs),
      readSync: fs.readSync.bind(fs),
      closeSync: fs.closeSync.bind(fs),
      copyFileSync: fs.copyFileSync.bind(fs),
      writeFileSync: fs.writeFileSync.bind(fs),
      renameSync: fs.renameSync.bind(fs),
      unlinkSync: fs.unlinkSync.bind(fs)
    },
    DatabaseSync: FakeDatabase,
    spawn: () => child,
    processObj: {
      env: { CODEX_HOME: '/tmp/codex' },
      pid: 999,
      stdin,
      stdout,
      stderr,
      exit(code) {
        throw new Error(`EXIT:${code}`);
      },
      kill() {
        throw new Error('signal should not be used');
      }
    }
  });

  stdin.emit('data', Buffer.from('{"id":"turn-1","method":"turn/start","params":{"threadId":"thread-1","input":[{"type":"text","text":"retry"}]}}\n'));

  assert.equal(upstreamStdinWrites.length, 1);
  const hydrationRequest = JSON.parse(upstreamStdinWrites[0]);
  assert.equal(hydrationRequest.id, 'aih-hydrate-turn-start:turn-1:1');
  assert.equal(hydrationRequest.method, 'thread/resume');
  assert.equal(hydrationRequest.params.threadId, 'thread-1');
  assert.equal(hydrationRequest.params.excludeTurns, true);
  assert.equal(hydrationRequest.params.modelProvider, 'aih_10');
  assert.equal(hydrationRequest.params.model, 'gpt-5.5');
  assert.equal(stdout.writes.length, 0);

  upstreamStdout.emit('data', Buffer.from(JSON.stringify({
    id: hydrationRequest.id,
    result: {
      thread: { id: 'thread-1', turns: [] },
      modelProvider: 'aih_10',
      model: 'gpt-5.5'
    }
  }) + '\n'));

  assert.equal(stdout.writes.length, 0);
  assert.equal(upstreamStdinWrites.length, 2);
  const forwardedTurn = JSON.parse(upstreamStdinWrites[1]);
  assert.equal(forwardedTurn.id, 'turn-1');
  assert.equal(forwardedTurn.method, 'turn/start');
  assert.equal(forwardedTurn.params.threadId, 'thread-1');
  assert.equal(forwardedTurn.params.input[0].text, 'retry');
  assert.deepEqual(stderr.writes, []);
});

test('stdio proxy hydrates persisted thread and recovers stale turn/steer as turn/start', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-steer-hydrate-'));
  const rolloutPath = path.join(tmpDir, 'rollout.jsonl');
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({ timestamp: '2026-05-09T00:00:00.000Z', type: 'session_meta', payload: { id: 'thread-1', timestamp: '2026-05-09T00:00:00.000Z', cwd: '/tmp/project' } }),
    JSON.stringify({ timestamp: '2026-05-09T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'old hello', images: [], local_images: [], text_elements: [] } })
  ].join('\n'));

  class FakeDatabase {
    exec() {}
    prepare(sql) {
      if (sql.includes('SELECT model_provider, model FROM threads')) {
        return { get: () => ({ model_provider: 'aih', model: 'gpt-5.4' }) };
      }
      if (sql.includes('FROM threads')) {
        return {
          get() {
            return {
              id: 'thread-1',
              rollout_path: rolloutPath,
              created_at: 1778284800,
              updated_at: 1778284803,
              source: 'cli',
              model_provider: 'aih',
              model: 'gpt-5.4',
              cwd: '/tmp/project',
              title: 'Title',
              sandbox_policy: '{"type":"danger-full-access"}',
              approval_mode: 'never',
              cli_version: '0.128.0',
              first_user_message: 'old hello',
              reasoning_effort: 'high'
            };
          }
        };
      }
      return { run() {} };
    }
    close() {}
  }

  const stdin = new EventEmitter();
  const stdout = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const stderr = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const upstreamStdout = new EventEmitter();
  const upstreamStdinWrites = [];
  const child = new EventEmitter();
  child.stdin = {
    write(chunk) {
      upstreamStdinWrites.push(String(chunk || ''));
    },
    end() {}
  };
  child.stdout = upstreamStdout;

  runCodexAppServerStdioProxy([
    '--upstream', '/tmp/original',
    '--state-file', '/tmp/state.json',
    '--',
    'app-server'
  ], {
    fs: {
      existsSync: () => true,
      readFileSync(filePath) {
        if (String(filePath).endsWith('config.toml')) {
          return 'model_provider = "aih_10"\nmodel = "gpt-5.5"\n';
        }
        return JSON.stringify({ enabled: true });
      },
      readdirSync: () => ['state_5.sqlite'],
      statSync: fs.statSync.bind(fs),
      openSync: fs.openSync.bind(fs),
      readSync: fs.readSync.bind(fs),
      closeSync: fs.closeSync.bind(fs),
      copyFileSync: fs.copyFileSync.bind(fs),
      writeFileSync: fs.writeFileSync.bind(fs),
      renameSync: fs.renameSync.bind(fs),
      unlinkSync: fs.unlinkSync.bind(fs)
    },
    DatabaseSync: FakeDatabase,
    spawn: () => child,
    processObj: {
      env: { CODEX_HOME: '/tmp/codex' },
      pid: 999,
      stdin,
      stdout,
      stderr,
      exit(code) {
        throw new Error(`EXIT:${code}`);
      },
      kill() {
        throw new Error('signal should not be used');
      }
    }
  });

  stdin.emit('data', Buffer.from('{"id":"steer-1","method":"turn/steer","params":{"threadId":"thread-1","expectedTurnId":"active-turn-1","input":[{"type":"text","text":"retry steer"}]}}\n'));

  assert.equal(upstreamStdinWrites.length, 1);
  const hydrationRequest = JSON.parse(upstreamStdinWrites[0]);
  assert.equal(hydrationRequest.id, 'aih-hydrate-turn-start:steer-1:1');
  assert.equal(hydrationRequest.method, 'thread/resume');
  assert.equal(hydrationRequest.params.threadId, 'thread-1');
  assert.equal(hydrationRequest.params.excludeTurns, true);
  assert.equal(hydrationRequest.params.modelProvider, 'aih_10');
  assert.equal(hydrationRequest.params.model, 'gpt-5.5');
  assert.equal(stdout.writes.length, 0);

  upstreamStdout.emit('data', Buffer.from(JSON.stringify({
    id: hydrationRequest.id,
    result: {
      thread: { id: 'thread-1', turns: [] },
      modelProvider: 'aih_10',
      model: 'gpt-5.5'
    }
  }) + '\n'));

  assert.equal(stdout.writes.length, 0);
  assert.equal(upstreamStdinWrites.length, 2);
  const forwardedStart = JSON.parse(upstreamStdinWrites[1]);
  assert.equal(forwardedStart.id, 'steer-1');
  assert.equal(forwardedStart.method, 'turn/start');
  assert.equal(forwardedStart.params.threadId, 'thread-1');
  assert.equal(Object.prototype.hasOwnProperty.call(forwardedStart.params, 'expectedTurnId'), false);
  assert.equal(forwardedStart.params.input[0].text, 'retry steer');
  assert.deepEqual(stderr.writes, []);
});

test('stdio proxy forwards turn/steer unchanged while an active turn is tracked', () => {
  const stdin = new EventEmitter();
  const stdout = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const stderr = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const upstreamStdout = new EventEmitter();
  const upstreamStdinWrites = [];
  const child = new EventEmitter();
  child.stdin = {
    write(chunk) {
      upstreamStdinWrites.push(String(chunk || ''));
    },
    end() {}
  };
  child.stdout = upstreamStdout;

  runCodexAppServerStdioProxy([
    '--upstream', '/tmp/original',
    '--state-file', '/tmp/state.json',
    '--',
    'app-server'
  ], {
    fs: {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ enabled: true })
    },
    spawn: () => child,
    processObj: {
      env: {},
      pid: 999,
      stdin,
      stdout,
      stderr,
      exit(code) {
        throw new Error(`EXIT:${code}`);
      },
      kill() {
        throw new Error('signal should not be used');
      }
    }
  });

  upstreamStdout.emit('data', Buffer.from(JSON.stringify({
    method: 'turn/started',
    params: {
      threadId: 'thread-1',
      turnId: 'active-turn-1'
    }
  }) + '\n'));
  stdin.emit('data', Buffer.from('{"id":"steer-1","method":"turn/steer","params":{"threadId":"thread-1","expectedTurnId":"active-turn-1","input":[{"type":"text","text":"still active"}]}}\n'));

  assert.equal(upstreamStdinWrites.length, 1);
  const forwardedSteer = JSON.parse(upstreamStdinWrites[0]);
  assert.equal(forwardedSteer.id, 'steer-1');
  assert.equal(forwardedSteer.method, 'turn/steer');
  assert.equal(forwardedSteer.params.threadId, 'thread-1');
  assert.equal(forwardedSteer.params.expectedTurnId, 'active-turn-1');
  assert.equal(forwardedSteer.params.input[0].text, 'still active');
  assert.deepEqual(stderr.writes, []);
});

test('stdio proxy rewrites turn/steer after completion or idle clears active tracking', () => {
  const stdin = new EventEmitter();
  const stdout = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const stderr = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const upstreamStdout = new EventEmitter();
  const upstreamStdinWrites = [];
  const child = new EventEmitter();
  child.stdin = {
    write(chunk) {
      upstreamStdinWrites.push(String(chunk || ''));
    },
    end() {}
  };
  child.stdout = upstreamStdout;

  runCodexAppServerStdioProxy([
    '--upstream', '/tmp/original',
    '--state-file', '/tmp/state.json',
    '--',
    'app-server'
  ], {
    fs: {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ enabled: true })
    },
    spawn: () => child,
    processObj: {
      env: {},
      pid: 999,
      stdin,
      stdout,
      stderr,
      exit(code) {
        throw new Error(`EXIT:${code}`);
      },
      kill() {
        throw new Error('signal should not be used');
      }
    }
  });

  upstreamStdout.emit('data', Buffer.from(JSON.stringify({
    method: 'turn/started',
    params: {
      threadId: 'thread-1',
      turnId: 'active-turn-1'
    }
  }) + '\n'));
  upstreamStdout.emit('data', Buffer.from(JSON.stringify({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'active-turn-1'
    }
  }) + '\n'));
  stdin.emit('data', Buffer.from('{"id":"steer-1","method":"turn/steer","params":{"threadId":"thread-1","expectedTurnId":"active-turn-1","input":[{"type":"text","text":"new turn"}]}}\n'));

  assert.equal(upstreamStdinWrites.length, 1);
  const forwardedStart = JSON.parse(upstreamStdinWrites[0]);
  assert.equal(forwardedStart.id, 'steer-1');
  assert.equal(forwardedStart.method, 'turn/start');
  assert.equal(forwardedStart.params.threadId, 'thread-1');
  assert.equal(Object.prototype.hasOwnProperty.call(forwardedStart.params, 'expectedTurnId'), false);
  assert.equal(forwardedStart.params.input[0].text, 'new turn');
  upstreamStdout.emit('data', Buffer.from(JSON.stringify({
    method: 'turn/started',
    params: {
      threadId: 'thread-1',
      turnId: 'active-turn-2'
    }
  }) + '\n'));
  upstreamStdout.emit('data', Buffer.from(JSON.stringify({
    method: 'thread/status/changed',
    params: {
      threadId: 'thread-1',
      status: { type: 'idle' }
    }
  }) + '\n'));
  stdin.emit('data', Buffer.from('{"id":"steer-2","method":"turn/steer","params":{"threadId":"thread-1","expectedTurnId":"active-turn-2","input":[{"type":"text","text":"idle cleared"}]}}\n'));
  assert.equal(upstreamStdinWrites.length, 2);
  const idleClearedStart = JSON.parse(upstreamStdinWrites[1]);
  assert.equal(idleClearedStart.id, 'steer-2');
  assert.equal(idleClearedStart.method, 'turn/start');
  assert.equal(Object.prototype.hasOwnProperty.call(idleClearedStart.params, 'expectedTurnId'), false);
  assert.equal(idleClearedStart.params.input[0].text, 'idle cleared');
  assert.deepEqual(stderr.writes, []);
});

test('stdio proxy aggregates cwd thread/list pages with bounded total size', () => {
  const stdin = new EventEmitter();
  const stdout = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const stderr = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const upstreamStdout = new EventEmitter();
  const upstreamStdinWrites = [];
  const child = new EventEmitter();
  child.stdin = {
    write(chunk) {
      upstreamStdinWrites.push(String(chunk || ''));
    },
    end() {}
  };
  child.stdout = upstreamStdout;

  runCodexAppServerStdioProxy([
    '--upstream', '/tmp/original',
    '--state-file', '/tmp/state.json',
    '--',
    'app-server'
  ], {
    fs: {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ enabled: true })
    },
    spawn: () => child,
    processObj: {
      env: {},
      pid: 999,
      stdin,
      stdout,
      stderr,
      exit(code) {
        throw new Error(`EXIT:${code}`);
      },
      kill() {
        throw new Error('signal should not be used');
      }
    }
  });

  stdin.emit('data', Buffer.from('{"id":"list-1","method":"thread/list","params":{"cwd":"/tmp/x","limit":50,"cursor":null,"archived":false,"sourceKinds":["cli","vscode"]}}\n'));

  const firstRequest = JSON.parse(upstreamStdinWrites[0]);
  assert.equal(firstRequest.params.limit, 50);
  assert.deepEqual(firstRequest.params.modelProviders, []);
  assert.equal(firstRequest.params.useStateDbOnly, true);

  upstreamStdout.emit('data', Buffer.from('{"id":"list-1","result":{"data":[{"id":"1"},{"id":"2"}],"nextCursor":"cursor-2","backwardsCursor":"back-1"}}\n'));

  const secondRequest = JSON.parse(upstreamStdinWrites[1]);
  assert.equal(secondRequest.id, 'aih-aggregate-thread-list:list-1:2');
  assert.equal(secondRequest.params.cursor, 'cursor-2');
  assert.equal(secondRequest.params.limit, AGGREGATE_THREAD_LIST_MAX_ITEMS - 50);

  upstreamStdout.emit('data', Buffer.from('{"id":"aih-aggregate-thread-list:list-1:2","result":{"data":[{"id":"2"},{"id":"3"}],"nextCursor":"cursor-3","backwardsCursor":"back-2"}}\n'));

  const payload = JSON.parse(stdout.writes[0]);
  assert.equal(payload.id, 'list-1');
  assert.deepEqual(payload.result.data.map((item) => item.id), ['1', '2', '3']);
  assert.equal(payload.result.backwardsCursor, 'back-1');
  assert.equal(payload.result.nextCursor, 'cursor-3');
  assert.deepEqual(stderr.writes, []);
});

test('stdio proxy thread/list trace summary includes returned thread ids', () => {
  const summary = summarizeJsonRpcForTrace({
    id: 'list-1',
    result: {
      data: [
        { id: 'thread-1', updatedAt: 123, modelProvider: 'aih_10', source: 'vscode' },
        { sessionId: 'thread-2', updated_at_ms: 122, model_provider: 'openai', thread_source: 'user' }
      ],
      nextCursor: 'cursor-next',
      backwardsCursor: 'cursor-back'
    }
  });

  assert.equal(summary.resultDataLength, 2);
  assert.deepEqual(summary.resultThreadIds, ['thread-1', 'thread-2']);
  assert.equal(summary.resultThreads[0].updatedAt, 123);
  assert.equal(summary.resultThreads[1].threadSource, 'user');
  assert.equal(summary.nextCursorValue, 'cursor-next');
  assert.equal(summary.backwardsCursorValue, 'cursor-back');
});
