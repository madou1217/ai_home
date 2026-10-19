'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { shouldDeferGoRouteToNode } = require('../lib/server/go-core-route-deferral');

const LIVE = 'acct_0123456789abcdef0123';
const DOWN = 'acct_aaaaaaaaaaaaaaaaaaaa';
const state = { accounts: { claude: [{ accountRef: LIVE }, { accountRef: DOWN }] } };
const accountStateIndex = {
  getAccountState: (ref) => ({ [LIVE]: { status: 'up' }, [DOWN]: { status: 'down' } }[ref] || null)
};

test('custom account error rules defer exactly the requests that can reach the rule account', () => {
  const { explainGoRouteDeferral } = require('../lib/server/go-core-route-deferral');
  const stateWithRules = { accounts: { claude: [{ accountRef: LIVE }, {
    accountRef: DOWN, upstreamErrorRules: [{ enabled: true }]
  }] } };
  const decide = (pinnedAccountRef) => explainGoRouteDeferral({
    entryId: 'gateway.anthropic.messages', pinnedAccountRef, state: stateWithRules, accountStateIndex
  });
  // 未钉选请求可能跨 Provider/别名回落到带规则的账号，必须交还 Node。
  assert.deepEqual(decide(''), { defer: true, reason: 'account_error_rules' });
  // 可用钉选是独占路由：被钉选账号自己没有规则时，池里别的账号带着规则与本请求无关。
  assert.deepEqual(decide(LIVE), { defer: false, reason: '' });
  // 不可用钉选仍然交还 Node（原因以钉选本身为准，规则不再是决定因素）。
  assert.deepEqual(decide(DOWN), { defer: true, reason: 'pinned_account_unusable' });
  assert.equal(shouldDeferGoRouteToNode({ entryId: 'gateway.props', state: stateWithRules }), false);
});

test('a usable pin whose own account carries unaccepted rules stays with Node', () => {
  const { explainGoRouteDeferral } = require('../lib/server/go-core-route-deferral');
  const stateWithPinnedRules = { accounts: { claude: [{
    accountRef: LIVE, upstreamErrorRules: [{ enabled: true }]
  }, { accountRef: DOWN }] } };
  const input = {
    entryId: 'gateway.anthropic.messages', pinnedAccountRef: LIVE,
    state: stateWithPinnedRules, accountStateIndex, fabricGatewayReady: () => false
  };
  assert.deepEqual(explainGoRouteDeferral(input), { defer: true, reason: 'account_error_rules' });
  // Go 承接了该账号后照常转发。
  assert.deepEqual(explainGoRouteDeferral({ ...input, goAcceptedErrorRuleRefs: () => new Set([LIVE]) }),
    { defer: false, reason: '' });
});

test('usable pins are forwarded; unusable, unknown or malformed pins stay with Node', () => {
  const decide = (pinnedAccountRef) => shouldDeferGoRouteToNode({
    entryId: 'gateway.anthropic.messages', pinnedAccountRef, state, accountStateIndex, fabricGatewayReady: () => false
  });
  assert.equal(decide(LIVE), false);
  assert.equal(decide(DOWN), true, 'Node owns fallback / 403 pinned_account_unavailable');
  assert.equal(decide('acct_bbbbbbbbbbbbbbbbbbbb'), true, 'Node owns 404 unknown_account_ref');
  assert.equal(decide('not-a-ref'), true, 'Node owns 400 invalid_account_ref');
});

test('a persisted billing block makes a pin unusable even while its lifecycle is up', () => {
  const blocked = 'acct_bbbbbbbbbbbbbbbbbbbb';
  const blockedState = {
    accounts: { claude: [{ accountRef: LIVE }, { accountRef: blocked }] }
  };
  const blockedIndex = {
    getAccountState: (ref) => ({
      [LIVE]: { status: 'up' },
      [blocked]: {
        status: 'up',
        runtimeState: {
          routingBlock: { kind: 'billing_blocked', reason: 'billing_blocked', observedAt: Date.now() }
        }
      }
    }[ref] || null)
  };
  assert.equal(shouldDeferGoRouteToNode({
    entryId: 'gateway.anthropic.messages', pinnedAccountRef: blocked,
    state: blockedState, accountStateIndex: blockedIndex, fabricGatewayReady: () => false
  }), true);
});

