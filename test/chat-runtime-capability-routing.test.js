'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');
const { SessionActor } = require('../lib/server/chat-runtime/session-actor');
const {
  CapabilityRoutedChatDriver,
  createCapabilityRoutedChatDriverEntry,
  resolveChatTurnRoute
} = require('../lib/server/chat-runtime/capability-routed-driver');

// 能力路由：Go 只承接聊天透传（relay）Provider 的轮次，其余交还旧的 Node codex 驱动。
// 这两条路径的代价完全不同（Go 是一次 HTTP 转发；Node 要拉起 codex app-server 租约），
// 所以测试同时盯住「谁执行」和「另一个驱动有没有被构造」。

function buildIndex(accounts) {
  const modelToAccounts = new Map();
  const accountByRef = new Map();
  for (const account of accounts) {
    accountByRef.set(account.ref, { provider: account.provider, accountRef: account.ref });
    for (const model of account.models || []) {
      const refs = modelToAccounts.get(model) || [];
      if (!refs.includes(account.ref)) refs.push(account.ref);
      modelToAccounts.set(model, refs);
    }
  }
  return { builtAt: Date.now(), modelToAccounts, accountByRef };
}

function relayAccounts() {
  return buildIndex([
    { ref: 'acct_zcode', provider: 'zcode', models: ['glm-4.6', 'relay-shared'] },
    { ref: 'acct_cline', provider: 'cline', models: ['relay-shared'] }
  ]);
}

function canonicalAccounts() {
  return buildIndex([
    { ref: 'acct_claude', provider: 'claude', models: ['claude-sonnet-4-5', 'relay-shared'] },
    { ref: 'acct_codex', provider: 'codex', models: ['gpt-5.6-luna'] }
  ]);
}

function routedEntry(options = {}) {
  const calls = [];
  const session = {
    sessionId: 'session-routed',
    provider: 'codex',
    executionAccountRef: 'gateway',
    projectPath: '',
    policy: { model: 'glm-4.6', ...(options.policy || {}) }
  };
  const entry = createCapabilityRoutedChatDriverEntry({
    session,
    getSessionPolicy: () => options.policyOverride || session.policy,
    getModelAccountIndex: () => ('modelAccountIndex' in options ? options.modelAccountIndex : relayAccounts()),
    createGoEntry: () => {
      calls.push('go:create');
      return {
        driver: {
          startTurn: (context) => {
            calls.push('go:startTurn');
            return Promise.resolve({ status: 'completed', target: 'go', context });
          },
          interruptTurn: () => {
            calls.push('go:interruptTurn');
            return Promise.resolve({ cancelled: true, target: 'go' });
          },
          dispose: () => {
            calls.push('go:dispose');
            return true;
          }
        },
        handlers: {}
      };
    },
    createNodeEntry: () => {
      calls.push('node:create');
      return {
        driver: {
          startTurn: () => {
            calls.push('node:startTurn');
            return Promise.resolve({ status: 'completed', target: 'node' });
          },
          interruptTurn: () => {
            calls.push('node:interruptTurn');
            return Promise.resolve({ cancelled: true, target: 'node' });
          },
          compactThread: () => {
            calls.push('node:compactThread');
            return Promise.resolve({ status: 'completed', target: 'node-compact' });
          },
          dispose: () => {
            calls.push('node:dispose');
            return true;
          }
        },
        handlers: {
          'slash.execute': () => {
            calls.push('node:slash');
            return { ok: true };
          },
          'interaction.answer': () => {
            calls.push('node:answer');
            return { ok: true };
          }
        }
      };
    }
  });
  return { entry, session, calls };
}

function turnContext(entry, overrides = {}) {
  return {
    sessionId: entry.driver.session.sessionId,
    turnId: 'turn-1',
    runId: 'run-1',
    imagePaths: [],
    command: {
      type: 'turn.submit',
      payload: { content: '你好', model: 'glm-4.6', ...overrides }
    }
  };
}

test('仅映射到 relay 账号的模型 → 走 Go，Node 驱动不构造', async () => {
  const { entry, calls } = routedEntry();
  const result = await entry.driver.startTurn(turnContext(entry));
  assert.equal(result.target, 'go');
  assert.deepEqual(calls, ['go:create', 'go:startTurn']);
  assert.equal(calls.includes('node:create'), false);
});

