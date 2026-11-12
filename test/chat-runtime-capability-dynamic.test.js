'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCapabilityRoutedChatDriverEntry
} = require('../lib/server/chat-runtime/capability-routed-driver');
const { codexCapabilities } = require('../lib/server/chat-runtime/codex-session-driver-support');

// 能力快照不是会话级常量：同一会话可以在 canonical / relay 模型之间切换，
// 前端拿到的快照必须跟着「当前模型会被路由到谁」变化。Go 轮次只产出文本增量，
// 谎报 tool/reasoning/approval/plan 会让 UI 渲染永远不会出现的入口。

const RUNTIME = Object.freeze({
  capabilityHash: 'capability-hash-test',
  fingerprint: 'fingerprint-test',
  version: '1.0.0'
});
const GO_UNSUPPORTED = Object.freeze([
  'timeline.reasoning',
  'timeline.tool',
  'timeline.diff',
  'mode.plan',
  'interaction.question',
  'interaction.approval',
  'interaction.plan_confirmation',
  'turn.steer.current',
  'turn.steer.tool_boundary',
  'run.adopt'
]);

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
    { ref: 'acct_zcode', provider: 'zcode', models: ['glm-4.6'] },
    { ref: 'acct_cline', provider: 'cline', models: ['cline-pass'] }
  ]);
}

function canonicalAccounts() {
  return buildIndex([
    { ref: 'acct_claude', provider: 'claude', models: ['claude-sonnet-4-5'] },
    { ref: 'acct_codex', provider: 'codex', models: ['gpt-5.6-luna'] }
  ]);
}

function routedEntry(options = {}) {
  const calls = [];
  const session = {
    sessionId: 'session-capability-dynamic',
    provider: 'codex',
    executionAccountRef: 'gateway',
    projectPath: '',
    policy: { model: 'glm-4.6' }
  };
  const entry = createCapabilityRoutedChatDriverEntry({
    session,
    capabilities: codexCapabilities(RUNTIME),
    getSessionPolicy: () => session.policy,
    getModelAccountIndex: () => ('index' in options ? options.index : relayAccounts()),
    createGoEntry: () => {
      calls.push('go:create');
      return { driver: { startTurn: () => Promise.resolve({ status: 'completed' }) }, handlers: {} };
    },
    createNodeEntry: () => {
      calls.push('node:create');
      return {
        driver: { startTurn: () => Promise.resolve({ status: 'completed' }), dispose: () => true },
        handlers: {}
      };
    }
  });
  return { entry, session, calls };
}

function sessionFor(model, overrides = {}) {
  return {
    sessionId: 'session-capability-dynamic',
    executionAccountRef: 'gateway',
    policy: { model },
    ...overrides
  };
}

function assertGoCapabilities(capabilities) {
  for (const name of GO_UNSUPPORTED) {
    assert.equal(capabilities.capabilities[name]?.support, 'unsupported', name);
  }
  assert.equal(capabilities.capabilities['turn.interrupt'].support, 'native');
  assert.equal(capabilities.capabilities['turn.queue'].support, 'emulated');
  assert.equal(capabilities.capabilities['session.goal'].support, 'emulated');
  assert.equal(capabilities.capabilities['slash.execute'].support, 'native');
  assert.deepEqual(capabilities.slashCommands, ['compact', 'goal', 'plan']);
  assert.equal(capabilities.slashPassthrough, false);
  assert.deepEqual(capabilities.turnInterveneModes, []);
}

function assertNodeCapabilities(capabilities) {
  assert.equal(capabilities.capabilities['timeline.tool'].support, 'native');
  assert.equal(capabilities.capabilities['timeline.reasoning'].support, 'native');
  assert.equal(capabilities.capabilities['interaction.approval'].support, 'native');
  assert.equal(capabilities.capabilities['turn.steer.current'].support, 'native');
  assert.deepEqual(capabilities.slashCommands, ['compact', 'goal', 'plan']);
  assert.deepEqual(capabilities.turnInterveneModes, ['steer_current']);
}

test('relay 模型 → Go 能力子集：隐藏 tools / reasoning / approval / plan / steer', () => {
  const { entry } = routedEntry();
  const capabilities = entry.capabilitiesFor(sessionFor('glm-4.6'));
  assertGoCapabilities(capabilities);
  assert.equal(capabilities.revision, 'go-chat-relay-v1');
});

test('canonical 模型 → 完整 Node codex 能力', () => {
  const { entry } = routedEntry();
  const capabilities = entry.capabilitiesFor(sessionFor('claude-sonnet-4-5'));
  assert.deepEqual(capabilities, codexCapabilities(RUNTIME));
  assertNodeCapabilities(capabilities);
});