test('explicit provider selection keeps unpinned inference with Node', () => {
  const { explainGoRouteDeferral } = require('../lib/server/go-core-route-deferral');
  const input = {
    entryId: 'gateway.anthropic.messages', state, accountStateIndex, fabricGatewayReady: () => false
  };
  // Go 不读 x-provider：携带该头的未钉选请求必须留在 Node，否则 Go 可能选中另一个 Provider。
  assert.deepEqual(explainGoRouteDeferral({ ...input, explicitProvider: 'claude' }),
    { defer: true, reason: 'explicit_provider' });
  assert.deepEqual(explainGoRouteDeferral({ ...input, explicitProvider: '  ' }),
    { defer: false, reason: '' }, '空白值不是显式选择');
  // 钉选 + 显式 Provider 同现时账号由钉选决定，显式选择不影响路由。
  assert.deepEqual(explainGoRouteDeferral({ ...input, explicitProvider: 'claude', pinnedAccountRef: LIVE }),
    { defer: false, reason: '' });
  // 非推理入口与 Provider 选择无关。
  assert.equal(shouldDeferGoRouteToNode({ entryId: 'gateway.props', explicitProvider: 'claude', state }), false);
});

test('a model-namespace header on a bare model keeps inference with Node, pinned or not', () => {
  const { explainGoRouteDeferral } = require('../lib/server/go-core-route-deferral');
  const input = {
    entryId: 'gateway.anthropic.messages', state, accountStateIndex, fabricGatewayReady: () => false
  };
  // 补全（裸名 → opencode/<model>）只在 Node v1-router 发生：Go 收到裸名会选不到账号。
  assert.deepEqual(explainGoRouteDeferral({ ...input, modelNamespace: 'opencode', model: 'deepseek-v4.1-flash-free' }),
    { defer: true, reason: 'model_namespace_header' });
  assert.deepEqual(explainGoRouteDeferral({
    ...input, modelNamespace: 'opencode', model: 'deepseek-v4.1-flash-free', pinnedAccountRef: LIVE
  }), { defer: true, reason: 'model_namespace_header' });
  // 已带命名空间的模型 Node 也不改写，语义两侧一致，不必交还。
  assert.deepEqual(explainGoRouteDeferral({ ...input, modelNamespace: 'opencode', model: 'opencode/x' }),
    { defer: false, reason: '' });
  // 非法命名空间值 Node 忽略，这里同样忽略。
  assert.deepEqual(explainGoRouteDeferral({ ...input, modelNamespace: 'Bad Value!', model: 'x' }),
    { defer: false, reason: '' });
  assert.equal(shouldDeferGoRouteToNode({ entryId: 'gateway.props', modelNamespace: 'opencode', model: 'x', state }), false);
});

test('an online Fabric gateway keeps unpinned inference with Node but not read-only routes', () => {
  const decide = (entryId, fabricReady, pinnedAccountRef = '') => shouldDeferGoRouteToNode({
    entryId, pinnedAccountRef, state, accountStateIndex, fabricGatewayReady: () => fabricReady
  });
  assert.equal(decide('gateway.anthropic.messages', true), true);
  assert.equal(decide('gateway.anthropic.messages', false), false);
  assert.equal(decide('gateway.props', true), false);
  // Node 对钉选请求本来就不走 Fabric，可用钉选照常交给 Go。
  assert.equal(decide('gateway.anthropic.messages', true, LIVE), false);
});

