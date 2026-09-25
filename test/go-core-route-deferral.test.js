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