test('claude 模型 → 不调用 Go，交给 Node 驱动并成功完成', async () => {
  const { entry, calls } = routedEntry({ modelAccountIndex: canonicalAccounts() });
  const result = await entry.driver.startTurn(turnContext(entry, { model: 'claude-sonnet-4-5' }));
  assert.equal(result.status, 'completed');
  assert.equal(result.target, 'node');
  assert.deepEqual(calls, ['node:create', 'node:startTurn']);
  assert.equal(calls.includes('go:create'), false);
});

test('codex 模型（canonical 通道）→ 交还 Node', () => {
  const route = resolveChatTurnRoute({
    payload: { model: 'gpt-5.6-luna' },
    modelAccountIndex: canonicalAccounts()
  });
  assert.equal(route.target, 'node');
  assert.match(route.reason, /^provider_not_relay:codex$/);
});

test('同一模型同时被 relay 与 canonical 账号承载 → 保守交还 Node', () => {
  const index = buildIndex([
    { ref: 'acct_zcode', provider: 'zcode', models: ['relay-shared'] },
    { ref: 'acct_claude', provider: 'claude', models: ['relay-shared'] }
  ]);
  const route = resolveChatTurnRoute({ payload: { model: 'relay-shared' }, modelAccountIndex: index });
  assert.equal(route.target, 'node');
  assert.match(route.reason, /^provider_not_relay:claude$/);
});

test('带附件的 relay 模型轮次 → 走 Node（Go 没有附件仓库）', async () => {
  const { entry, calls } = routedEntry();
  const result = await entry.driver.startTurn(turnContext(entry, { attachmentIds: ['att-1'] }));
  assert.equal(result.target, 'node');
  assert.deepEqual(calls, ['node:create', 'node:startTurn']);
});

test('图片路径同样交还 Node', async () => {
  const { entry, calls } = routedEntry();
  const context = turnContext(entry);
  context.imagePaths = ['/tmp/picture.png'];
  const result = await entry.driver.startTurn(context);
  assert.equal(result.target, 'node');
  assert.deepEqual(calls, ['node:create', 'node:startTurn']);
});

test('解析不出候选 → 走 Node（保守）', async () => {
  for (const modelAccountIndex of [
    relayAccounts(),
    { builtAt: 0, modelToAccounts: new Map(), accountByRef: new Map() },
    null
  ]) {
    const { entry, calls } = routedEntry({ modelAccountIndex });
    const result = await entry.driver.startTurn(turnContext(entry, { model: 'unknown-model' }));
    assert.equal(result.target, 'node');
    assert.deepEqual(calls, ['node:create', 'node:startTurn']);
  }
});

test('模型为空 → 走 Node，交给旧驱动解析默认模型', () => {
  const route = resolveChatTurnRoute({
    payload: {},
    policy: { model: '' },
    modelAccountIndex: relayAccounts()
  });
  assert.deepEqual(route, { target: 'node', reason: 'model_missing' });
});

test('钉选 canonical 账号时不因模型只映射 relay 账号而改走 Go', () => {
  const route = resolveChatTurnRoute({
    payload: { model: 'glm-4.6' },
    pinnedAccountRef: 'acct_claude',
    modelAccountIndex: buildIndex([
      { ref: 'acct_zcode', provider: 'zcode', models: ['glm-4.6'] },
      { ref: 'acct_claude', provider: 'claude', models: ['claude-sonnet-4-5'] }
    ])
  });
  assert.equal(route.target, 'node');
  assert.match(route.reason, /canonical|claude/);
});

test('钉选账号在索引里缺失 → 走 Node（不猜账号归属）', () => {
  const route = resolveChatTurnRoute({
    payload: { model: 'glm-4.6' },
    pinnedAccountRef: 'acct_missing',
    modelAccountIndex: relayAccounts()
  });
  assert.deepEqual(route, { target: 'node', reason: 'pinned_provider_unknown' });
});

