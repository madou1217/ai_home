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