test('inference whose model hits an enabled Node alias stays with Node', () => {
  const { modelMatchesEnabledAlias } = require('../lib/server/go-core-route-deferral');
  const aliases = [
    { alias: 'claude-opus-4-8', target: 'gemini-3.8-flash-high', enabled: true },
    { alias: 'claude-opus-5*', target: 'gemini-3.8-flash-high', enabled: true },
    { alias: 'claude-*', target: 'x', enabled: false }
  ];
  assert.equal(modelMatchesEnabledAlias(aliases, 'claude-opus-4-8'), true);
  assert.equal(modelMatchesEnabledAlias(aliases, 'claude-opus-5-5'), true);
  assert.equal(modelMatchesEnabledAlias(aliases, 'claude-haiku-4-5'), false, 'disabled wildcard does not count');
  assert.equal(modelMatchesEnabledAlias(aliases, ''), false);

  const decide = (entryId, model, pinnedAccountRef = '') => shouldDeferGoRouteToNode({
    entryId, model, pinnedAccountRef, aliases, state, accountStateIndex, fabricGatewayReady: () => false
  });
  assert.equal(decide('gateway.anthropic.messages', 'claude-opus-4-8'), true);
  assert.equal(decide('gateway.anthropic.messages', 'claude-haiku-4-5'), false);
  assert.equal(decide('gateway.props', 'claude-opus-4-8'), false, 'aliases only matter for inference');
  // Node 对可用钉选不使用别名，这类请求照常交给 Go。
  assert.equal(decide('gateway.anthropic.messages', 'claude-opus-4-8', LIVE), false);
});

test('aliases Go has confirmed it can resolve are forwarded, the rest stay with Node', () => {
  const { modelMatchesUnacceptedAlias } = require('../lib/server/go-core-route-deferral');
  const aliases = [
    { id: 'a1', alias: 'claude-opus-4-8', target: 'gemini-3.8-flash-high', enabled: true },
    { id: 'a2', alias: 'claude-opus-5*', target: 'gpt-6-sol', enabled: true },
    // 插件别名不在 Go 的投影里，永远没有接受记录。
    { id: 'plugin:inst:claude-fast', alias: 'claude-fast', target: 'gpt-6-mini', enabled: true }
  ];
  const accepted = new Set(['a1', 'a2']);
  assert.equal(modelMatchesUnacceptedAlias(aliases, 'claude-opus-4-8', accepted), false);
  assert.equal(modelMatchesUnacceptedAlias(aliases, 'claude-opus-5-5', accepted), false);
  assert.equal(modelMatchesUnacceptedAlias(aliases, 'claude-fast', accepted), true, 'plugin aliases are never Go-accepted');
  // 没有接受集合（Go 未确认别名表）时全部保守交还。
  assert.equal(modelMatchesUnacceptedAlias(aliases, 'claude-opus-4-8', null), true);
  assert.equal(modelMatchesUnacceptedAlias(aliases, 'claude-opus-4-8', new Set()), true);

  const decide = (model, ids) => shouldDeferGoRouteToNode({
    entryId: 'gateway.anthropic.messages', model, pinnedAccountRef: '', aliases,
    goAcceptedAliasIds: () => ids, state, accountStateIndex, fabricGatewayReady: () => false
  });
  assert.equal(decide('claude-opus-4-8', accepted), false);
  assert.equal(decide('claude-fast', accepted), true);
  assert.equal(decide('claude-opus-4-8', null), true);
  // 宿主没有注入访问器时同样保守交还。
  assert.equal(shouldDeferGoRouteToNode({
    entryId: 'gateway.anthropic.messages', model: 'claude-opus-4-8', aliases,
    state, accountStateIndex, fabricGatewayReady: () => false
  }), true);
});

test('blob fetches stay with Node only when the Node blob store holds the id', () => {
  const decide = (pathname, known) => shouldDeferGoRouteToNode({
    entryId: 'gateway.vision.blobs', pathname, state, accountStateIndex,
    getNodeBlob: (id) => (known.includes(id) ? { bytes: Buffer.alloc(1), mime: 'image/png' } : null)
  });
  assert.equal(decide('/v1/blobs/node-made', ['node-made']), true);
  assert.equal(decide('/v1/blobs/go-made', ['node-made']), false);
});

test('inference for models Go cannot route stays with Node', () => {
  const goIds = new Set(['claude-haiku-4-5-20251001', 'gpt-5.5']);
  const decide = (model, ids) => shouldDeferGoRouteToNode({
    entryId: 'gateway.anthropic.messages', model, aliases: [], state, accountStateIndex,
    fabricGatewayReady: () => false, goRoutableModelIds: () => ids
  });
  assert.equal(decide('claude-haiku-4-5-20251001', goIds), false);
  assert.equal(decide('kimi-k2.6', goIds), true, 'Node-only provider model');
  assert.equal(decide('claude-haiku-4-5-20251001', null), true, 'catalog not loaded yet');
  assert.equal(decide('', goIds), false, 'no model: let Go answer the protocol error');
});

