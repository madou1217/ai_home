const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  SessionLifecycleError,
  createProviderSessionLifecycleRegistry,
  createSessionLifecycleService
} = require('../lib/server/session-lifecycle');
const {
  createCodexNativeLifecycleStrategy
} = require('../lib/server/session-lifecycle/codex-native-strategy');
const {
  createLegacyArchiveRecovery
} = require('../lib/server/session-lifecycle/legacy-archive-recovery');
const {
  buildCodexHostLifecycleEnv,
  createCodexLifecycleStdioClient
} = require('../lib/server/session-lifecycle/codex-stdio-client');
const {
  createSessionIdentityResolver,
  createSessionLifecycleComposition
} = require('../lib/server/session-lifecycle/composition');

function nativeCapabilities(overrides = {}) {
  return {
    workflowAvailable: true,
    operations: {
      archive: { support: 'native', available: true },
      listArchived: { support: 'native', available: true },
      unarchive: { support: 'native', available: true }
    },
    ...overrides
  };
}

test('session lifecycle service resolves native session identity without account binding', async () => {
  const calls = [];
  const strategy = {
    provider: 'codex',
    capabilities: async () => nativeCapabilities(),
    archive: async (input) => {
      calls.push(input);
      return { archived: true };
    },
    listArchived: async () => [],
    unarchive: async () => ({ unarchived: true })
  };
  const service = createSessionLifecycleService({
    providers: ['codex', 'claude'],
    registry: createProviderSessionLifecycleRegistry([strategy]),
    identityResolver: {
      resolve(input) {
        assert.equal(Object.prototype.hasOwnProperty.call(input, 'accountRef'), false);
        return { nativeSessionId: 'native-thread-1', active: false };
      }
    }
  });

  const result = await service.archive({
    provider: 'codex',
    sessionId: 'aih-session-1',
    accountRef: 'acct_must_not_cross_boundary'
  });

  assert.deepEqual(result, {
    provider: 'codex',
    sessionId: 'aih-session-1',
    nativeSessionId: 'native-thread-1',
    origin: 'native'
  });
  assert.deepEqual(calls, [{
    provider: 'codex',
    sessionId: 'native-thread-1',
    requestedSessionId: 'aih-session-1'
  }]);
});

test('session lifecycle service resolves native identity before unarchiving', async () => {
  const calls = [];
  const strategy = {
    provider: 'codex',
    capabilities: async () => nativeCapabilities(),
    archive: async () => ({ archived: true }),
    listArchived: async () => [],
    unarchive: async (input) => {
      calls.push(input);
      return { unarchived: true };
    }
  };
  const service = createSessionLifecycleService({
    providers: ['codex'],
    registry: createProviderSessionLifecycleRegistry([strategy]),
    identityResolver: {
      resolve(input) {
        assert.deepEqual(input, {
          provider: 'codex',
          sessionId: 'aih-session-1'
        });
        return { nativeSessionId: 'native-thread-1', active: false };
      }
    }
  });

  const result = await service.unarchive({
    provider: 'codex',
    sessionId: 'aih-session-1',
    accountRef: 'acct_must_not_cross_boundary'
  });

  assert.deepEqual(result, {
    provider: 'codex',
    sessionId: 'aih-session-1',
    nativeSessionId: 'native-thread-1',
    origin: 'native'
  });
  assert.deepEqual(calls, [{
    provider: 'codex',
    sessionId: 'native-thread-1',
    requestedSessionId: 'aih-session-1'
  }]);
});

