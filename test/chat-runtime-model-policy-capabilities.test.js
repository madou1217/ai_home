'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatRuntimeComposition } = require('../lib/server/chat-runtime-composition');
const { ChatRuntimeService } = require('../lib/server/chat-runtime-service');
const { codexCapabilities } = require('../lib/server/chat-runtime/codex-session-driver-support');

// 能力快照的求值依据是 policy.model。WebUI 的模型选择以前只随 turn.submit 逐轮下发，
// 于是「选了 relay 模型但还没发」和「重启后没有 actor」这两种情况下，/snapshot 仍按
// 上一个模型（或静态上限）给能力，前端继续显示 tools / approval / reasoning / plan。
// 这里锁住三条契约：选中即落库、变化即推事件、坏值不落库。

const RUNTIME = Object.freeze({
  capabilityHash: 'capability-hash-policy-model',
  fingerprint: 'fingerprint-policy-model',
  version: '1.0.0'
});
const RELAY_MODEL = 'glm-4.6';
const CANONICAL_MODEL = 'claude-sonnet-4-5';

function modelIndex() {
  const modelToAccounts = new Map([
    [RELAY_MODEL, ['acct_zcode']],
    [CANONICAL_MODEL, ['acct_claude']]
  ]);
  const accountByRef = new Map([
    ['acct_zcode', { provider: 'zcode', accountRef: 'acct_zcode' }],
    ['acct_claude', { provider: 'claude', accountRef: 'acct_claude' }]
  ]);
  return { builtAt: Date.now(), modelToAccounts, accountByRef };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-model-policy-'));
}