test('responses to agy accounts and non-openai models are served by Go (codex CLI shape fixed)', () => {
  const CODEX = 'acct_cccccccccccccccccccc';
  const AGY = 'acct_dddddddddddddddddddd';
  const mixedState = { accounts: { codex: [{ accountRef: CODEX }], agy: [{ accountRef: AGY }] } };
  const index = { getAccountState: () => ({ status: 'up' }) };
  const owners = { 'gpt-5.5': 'openai', 'claude-opus-4-6-thinking': 'anthropic' };
  const decide = (entryId, pinnedAccountRef, model) => shouldDeferGoRouteToNode({
    entryId, pinnedAccountRef, model, aliases: [], state: mixedState, accountStateIndex: index,
    fabricGatewayReady: () => false,
    goRoutableModelIds: () => new Set(Object.keys(owners)),
    goModelOwner: (id) => owners[id] || ''
  });
  assert.equal(decide('gateway.openai.responses', CODEX, 'gpt-5.5'), false);
  assert.equal(decide('gateway.openai.responses', AGY, 'claude-opus-4-6-thinking'), false);
  assert.equal(decide('gateway.openai.responses.websocket', AGY, ''), false);
  assert.equal(decide('gateway.openai.responses', '', 'claude-opus-4-6-thinking'), false);
  assert.equal(decide('gateway.openai.responses', '', 'gpt-5.5'), false);
  assert.equal(decide('gateway.anthropic.messages', AGY, 'claude-opus-4-6-thinking'), false, 'other protocols unaffected');
});

test('pins without a Go account mapping or with a model Go cannot route stay with Node', () => {
  const decide = (model, goRef, ids) => shouldDeferGoRouteToNode({
    entryId: 'gateway.openai.responses', pinnedAccountRef: LIVE, model, aliases: [], state, accountStateIndex,
    fabricGatewayReady: () => false,
    goAccountRefFor: () => goRef,
    goRoutableModelIds: () => ids
  });
  const ids = new Set(['gpt-5.5']);
  assert.equal(decide('gpt-5.5', 'acct_bbbbbbbbbbbbbbbbbbbb', ids), false, 'mapped (possibly rekeyed) pin goes to Go');
  assert.equal(decide('gpt-5.5', '', ids), true, 'Go does not know this account');
  assert.equal(decide('gpt-6-astra', 'acct_bbbbbbbbbbbbbbbbbbbb', ids), true, 'Go cannot route the model');
});