test('session lifecycle service rejects active and unsupported archive requests explicitly', async () => {
  const strategy = {
    provider: 'codex',
    capabilities: async () => nativeCapabilities(),
    archive: async () => ({ archived: true }),
    listArchived: async () => [],
    unarchive: async () => ({ unarchived: true })
  };
  const activeService = createSessionLifecycleService({
    providers: ['codex', 'claude'],
    registry: createProviderSessionLifecycleRegistry([strategy]),
    identityResolver: { resolve: () => ({ nativeSessionId: 'native-1', active: true }) }
  });

  await assert.rejects(
    () => activeService.archive({ provider: 'codex', sessionId: 'session-1' }),
    (error) => error instanceof SessionLifecycleError
      && error.code === 'session_lifecycle_active'
      && error.statusCode === 409
  );

  const unsupportedService = createSessionLifecycleService({
    providers: ['codex', 'claude'],
    registry: createProviderSessionLifecycleRegistry([])
  });
  await assert.rejects(
    () => unsupportedService.archive({ provider: 'claude', sessionId: 'session-2' }),
    (error) => error instanceof SessionLifecycleError
      && error.code === 'session_archive_unsupported'
      && error.statusCode === 422
  );
});

test('session lifecycle capabilities keep unsupported providers explicit', async () => {
  const strategy = {
    provider: 'codex',
    capabilities: async () => nativeCapabilities(),
    archive: async () => ({}),
    listArchived: async () => [],
    unarchive: async () => ({})
  };
  const service = createSessionLifecycleService({
    providers: ['codex', 'claude', 'agy', 'gemini', 'opencode'],
    registry: createProviderSessionLifecycleRegistry([strategy])
  });

  const capabilities = await service.getCapabilities();

  assert.equal(capabilities.codex.workflowAvailable, true);
  assert.equal(capabilities.codex.operations.archive.support, 'native');
  assert.equal(capabilities.claude.workflowAvailable, false);
  assert.equal(capabilities.opencode.workflowAvailable, false);
  assert.equal(capabilities.opencode.reason, 'native_unarchive_unavailable');
});

test('session lifecycle list merges native and existing legacy archives without snapshot truth', async () => {
  const strategy = {
    provider: 'codex',
    capabilities: async () => nativeCapabilities(),
    archive: async () => ({}),
    listArchived: async () => [{
      id: 'codex-1',
      title: 'Codex session',
      provider: 'codex',
      origin: 'native',
      canUnarchive: true,
      updatedAt: 100
    }],
    unarchive: async () => ({})
  };
  const legacyRecovery = {
    list: () => [{
      id: 'claude-1',
      title: 'Claude session',
      provider: 'claude',
      origin: 'legacy',
      canUnarchive: true,
      updatedAt: 200,
      archivedAt: 200
    }]
  };
  const service = createSessionLifecycleService({
    providers: ['codex', 'claude'],
    registry: createProviderSessionLifecycleRegistry([strategy]),
    legacyRecovery
  });

  const result = await service.listArchived();

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.archived.map((item) => item.id), ['claude-1', 'codex-1']);
});