function createService(t) {
  const root = tempRoot();
  const service = createComposition(root);
  t.after(() => {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { service, root };
}

function createComposition(root) {
  return createChatRuntimeComposition({
    fs,
    aiHomeDir: root,
    hostHomeDir: root,
    env: {},
    spawn: () => { throw new Error('spawn must not be used'); },
    spawnSync: () => { throw new Error('spawnSync must not be used'); },
    appendServerLog: () => {},
    getModelAccountIndex: modelIndex,
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
      resolveDefaultModel: () => RELAY_MODEL,
      readModels: async () => []
    },
    chatInference: { streamTurn: async () => new Response('', { status: 200 }) },
    codexClientFactory: () => { throw new Error('node driver must stay lazy'); }
  });
}

async function createChatSession(service, sessionId, model) {
  return service.createSession({
    sessionId,
    provider: 'codex',
    executionAccountRef: 'gateway',
    projectPath: '',
    policy: { model }
  });
}

function assertRelayCapabilities(capabilities) {
  assert.equal(capabilities.capabilities['timeline.tool'].support, 'unsupported');
  assert.equal(capabilities.capabilities['timeline.reasoning'].support, 'unsupported');
  assert.equal(capabilities.capabilities['interaction.approval'].support, 'unsupported');
  assert.equal(capabilities.capabilities['mode.plan'].support, 'unsupported');
  assert.equal(capabilities.capabilities['turn.steer.current'].support, 'unsupported');
  assert.equal(capabilities.revision, 'go-chat-relay-v1');
}

function assertCanonicalCapabilities(capabilities) {
  const canonical = codexCapabilities(RUNTIME);
  assert.deepEqual(capabilities, canonical);
}

function eventsAfter(service, sessionId, seq) {
  return service.store.listEvents(sessionId, { after: seq, limit: 500 });
}

test('创建会话就按 policy.model 路由落库快照：重启后没有 actor 也不返回静态上限', async () => {
  const root = tempRoot();
  const service = createComposition(root);
  try {
    const relay = await createChatSession(service, 'session-created-relay', RELAY_MODEL);
    assertRelayCapabilities(relay.capabilitySnapshot);
    const canonical = await createChatSession(service, 'session-created-canonical', CANONICAL_MODEL);
    assertCanonicalCapabilities(canonical.capabilitySnapshot);
  } finally {
    service.close();
  }

  // 模拟重启：同一份库重新打开，actor 表是空的，/snapshot 只能读持久化快照。
  const restarted = createComposition(root);
  try {
    assertRelayCapabilities(restarted.getSnapshot('session-created-relay').capabilitySnapshot);
    assertCanonicalCapabilities(
      restarted.getSnapshot('session-created-canonical').capabilitySnapshot
    );
  } finally {
    restarted.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session.policy.set 改模型：策略、持久化快照、推送事件三者一起变', async (t) => {
  const { service } = createService(t);
  await createChatSession(service, 'session-model-switch', RELAY_MODEL);
  const throughSeq = service.store.getSession('session-model-switch').lastEventSeq;

  await service.dispatchCommand('session-model-switch', {
    commandId: 'command-model-canonical',
    type: 'session.policy.set',
    payload: { key: 'model', value: CANONICAL_MODEL }
  });

  const updated = service.store.getSession('session-model-switch');
  assert.equal(updated.policy.model, CANONICAL_MODEL);
  // 落库：重启后（没有 actor）读到的就是新模型的能力面。
  assertCanonicalCapabilities(updated.capabilitySnapshot);
  assertCanonicalCapabilities(service.getSnapshot('session-model-switch').capabilitySnapshot);

  // 推送：在线前端不用等下一次快照重同步。
  const pushed = eventsAfter(service, 'session-model-switch', throughSeq)
    .filter((event) => event.type === 'session.runtime.rebound');
  assert.equal(pushed.length, 1);
  assertCanonicalCapabilities(pushed[0].payload.capabilitySnapshot);
  assert.equal(pushed[0].source.provider, 'codex');

  // 切回 relay：同一会话立刻恢复保守子集，并再推一次。
  await service.dispatchCommand('session-model-switch', {
    commandId: 'command-model-relay',
    type: 'session.policy.set',
    payload: { key: 'model', value: RELAY_MODEL }
  });
  assert.equal(service.store.getSession('session-model-switch').policy.model, RELAY_MODEL);
  assertRelayCapabilities(service.store.getSession('session-model-switch').capabilitySnapshot);
  assertRelayCapabilities(service.getSnapshot('session-model-switch').capabilitySnapshot);
  const later = eventsAfter(service, 'session-model-switch', throughSeq)
    .filter((event) => event.type === 'session.runtime.rebound');
  assert.equal(later.length, 2);
  assertRelayCapabilities(later[1].payload.capabilitySnapshot);
});

test('非模型策略不改能力快照、也不推快照事件', async (t) => {
  const { service } = createService(t);
  await createChatSession(service, 'session-policy-approval', RELAY_MODEL);
  const throughSeq = service.store.getSession('session-policy-approval').lastEventSeq;
  const before = service.store.getSession('session-policy-approval').capabilitySnapshot;

  await service.dispatchCommand('session-policy-approval', {
    commandId: 'command-approval-mode',
    type: 'session.policy.set',
    payload: { key: 'approvalMode', value: 'plan' }
  });

  const events = eventsAfter(service, 'session-policy-approval', throughSeq);
  assert.equal(events.some((event) => event.type === 'session.policy.changed'), true);
  assert.equal(events.some((event) => event.type === 'session.runtime.rebound'), false);
  assert.deepEqual(
    service.store.getSession('session-policy-approval').capabilitySnapshot,
    before
  );
});

test('turn.submit 带新模型：本轮开始时同步能力快照，逐轮 model 语义不变', async (t) => {
  const { service } = createService(t);
  await createChatSession(service, 'session-turn-model', CANONICAL_MODEL);
  const throughSeq = service.store.getSession('session-turn-model').lastEventSeq;

  await service.dispatchCommand('session-turn-model', {
    commandId: 'command-turn-relay',
    type: 'turn.submit',
    payload: { content: '换成 relay 模型跑一轮', model: RELAY_MODEL }
  });

  // 本轮仍按 payload.model 执行（不改变逐轮语义），但会话策略与快照跟着换。
  const session = service.store.getSession('session-turn-model');
  assert.equal(session.policy.model, RELAY_MODEL);
  assertRelayCapabilities(session.capabilitySnapshot);
  const pushed = eventsAfter(service, 'session-turn-model', throughSeq)
    .filter((event) => event.type === 'session.runtime.rebound');
  assert.equal(pushed.length, 1);
  assertRelayCapabilities(pushed[0].payload.capabilitySnapshot);
  await service.waitForActorIdle('session-turn-model');
});

test('work 会话换模型不改能力快照：能力由驱动本身决定，与模型路由无关', () => {
  const writes = [];
  const context = {
    store: {
      getSession: () => ({
        sessionId: 'session-work-model',
        provider: 'codex',
        projectPath: '/tmp/aih-work-model',
        policy: { model: RELAY_MODEL },
        capabilitySnapshot: { revision: 'codex-native' },
        runtimeBinding: {}
      }),
      updateCapabilitySnapshot: () => writes.push('snapshot'),
      appendEvent: () => writes.push('event')
    },
    actors: { getCapabilities: () => ({ revision: 'should-not-be-read' }) }
  };
  ChatRuntimeService.prototype.syncModelCapabilities.call(context,
    { sessionId: 'session-work-model', policy: { model: CANONICAL_MODEL } },
    { type: 'session.policy.set', payload: { key: 'model', value: RELAY_MODEL } });
  assert.deepEqual(writes, []);
});

test('model 策略只挡坏值：空串 / 非字符串 / 超长都拒绝且不落库', async (t) => {
  const { service } = createService(t);
  await createChatSession(service, 'session-bad-model', RELAY_MODEL);
  for (const [index, value] of ['', '   ', 42, null, 'x'.repeat(201)].entries()) {
    await assert.rejects(
      service.dispatchCommand('session-bad-model', {
        commandId: `command-bad-model-${index}`,
        type: 'session.policy.set',
        payload: { key: 'model', value }
      }),
      (error) => error.code === 'chat_session_model_invalid'
    );
  }
  assert.equal(service.store.getSession('session-bad-model').policy.model, RELAY_MODEL);
  assertRelayCapabilities(service.store.getSession('session-bad-model').capabilitySnapshot);
});
