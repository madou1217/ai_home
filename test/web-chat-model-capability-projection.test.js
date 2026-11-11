'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');

const root = path.resolve(__dirname, '..');
const { codexCapabilities } = require('../lib/server/chat-runtime/codex-session-driver-support');
const { goChatCapabilities } = require('../lib/server/chat-runtime/go-chat-driver');

const RUNTIME = Object.freeze({
  capabilityHash: 'capability-hash-web-model',
  fingerprint: 'fingerprint-web-model',
  version: '1.0.0'
});

// 只把 TS 编译成 CJS 后用 require 桩接上依赖；这些模块本身不依赖 React。
function compileTs(relativePath, stubs = {}) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const requireStub = (id) => {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
    throw new Error(`unexpected require ${id} in ${relativePath}`);
  };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, require: requireStub,
    console, JSON, Set, Map, Date, Math, Object, Array, String, Number, Boolean, Error, Promise,
  }, { filename: relativePath });
  return module.exports;
}

function loadClient() {
  const guards = compileTs('web/src/chat-runtime/dto-guards.ts');
  const capabilityParser = compileTs('web/src/chat-runtime/capability-parser.ts', {
    './dto-guards': guards,
  });
  const projection = compileTs('web/src/chat-runtime/projection-state.ts', {
    './projection-error-item': { createProjectionErrorItem: () => null },
    './active-projection': {
      activeQueue: () => [],
      activeInteractions: () => [],
      projectInteractionEvent: () => undefined,
      projectQueueEvent: () => undefined,
    },
  });
  const composerPolicy = compileTs('web/src/features/chat-runtime/composer-policy.ts');
  return {
    parseCapabilitySnapshot: capabilityParser.parseCapabilitySnapshot,
    ProjectionState: projection.ProjectionState,
    resolveComposerPolicy: composerPolicy.resolveComposerPolicy,
  };
}

function emptySnapshot(capabilitySnapshot) {
  return {
    sessionId: 'session-web-model',
    state: 'idle',
    throughSeq: 1,
    runtimeBinding: {},
    capabilitySnapshot,
    policy: { model: 'glm-4.6' },
    queue: [],
    interactions: [],
    timeline: [],
    timelineHasMore: false,
    timelineNextBefore: null,
  };
}

// relay 模型（Go 承接的透传通道）的能力面：只有文本增量。
const RELAY = goChatCapabilities();
// canonical 模型（Node codex 驱动）的能力面：tools / reasoning / approval / plan 全在。
const CANONICAL = codexCapabilities(RUNTIME);

test('服务端的能力快照能通过前端解析：relay 子集字段完整', () => {
  const client = loadClient();
  const parsed = client.parseCapabilitySnapshot(RELAY);
  assert.equal(parsed.revision, 'go-chat-v1');
  assert.equal(parsed.capabilities['timeline.tool'].support, 'unsupported');
  assert.equal(parsed.capabilities['interaction.approval'].support, 'unsupported');
  assert.equal(parsed.capabilities['timeline.reasoning'].support, 'unsupported');
  assert.equal(parsed.capabilities['mode.plan'].support, 'unsupported');
  assert.deepEqual(parsed.slashCommands, ['goal', 'plan']);
  assert.deepEqual(parsed.turnInterveneModes, []);
});

test('session.runtime.rebound 事件让前端快照跟着模型切换，切回 canonical 恢复', () => {
  const client = loadClient();
  const state = new client.ProjectionState();
  state.reset(emptySnapshot(client.parseCapabilitySnapshot(CANONICAL)));

  const canonicalPayload = client.parseCapabilitySnapshot(CANONICAL);
  const relayPayload = client.parseCapabilitySnapshot(RELAY);

  // 选模型 → 服务端推 rebound（payload 只带 capabilitySnapshot，不动 runtimeBinding）。
  state.apply({ type: 'session.runtime.rebound', payload: { capabilitySnapshot: relayPayload } });
  const relayProjection = state.toProjection('session-web-model', 2);
  for (const name of [
    'timeline.tool', 'timeline.reasoning', 'interaction.approval', 'mode.plan',
  ]) {
    assert.equal(relayProjection.capabilitySnapshot.capabilities[name].support, 'unsupported', name);
  }
  // 事件只带能力：运行态绑定保持原样（rebound 的 payload 允许省略 runtimeBinding）。
  assert.deepEqual(relayProjection.runtimeBinding, {});

  // composer 的能力门禁：运行中的轮次不再提供 steer，只保留队列。
  // （数组来自 vm 上下文，先拷回本 realm 再做严格比较。）
  assert.deepEqual(
    Array.from(client.resolveComposerPolicy('running', relayProjection.capabilitySnapshot, false, false, false).deliveries),
    ['after_turn'],
  );

  // 切回 canonical：同一份投影恢复完整能力。
  state.apply({ type: 'session.runtime.rebound', payload: { capabilitySnapshot: canonicalPayload } });
  const canonicalProjection = state.toProjection('session-web-model', 3);
  for (const name of [
    'timeline.tool', 'timeline.reasoning', 'interaction.approval', 'mode.plan',
  ]) {
    assert.equal(canonicalProjection.capabilitySnapshot.capabilities[name].support, 'native', name);
  }
  assert.deepEqual(
    Array.from(client.resolveComposerPolicy('running', canonicalProjection.capabilitySnapshot, false, false, false).deliveries),
    ['steer_current', 'after_turn'],
  );
  assert.deepEqual(
    Array.from(client.resolveComposerPolicy('idle', canonicalProjection.capabilitySnapshot, false, false, false).slashCommands),
    ['compact', 'goal', 'plan'],
  );
});

test('切模型的动作会写入 session.policy.set，运行中的轮次不写', () => {
  const source = fs.readFileSync(
    path.join(root, 'web/src/features/chat-runtime/use-composer-controller.ts'),
    'utf8',
  );
  const start = source.indexOf('const selectModel = useCallback((model: string): void => {');
  assert.ok(start > 0, 'selectModel 命令必须在 composer controller 里');
  const body = source.slice(start, source.indexOf('}, [props.actions', start));
  assert.match(body, /view\.selectModel\(model\)/);
  // 能力快照按 policy.model 求值：空闲时必须落库，否则刷新后仍是旧路由。
  assert.match(body, /view\.policy\.turnActive/);
  assert.match(body, /props\.actions\.setPolicy\('model', resolved\)/);
  // 运行中的轮次由本轮模型决定能力，不在中途改策略。
  assert.match(body, /if \(!resolved \|\| view\.policy\.turnActive\) return;/);
});