test('interrupt 只委托给当前持有轮次的驱动', async () => {
  const goRun = routedEntry();
  await goRun.entry.driver.startTurn(turnContext(goRun.entry));
  assert.deepEqual(await goRun.entry.driver.interruptTurn(turnContext(goRun.entry)),
    { cancelled: true, target: 'go' });
  assert.deepEqual(goRun.calls, ['go:create', 'go:startTurn', 'go:interruptTurn']);

  const nodeRun = routedEntry({ modelAccountIndex: canonicalAccounts() });
  await nodeRun.entry.driver.startTurn(turnContext(nodeRun.entry, { model: 'claude-sonnet-4-5' }));
  assert.deepEqual(await nodeRun.entry.driver.interruptTurn(turnContext(nodeRun.entry)),
    { cancelled: true, target: 'node' });
  assert.deepEqual(nodeRun.calls, ['node:create', 'node:startTurn', 'node:interruptTurn']);
});

test('没有活跃轮次时 interrupt 返回 409', async () => {
  const { entry } = routedEntry();
  await assert.rejects(
    entry.driver.interruptTurn(turnContext(entry)),
    (error) => error.code === 'chat_turn_not_active' && error.statusCode === 409
  );
});

test('dispose 只清理已构造的驱动', async () => {
  const goRun = routedEntry();
  await goRun.entry.driver.startTurn(turnContext(goRun.entry));
  goRun.entry.driver.dispose();
  assert.deepEqual(goRun.calls, ['go:create', 'go:startTurn', 'go:dispose']);

  const nodeRun = routedEntry({ modelAccountIndex: canonicalAccounts() });
  await nodeRun.entry.driver.startTurn(turnContext(nodeRun.entry, { model: 'claude-sonnet-4-5' }));
  nodeRun.entry.driver.dispose();
  assert.deepEqual(nodeRun.calls, ['node:create', 'node:startTurn', 'node:dispose']);
});

test('/compact 通过 compactThread 交还 Node', async () => {
  const { entry, calls } = routedEntry();
  const result = await entry.driver.compactThread(turnContext(entry));
  assert.equal(result.target, 'node-compact');
  assert.deepEqual(calls, ['node:create', 'node:compactThread']);
});

test('命令处理器按需委托 Node：预热不构造驱动，slash 才构造', () => {
  const { entry, calls } = routedEntry();
  assert.equal(entry.driver.handlerFor('runtime.prewarm'), undefined);
  assert.deepEqual(calls, []);
  const handler = entry.driver.handlerFor('slash.execute');
  assert.equal(typeof handler, 'function');
  assert.deepEqual(calls, ['node:create']);
  assert.deepEqual(handler({}), { ok: true });
  assert.deepEqual(calls, ['node:create', 'node:slash']);
});