test('Codex native lifecycle strategy probes exact methods and maps every archived page', async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/archive' && params.threadId === '00000000-0000-4000-8000-000000000000') {
        const error = new Error('no rollout found');
        error.rpcCode = -32602;
        throw error;
      }
      if (method === 'thread/unarchive' && params.threadId === '00000000-0000-4000-8000-000000000000') {
        const error = new Error('no archived rollout found');
        error.rpcCode = -32602;
        throw error;
      }
      if (method === 'thread/list' && params.limit === 1) {
        return { data: [], nextCursor: null };
      }
      if (method === 'thread/list' && params.cursor === null) {
        return {
          data: [{
            id: 'thread-1', name: null, preview: 'First prompt', cwd: '/tmp/project-a', updatedAt: 100
          }],
          nextCursor: 'next-page'
        };
      }
      if (method === 'thread/list' && params.cursor === 'next-page') {
        return {
          data: [{
            id: 'thread-2', name: 'Named thread', preview: '', cwd: '/tmp/project-b', updatedAt: 90
          }],
          nextCursor: null
        };
      }
      return {};
    },
    close() {}
  };
  const strategy = createCodexNativeLifecycleStrategy({
    runtimeResolver: {
      resolve: async () => ({ provider: 'codex', executablePath: '/tmp/codex', fingerprint: 'fp-1' })
    },
    clientFactory: async () => client
  });

  const capabilities = await strategy.capabilities();
  const archived = await strategy.listArchived();
  await strategy.archive({ sessionId: 'thread-1' });
  await strategy.unarchive({ sessionId: 'thread-1' });

  assert.equal(capabilities.workflowAvailable, true);
  assert.deepEqual(archived, [
    {
      id: 'thread-1', title: 'First prompt', provider: 'codex', projectPath: '/tmp/project-a',
      origin: 'native', canUnarchive: true, updatedAt: 100000
    },
    {
      id: 'thread-2', title: 'Named thread', provider: 'codex', projectPath: '/tmp/project-b',
      origin: 'native', canUnarchive: true, updatedAt: 90000
    }
  ]);
  assert.ok(calls.some((call) => call.method === 'thread/archive' && call.params.threadId === 'thread-1'));
  assert.ok(calls.some((call) => call.method === 'thread/unarchive' && call.params.threadId === 'thread-1'));
  assert.deepEqual(
    calls.filter((call) => call.method === 'thread/list' && call.params.limit !== 1).map((call) => call.params),
    [
      { archived: true, cursor: null, limit: 100, modelProviders: [], sourceKinds: [], useStateDbOnly: false },
      { archived: true, cursor: 'next-page', limit: 100, modelProviders: [], sourceKinds: [], useStateDbOnly: false }
    ]
  );
});

test('Codex lifecycle capability probe disables the workflow when one native method is missing', async () => {
  const client = {
    async request(method) {
      if (method === 'thread/unarchive') {
        const error = new Error('Method not found');
        error.rpcCode = -32601;
        throw error;
      }
      if (method === 'thread/archive') {
        const error = new Error('no rollout found');
        error.rpcCode = -32602;
        throw error;
      }
      return { data: [], nextCursor: null };
    },
    close() {}
  };
  const strategy = createCodexNativeLifecycleStrategy({
    runtimeResolver: { resolve: async () => ({ provider: 'codex', executablePath: '/tmp/codex', fingerprint: 'fp-2' }) },
    clientFactory: async () => client
  });

  const capabilities = await strategy.capabilities();

  assert.equal(capabilities.workflowAvailable, false);
  assert.equal(capabilities.operations.archive.support, 'native');
  assert.equal(capabilities.operations.unarchive.support, 'unsupported');
  assert.equal(capabilities.reason, 'native_archive_workflow_incomplete');
});

test('Codex lifecycle capability probe propagates transport failures', async () => {
  const transportError = new Error('Codex lifecycle transport 已关闭');
  transportError.code = 'codex_lifecycle_transport_closed';
  const strategy = createCodexNativeLifecycleStrategy({
    runtimeResolver: {
      resolve: async () => ({ provider: 'codex', executablePath: '/tmp/codex', fingerprint: 'fp-3' })
    },
    clientFactory: async () => ({
      request: async () => { throw transportError; },
      close() {}
    })
  });

  await assert.rejects(
    () => strategy.capabilities(),
    (error) => error === transportError
  );
});

