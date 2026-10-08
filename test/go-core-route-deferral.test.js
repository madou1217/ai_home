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

test('usable pins are forwarded; unusable, unknown or malformed pins stay with Node', () => {
  const decide = (pinnedAccountRef) => shouldDeferGoRouteToNode({
    entryId: 'gateway.anthropic.messages', pinnedAccountRef, state, accountStateIndex, fabricGatewayReady: () => false
  });
  assert.equal(decide(LIVE), false);
  assert.equal(decide(DOWN), true, 'Node owns fallback / 403 pinned_account_unavailable');
  assert.equal(decide('acct_bbbbbbbbbbbbbbbbbbbb'), true, 'Node owns 404 unknown_account_ref');
  assert.equal(decide('not-a-ref'), true, 'Node owns 400 invalid_account_ref');
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
    ['model_not_routable', { ...base, entryId: 'gateway.anthropic.messages', model: 'kimi-k2.6', aliases: [], goRoutableModelIds: () => new Set(['gpt-5.5']) }]
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
});