test('同一 entry 内切换模型：快照立即跟随，不重建驱动', () => {
  const { entry, calls } = routedEntry();
  assertGoCapabilities(entry.capabilitiesFor(sessionFor('glm-4.6')));
  assertNodeCapabilities(entry.capabilitiesFor(sessionFor('claude-sonnet-4-5')));
  assertGoCapabilities(entry.capabilitiesFor(sessionFor('glm-4.6')));
  // 能力求值只读索引，不构造任何一端的驱动。
  assert.deepEqual(calls, []);
});

test('索引不可用 / 模型无承载 / 模型为空 → 保守回退 Node 能力', () => {
  for (const index of [
    null,
    { builtAt: 0, modelToAccounts: new Map(), accountByRef: new Map() },
    relayAccounts(),
    canonicalAccounts()
  ]) {
    const { entry } = routedEntry({ index });
    assertNodeCapabilities(entry.capabilitiesFor(sessionFor('unknown-model')));
  }
  const { entry } = routedEntry();
  assertNodeCapabilities(entry.capabilitiesFor(sessionFor('')));
});

test('能力求值只看模型，不看附件与 slash 这类逐轮输入', () => {
  const { entry, calls } = routedEntry();
  // 逐轮路由（startTurn）带附件会退回 Node，但能力快照仍按模型判定为 Go：
  // 附件只影响这一轮，不代表会话的下一轮能力。
  const route = entry.driver.route({
    command: { payload: { content: '看下这张图', model: 'glm-4.6', attachmentIds: ['att-1'] } }
  });
  assert.equal(route.target, 'node');
  assertGoCapabilities(entry.capabilitiesFor(sessionFor('glm-4.6')));
  assert.deepEqual(calls, []);
});

test('actor registry：getCapabilities 按当前 policy 模型求值，切模型不需要重建 actor', async (t) => {
  const { createChatRuntimeComposition } = require('../lib/server/chat-runtime-composition');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-capability-dynamic-'));
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
        ...RUNTIME
      })
    },
    chatGateway: {
      port: 9527,
      clientKey: 'client-key-test',
      isModelEnabled: () => true,
      resolveDefaultModel: () => 'glm-4.6',
      readModels: async () => []
    },
    chatInference: { streamTurn: async () => new Response('', { status: 200 }) },
    codexClientFactory: () => { throw new Error('node driver must stay lazy'); }
  });
  t.after(() => {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const session = await service.createSession({
    sessionId: 'session-capability-policy',
    provider: 'codex',
    executionAccountRef: 'gateway',
    projectPath: '',
    policy: { model: 'glm-4.6' }
  });
  assert.equal(session.sessionId, 'session-capability-policy');

  // 创建时就按 policy.model 的路由目标落库：重启后没有 actor，/snapshot 只读这份
  // 持久化快照，沿静态上限会让 relay 会话谎报 tools / approval。
  assertGoCapabilities(session.capabilitySnapshot);
  assertGoCapabilities(service.getSessionCapabilities(session.sessionId));
  assertGoCapabilities(service.getSnapshot(session.sessionId).capabilitySnapshot);
  assert.equal(
    (await service.getCommandCatalog(session.sessionId))
      .some((command) => command.type === 'turn.intervene'),
    false
  );

  // 返回的是克隆：调用方改坏自己的副本不能污染下一次读取。
  const cloned = service.getSessionCapabilities(session.sessionId);
  cloned.capabilities['timeline.tool'] = { support: 'native' };
  assertGoCapabilities(service.getSessionCapabilities(session.sessionId));

  // session.policy.set 改 model：actor 不重建，下一次读取立即换成 Node 能力。
  await service.dispatchCommand(session.sessionId, {
    commandId: 'command-policy-canonical',
    type: 'session.policy.set',
    payload: { key: 'model', value: 'claude-sonnet-4-5' }
  });
  assertNodeCapabilities(service.getSessionCapabilities(session.sessionId));
  assertNodeCapabilities(service.getSnapshot(session.sessionId).capabilitySnapshot);
  assert.equal(
    (await service.getCommandCatalog(session.sessionId))
      .some((command) => command.type === 'turn.intervene'),
    true
  );

  // 再切回 relay：同一个 actor 立刻恢复 Go 子集。
  await service.dispatchCommand(session.sessionId, {
    commandId: 'command-policy-relay',
    type: 'session.policy.set',
    payload: { key: 'model', value: 'glm-4.6' }
  });
  assertGoCapabilities(service.getSessionCapabilities(session.sessionId));

  // 没有 actor 的会话（重启后 / 只读过库）回退到持久化快照。
  service.store.createSession({
    sessionId: 'session-no-actor',
    provider: 'codex',
    executionAccountRef: 'gateway',
    projectPath: '',
    policy: { model: 'glm-4.6' },
    runtimeBinding: { runtimeId: 'codex:gateway' },
    capabilitySnapshot: codexCapabilities(RUNTIME)
  });
  assertNodeCapabilities(service.getSessionCapabilities('session-no-actor'));
  assertNodeCapabilities(service.getSnapshot('session-no-actor').capabilitySnapshot);
});