test('legacy archive recovery lists and restores actual Claude and Gemini files by server-side lookup', () => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-legacy-archive-'));
  try {
    const claudeId = 'claude-session-1';
    const claudeProject = '-tmp-project';
    const claudeProjectDir = path.join(hostHomeDir, '.claude', 'projects', claudeProject);
    const claudeArchivedDir = path.join(claudeProjectDir, '.archived');
    fs.ensureDirSync(claudeArchivedDir);
    fs.writeFileSync(
      path.join(claudeArchivedDir, `${claudeId}.jsonl`),
      `${JSON.stringify({ type: 'user', message: { content: 'Legacy Claude title' } })}\n`,
      'utf8'
    );

    const geminiId = 'gemini-session-1';
    const geminiProject = 'project-hash';
    const geminiChatsDir = path.join(hostHomeDir, '.gemini', 'tmp', geminiProject, 'chats');
    const geminiArchivedDir = path.join(geminiChatsDir, '.archived');
    fs.ensureDirSync(geminiArchivedDir);
    fs.writeJsonSync(path.join(geminiArchivedDir, 'session.json'), {
      sessionId: geminiId,
      summary: 'Legacy Gemini title'
    });

    const recovery = createLegacyArchiveRecovery({ fs, hostHomeDir });
    const archived = recovery.list();

    assert.deepEqual(archived.map((item) => item.id).sort(), [claudeId, geminiId]);
    assert.ok(archived.every((item) => item.origin === 'legacy' && item.canUnarchive));

    recovery.unarchive({
      provider: 'claude',
      sessionId: claudeId,
      projectDirName: '../../untrusted-client-path'
    });
    recovery.unarchive({ provider: 'gemini', sessionId: geminiId });

    assert.equal(fs.existsSync(path.join(claudeProjectDir, `${claudeId}.jsonl`)), true);
    assert.equal(fs.existsSync(path.join(geminiChatsDir, 'session.json')), true);
    assert.equal(fs.existsSync(path.join(claudeArchivedDir, `${claudeId}.jsonl`)), false);
    assert.equal(fs.existsSync(path.join(geminiArchivedDir, 'session.json')), false);
  } finally {
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('Codex lifecycle host environment uses the shared native store without account fields', () => {
  const env = buildCodexHostLifecycleEnv({
    env: {
      PATH: '/usr/bin',
      AIH_ACCOUNT_REF: 'acct_must_not_leak',
      CODEX_HOME: '/account/profile/.codex'
    },
    hostHomeDir: '/Users/host'
  });

  assert.equal(env.HOME, '/Users/host');
  assert.equal(env.USERPROFILE, '/Users/host');
  assert.equal(env.CODEX_HOME, '/Users/host/.codex');
  assert.equal(env.CODEX_SQLITE_HOME, '/Users/host/.codex');
  assert.equal(env.AIH_CODEX_APP_SERVER_PASSTHROUGH, '1');
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'AIH_ACCOUNT_REF'), false);
  assert.equal(env.PATH, '/usr/bin');
});