test('every Node hand-off reports a reason so /readyz can break it down', () => {
  const { explainGoRouteDeferral } = require('../lib/server/go-core-route-deferral');
  const base = { state, accountStateIndex, fabricGatewayReady: () => false };
  const cases = [
    ['node_blob', { ...base, entryId: 'gateway.vision.blobs', pathname: '/v1/blobs/node-made', getNodeBlob: () => ({ bytes: Buffer.alloc(1) }) }],
    ['pinned_account_unusable', { ...base, entryId: 'gateway.anthropic.messages', pinnedAccountRef: DOWN }],
    ['pinned_account_unmapped', { ...base, entryId: 'gateway.anthropic.messages', pinnedAccountRef: LIVE, model: 'gpt-5.5', goAccountRefFor: () => '' }],
    ['pinned_model_not_routable', { ...base, entryId: 'gateway.anthropic.messages', pinnedAccountRef: LIVE, model: 'gpt-6-astra', goAccountRefFor: () => 'acct_ffffffffffffffffffff', goRoutableModelIds: () => new Set(['gpt-5.5']) }],
    ['fabric_gateway_online', { ...base, entryId: 'gateway.anthropic.messages', fabricGatewayReady: () => true }],
    ['model_alias', { ...base, entryId: 'gateway.anthropic.messages', model: 'claude-opus-4-8', aliases: [{ alias: 'claude-opus-4-8', enabled: true }] }],
    ['model_not_routable', { ...base, entryId: 'gateway.anthropic.messages', model: 'kimi-k2.6', aliases: [], goRoutableModelIds: () => new Set(['gpt-5.5']) }],
    // 池门的模型级收窄：池里有 Go 服务不了的 Provider，但索引里没有任何账号绑定这个模型
    // （目录全已知且都不含它，或索引未建）→ 交还 Node 裁定，而不是由 Go 提前合成
    // no_available_account。
    // 用 kiro 而不是 kimi：kimi 已接入 Go 的 relay 通道（2026-10-17），拿它做
    // 「Go 服务不了」的例子会让本用例失去意义。选例必须挑当前确实不可服务的 Provider。
    ['pool_model_carriers_unknown', {
      ...base,
      entryId: 'gateway.openai.chat_completions',
      model: 'hy4-preview',
      state: {
        accounts: { workbuddy: [{ accountRef: LIVE }], kiro: [{ accountRef: DOWN }] },
        modelAccountIndex: {
          builtAt: 1,
          modelToAccounts: new Map([
            ['hy3-legacy', [LIVE]],
            ['kiro-model', [DOWN]]
          ]),
          accountToModels: new Map([
            [LIVE, new Set(['hy3-legacy'])],
            [DOWN, new Set(['kiro-model'])]
          ]),
          accountByRef: new Map([
            [LIVE, { accountRef: LIVE, provider: 'workbuddy' }],
            [DOWN, { accountRef: DOWN, provider: 'kiro' }]
          ])
        }
      },
      aliases: [],
      goRoutableModelIds: () => new Set(['hy4-preview'])
    }]
  ];
  for (const [reason, input] of cases) {
    const decision = explainGoRouteDeferral(input);
    assert.equal(decision.defer, true, reason);
    assert.equal(decision.reason, reason);
    // 布尔包装与原因判定必须永远一致，否则 /readyz 的计数会和实际转发行为对不上。
    assert.equal(shouldDeferGoRouteToNode(input), true, reason);
  }
});

test('a forwarded request carries no reason, so normal routing is never counted as a fallback', () => {
  const { explainGoRouteDeferral } = require('../lib/server/go-core-route-deferral');
  const decision = explainGoRouteDeferral({
    entryId: 'gateway.anthropic.messages',
    model: 'gpt-5.5',
    aliases: [],
    state,
    accountStateIndex,
    fabricGatewayReady: () => false,
    goRoutableModelIds: () => new Set(['gpt-5.5'])
  });
  assert.equal(decision.defer, false);
  assert.equal(decision.reason, '');

test('account error rules leave Node only once Go confirms it took the account over', () => {
  const { explainGoRouteDeferral } = require('../lib/server/go-core-route-deferral');
  const RULES = 'acct_eeeeeeeeeeeeeeeeeeee';
  const stateWithRules = {
    accounts: { claude: [{ accountRef: LIVE }, { accountRef: RULES, upstreamErrorRules: [{ enabled: true }] }] }
  };
  const decide = (acceptedRefs, mapRef) => explainGoRouteDeferral({
    entryId: 'gateway.anthropic.messages', pinnedAccountRef: '', model: 'gpt-5.5',
    aliases: [], state: stateWithRules, accountStateIndex, fabricGatewayReady: () => false,
    goRoutableModelIds: () => new Set(['gpt-5.5']),
    goAcceptedErrorRuleRefs: () => acceptedRefs,
    goAccountRefFor: mapRef
  });
  // 未确认（Go 还没就绪 / 推送失败 / 被 Provider 能力丢弃）继续交还 Node。
  assert.deepEqual(decide(new Set(), null), { defer: true, reason: 'account_error_rules' });
  assert.deepEqual(decide(null, null), { defer: true, reason: 'account_error_rules' });
  assert.deepEqual(decide(new Set(['acct_other']), (ref) => (ref === LIVE ? 'acct_other' : '')), { defer: true, reason: 'account_error_rules' });
  // Go 已承接该账号（含同步 rekey 后的 Go 引用）时不再交还。
  assert.deepEqual(decide(new Set([RULES]), null), { defer: false, reason: '' });
  assert.deepEqual(decide(new Set(['go_ref']), (ref) => (ref === RULES ? 'go_ref' : '')), { defer: false, reason: '' });
  // 宿主没注入访问器（旧装配）时保持接入前的保守行为。
  assert.equal(shouldDeferGoRouteToNode({
    entryId: 'gateway.anthropic.messages', model: 'gpt-5.5', aliases: [], state: stateWithRules,
    accountStateIndex, fabricGatewayReady: () => false, goRoutableModelIds: () => new Set(['gpt-5.5'])
  }), true);
});

});