test('SessionActor：canonical 模型的 turn.submit 由 Node 驱动结算完成', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-routed-'));
  const store = openChatRuntimeStore({
    fs,
    aiHomeDir: root,
    historyCompaction: false,
    clock: () => 1_700_000_000_000
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  store.createSession({
    sessionId: 'session-actor-routed',
    provider: 'codex',
    executionAccountRef: 'gateway',
    projectPath: '',
    policy: { model: 'claude-sonnet-4-5' },
    runtimeBinding: { runtimeId: 'codex:gateway' }
  });
  const calls = [];
  const entry = createCapabilityRoutedChatDriverEntry({
    session: { sessionId: 'session-actor-routed', executionAccountRef: 'gateway', policy: { model: 'claude-sonnet-4-5' } },
    getSessionPolicy: () => ({ model: 'claude-sonnet-4-5' }),
    getModelAccountIndex: () => canonicalAccounts(),
    createGoEntry: () => {
      calls.push('go:create');
      return { driver: { startTurn: () => Promise.resolve({ status: 'completed' }) }, handlers: {} };
    },
    createNodeEntry: () => {
      calls.push('node:create');
      return {
        driver: {
          startTurn: () => Promise.resolve({ status: 'completed' }),
          dispose: () => true
        },
        handlers: {}
      };
    }
  });
  const actor = new SessionActor({
    sessionId: 'session-actor-routed',
    store,
    driver: entry.driver,
    handlers: entry.handlers
  });
  const result = await actor.dispatch({
    commandId: 'command-node-1',
    sessionId: 'session-actor-routed',
    type: 'turn.submit',
    payload: { content: '你好', model: 'claude-sonnet-4-5' }
  });
  assert.equal(result.result.state, 'running');
  await actor.waitForIdle();
  assert.deepEqual(calls, ['node:create']);
  assert.equal(store.getSession('session-actor-routed').state, 'idle');
  assert.ok(store.listEvents('session-actor-routed', { limit: 100 })
    .some((event) => event.type === 'turn.completed'));
});

test('SessionActor：node-only 命令（slash）委托给懒构造的 Node 驱动', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-routed-cmd-'));
  const store = openChatRuntimeStore({
    fs,
    aiHomeDir: root,
    historyCompaction: false,
    clock: () => 1_700_000_000_000
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  store.createSession({
    sessionId: 'session-actor-slash',
    provider: 'codex',
    executionAccountRef: 'gateway',
    projectPath: '',
    policy: { model: 'glm-4.6' },
    runtimeBinding: { runtimeId: 'codex:gateway' }
  });
  const calls = [];
  const entry = createCapabilityRoutedChatDriverEntry({
    session: { sessionId: 'session-actor-slash', executionAccountRef: 'gateway', policy: { model: 'glm-4.6' } },
    getSessionPolicy: () => ({ model: 'glm-4.6' }),
    getModelAccountIndex: () => relayAccounts(),
    createGoEntry: () => ({ driver: { startTurn: () => Promise.resolve({}) }, handlers: {} }),
    createNodeEntry: () => {
      calls.push('node:create');
      return {
        driver: { startTurn: () => Promise.resolve({}), dispose: () => true },
        handlers: {
          'slash.execute': () => {
            calls.push('node:slash');
            return { compacted: true };
          }
        }
      };
    }
  });
  const actor = new SessionActor({
    sessionId: 'session-actor-slash',
    store,
    driver: entry.driver,
    handlers: entry.handlers
  });
  const result = await actor.dispatch({
    commandId: 'command-slash-1',
    sessionId: 'session-actor-slash',
    type: 'slash.execute',
    payload: { name: 'review', arguments: 'all' }
  });
  assert.deepEqual(result.result, { compacted: true });
  assert.deepEqual(calls, ['node:create', 'node:slash']);
});

test('装配层：relay 模型轮次打到 Go，且不为它构造 codex 客户端', async (t) => {
  const { createChatRuntimeComposition } = require('../lib/server/chat-runtime-composition');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-composition-'));
  const streamCalls = [];
  const clientFactoryCalls = [];
  const service = createChatRuntimeComposition({
    fs,
    aiHomeDir: root,
    hostHomeDir: root,
    env: {},
    spawn: () => { throw new Error('spawn must not be used'); },
    spawnSync: () => { throw new Error('spawnSync must not be used'); },
    appendServerLog: () => {},
    getModelAccountIndex: () => relayAccounts(),
    runtimeResolver: {
      resolve: async (provider, context) => ({
        provider,
        runtimeScope: context.runtimeScope,
        executablePath: '/bin/true',
        fingerprint: 'fingerprint-test',
        capabilityHash: 'capability-test',
        version: '1.0.0'
      })
    },
    chatGateway: {
      port: 9527,
      clientKey: 'client-key-test',
      isModelEnabled: () => true,
      resolveDefaultModel: () => 'glm-4.6',
      readModels: async () => []
    },
    chatInference: {
      streamTurn: async (request) => {
        streamCalls.push(request);
        return new Response('event: turn.completed\ndata: {"state":"idle"}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        });
      }
    },
    codexClientFactory: () => {
      clientFactoryCalls.push('create');
      throw new Error('node driver must stay lazy for relay turns');
    }
  });
  t.after(() => {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const session = await service.createSession({
    sessionId: 'session-composition-relay',
    provider: 'codex',
    executionAccountRef: 'gateway',
    projectPath: '',
    policy: { model: 'glm-4.6' }
  });
  assert.equal(session.sessionId, 'session-composition-relay');
  const result = await service.dispatchCommand(session.sessionId, {
    commandId: 'command-composition-1',
    type: 'turn.submit',
    payload: { content: '你好', model: 'glm-4.6' }
  });
  assert.equal(result.result.state, 'running');
  await service.waitForActorIdle(session.sessionId);

  assert.equal(streamCalls.length, 1);
  assert.equal(streamCalls[0].body.payload.model, 'glm-4.6');
  assert.deepEqual(clientFactoryCalls, []);
  assert.equal(store2state(service, session.sessionId), 'idle');
  assert.ok(service.store.listEvents(session.sessionId, { limit: 100 })
    .some((event) => event.type === 'turn.completed'));
});

function store2state(service, sessionId) {
  return service.store.getSession(sessionId).state;
}