test('Codex lifecycle stdio client creates a missing shared CODEX_HOME before spawn', async () => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-lifecycle-home-'));
  try {
    const spawnImpl = () => {
      assert.equal(fs.existsSync(path.join(hostHomeDir, '.codex')), true);
      const child = createFakeStdioChild((payload) => {
        if (payload.method === 'initialize') {
          child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: {} })}\n`);
        } else if (payload.method === 'thread/list') {
          child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { data: [] } })}\n`);
        }
      });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    };
    const client = createCodexLifecycleStdioClient({ executablePath: '/default/path/codex' }, {
      hostHomeDir,
      requestTimeoutMs: 1000,
      spawnImpl
    });

    assert.deepEqual(await client.request('thread/list', { archived: true }), { data: [] });
    client.close();
  } finally {
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('Codex lifecycle stdio client initializes once and preserves JSON-RPC error codes', async (t) => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-lifecycle-client-'));
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));
  const children = [];
  const messages = [];
  const spawnImpl = (command, args, options) => {
    const child = createFakeStdioChild((payload) => {
      messages.push(payload);
      if (payload.method === 'initialize') {
        child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: {} })}\n`);
      } else if (payload.method === 'thread/list') {
        child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { data: [] } })}\n`);
      } else if (payload.method === 'thread/archive') {
        child.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          error: { code: -32602, message: 'no rollout found' }
        })}\n`);
      }
    });
    children.push({ child, command, args, options });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const client = createCodexLifecycleStdioClient({
    executablePath: '/default/path/codex'
  }, {
    env: { PATH: '/usr/bin', AIH_ACCOUNT_REF: 'acct_hidden' },
    hostHomeDir,
    requestTimeoutMs: 1000,
    spawnImpl
  });

  assert.deepEqual(await client.request('thread/list', { archived: true }), { data: [] });
  await assert.rejects(
    () => client.request('thread/archive', { threadId: 'missing' }),
    (error) => error.rpcCode === -32602 && error.code === 'codex_app_server_rpc_error'
  );
  client.close();

  assert.equal(children.length, 1);
  assert.equal(children[0].command, '/default/path/codex');
  assert.deepEqual(children[0].args, ['app-server', '--listen', 'stdio://']);
  assert.equal(children[0].options.env.CODEX_HOME, path.join(hostHomeDir, '.codex'));
  assert.equal(Object.prototype.hasOwnProperty.call(children[0].options.env, 'AIH_ACCOUNT_REF'), false);
  assert.deepEqual(messages.map((message) => message.method), [
    'initialize', 'initialized', 'thread/list', 'thread/archive'
  ]);
  assert.equal(children[0].child.killCalls, 1);
});

test('Codex lifecycle stdio client does not retry an interrupted mutation', async (t) => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-lifecycle-interrupt-'));
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));
  let spawnCount = 0;
  const spawnImpl = () => {
    spawnCount += 1;
    const child = createFakeStdioChild((payload) => {
      if (payload.method === 'initialize') {
        child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: {} })}\n`);
      } else if (payload.method === 'thread/archive') {
        child.emit('exit', 1, null);
      }
    });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const client = createCodexLifecycleStdioClient({ executablePath: '/default/path/codex' }, {
    hostHomeDir,
    requestTimeoutMs: 1000,
    spawnImpl
  });

  await assert.rejects(
    () => client.request('thread/archive', { threadId: 'thread-1' }),
    (error) => error.code === 'codex_lifecycle_transport_closed'
  );

  assert.equal(spawnCount, 1);
  client.close();
});

function createFakeStdioChild(onWrite) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = {
    writable: true,
    write(chunk) {
      for (const line of String(chunk || '').split('\n').filter(Boolean)) {
        onWrite(JSON.parse(line));
      }
      return true;
    }
  };
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    return true;
  };
  return child;
}

test('session identity resolver maps AIH runtime ids to provider-native ids without execution account', () => {
  const resolver = createSessionIdentityResolver({
    chatRuntimeService: {
      store: {
        getSession(sessionId) {
          if (sessionId !== 'aih-session-1') return null;
          return {
            sessionId,
            provider: 'codex',
            executionAccountRef: 'acct_private',
            state: 'running',
            runtimeBinding: { nativeSessionId: 'native-thread-1' }
          };
        }
      }
    }
  });

  assert.deepEqual(resolver.resolve({ provider: 'codex', sessionId: 'aih-session-1' }), {
    nativeSessionId: 'native-thread-1',
    active: true
  });
  assert.deepEqual(resolver.resolve({ provider: 'codex', sessionId: 'native-thread-2' }), {
    nativeSessionId: 'native-thread-2',
    active: false
  });
});

test('session lifecycle composition retires only the obsolete cache key', () => {
  const deletions = [];
  const service = createSessionLifecycleComposition({
    aiHomeDir: '/tmp/aih-home',
    fs,
    hostHomeDir: '/Users/host',
    runtimeResolver: {
      resolve: async () => ({ provider: 'codex', executablePath: '/tmp/codex', fingerprint: 'fp' })
    },
    codexClientFactory: async () => ({ request: async () => ({}), close() {} }),
    deleteJsonValue: (...args) => deletions.push(args)
  });

  assert.equal(typeof service.archive, 'function');
  assert.deepEqual(deletions.map((entry) => entry.slice(1, 3)), [[
    '/tmp/aih-home',
    'cache:webui-archived-snapshot.json'
  ]]);
  assert.equal(deletions[0][3].bestEffort, true);
  service.close();
});