// 2026-10-19：Go Core 不执行账号出口。账号绑定了网关侧出口（代理地址 / 出口池 / 系统代理）时，
// 被 Go 承接的请求会绕过出口直连上游 —— 必须交还 Node。作用域与自定义错误规则一致。
test('requests that may land on an account with a gateway-side egress stay on Node', () => {
  const { explainGoRouteDeferral } = require('../lib/server/go-core-route-deferral');
  const { createAccountEgressBindingIndex, requiresNodeEgress } = require('../lib/server/account-egress-binding-index');
  const boundRef = 'acct_aaaaaaaaaaaaaaaaaaaa';
  const freeRef = 'acct_bbbbbbbbbbbbbbbbbbbb';
  const state = { accounts: { claude: [{ accountRef: boundRef, provider: 'claude' }, { accountRef: freeRef, provider: 'claude' }] } };
  const base = {
    entryId: 'gateway.anthropic.messages',
    model: 'claude-sonnet-5-5',
    state,
    goRoutableModelIds: () => new Set(['claude-sonnet-5-5']),
    goModelOwner: () => 'claude'
  };

  const unpinned = explainGoRouteDeferral({ ...base, egressBoundRefs: () => new Set([boundRef]) });
  assert.deepEqual(unpinned, { defer: true, reason: 'account_egress' });
  assert.equal(explainGoRouteDeferral({ ...base, egressBoundRefs: () => null }).reason, 'account_egress', 'unknown index is conservative');
  assert.notEqual(explainGoRouteDeferral({ ...base, egressBoundRefs: () => new Set() }).reason, 'account_egress');
  // Go 服务不了的 Provider（例如 opencode）的出口绑定不影响 Go 的转发。
  const withOpencode = { ...base, state: { accounts: { ...state.accounts, opencode: [{ accountRef: 'acct_cccccccccccccccccccc', provider: 'opencode' }] } } };
  assert.notEqual(explainGoRouteDeferral({ ...withOpencode, egressBoundRefs: () => new Set(['acct_cccccccccccccccccccc']) }).reason, 'account_egress');
  // 钉选：只看被钉选账号自己。
  const { goServesInference } = require('../lib/server/go-core-servable-providers');
  assert.equal(goServesInference('claude', 'gateway.anthropic.messages'), true, 'fixture assumes claude is Go-servable here');

  // 索引：只有网关侧改写出站的模式需要 Node；tun 在网关是直连，与 Go 一致。
  assert.equal(requiresNodeEgress({ mode: 'url' }), true);
  assert.equal(requiresNodeEgress({ mode: 'pool' }), true);
  assert.equal(requiresNodeEgress({ mode: 'system' }), true);
  assert.equal(requiresNodeEgress({ mode: 'tun' }), false);
  assert.equal(requiresNodeEgress({ mode: 'node', retired: true }), true);
  let calls = 0;
  let clock = 0;
  const index = createAccountEgressBindingIndex({
    aiHomeDir: '/x',
    ttlMs: 1000,
    now: () => clock,
    listBindings: () => { calls += 1; return [{ accountRef: boundRef, binding: { mode: 'pool' } }, { accountRef: freeRef, binding: { mode: 'tun' } }]; }
  });
  assert.deepEqual([...index.refs()], [boundRef]);
  index.refs();
  assert.equal(calls, 1, 'cached within the TTL');
  index.invalidate();
  index.refs();
  assert.equal(calls, 2, 'invalidate forces a reload');
  clock = 5000;
  index.refs();
  assert.equal(calls, 3, 'reloads after the TTL');
  assert.equal(index.requiresNode(freeRef), false);
  const broken = createAccountEgressBindingIndex({ aiHomeDir: '/x', listBindings: () => { throw new Error('db'); } });
  assert.equal(broken.refs(), null);
  assert.equal(broken.requiresNode(freeRef), true);
});
