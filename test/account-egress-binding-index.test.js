'use strict';

// 2026-11-06：direct（显式直连）是否必须交还 Node，取决于 Go 有没有全局代理。
// 没有全局代理时 Go 的行为就是直连，再交还只会让 relay 永远轮不到 Go。

const test = require('node:test');
const assert = require('node:assert/strict');

const { bindingRequiresNode, listNodeBoundRefs } = require('../lib/server/account-egress-go-scope');

const BINDINGS = [
  { accountRef: 'acct_direct', binding: { mode: 'direct' } },
  { accountRef: 'acct_url', binding: { mode: 'url', url: 'http://proxy.local:8080' } },
  { accountRef: 'acct_pool', binding: { mode: 'pool' } },
  { accountRef: 'acct_system', binding: { mode: 'system' } },
  { accountRef: 'acct_tun', binding: { mode: 'tun' } },
  { accountRef: 'acct_retired', binding: { mode: 'url', retired: true } }
];

function refsFor(goHasGlobalProxy) {
  return listNodeBoundRefs({
    aiHomeDir: '/tmp/aih-egress-test',
    goHasGlobalProxy,
    listBindings: () => BINDINGS
  });
}

test('Go 无全局代理：direct 不再交还 Node', () => {
  const refs = refsFor(false);
  assert.equal(refs.has('acct_direct'), false, 'direct 在 Go 无全局代理时应由 Go 承接');
  for (const ref of ['acct_url', 'acct_pool', 'acct_system', 'acct_retired']) {
    assert.equal(refs.has(ref), true, ref + ' 仍必须交还 Node');
  }
  assert.equal(refs.has('acct_tun'), false, 'tun 在网关侧就是直连，不需要交还');
});

test('Go 有全局代理：direct 必须交还 Node（避免绕过用户要求的直连）', () => {
  assert.equal(refsFor(true).has('acct_direct'), true);
});

test('bindingRequiresNode 口径', () => {
  assert.equal(bindingRequiresNode({ mode: 'direct' }, false), false);
  assert.equal(bindingRequiresNode({ mode: 'direct' }, true), true);
  assert.equal(bindingRequiresNode({ mode: 'url' }, false), true);
  assert.equal(bindingRequiresNode({ mode: 'tun' }, true), false);
  assert.equal(bindingRequiresNode({ mode: 'url', retired: true }, false), true);
  assert.equal(bindingRequiresNode(null, true), false);
});

test('读不出绑定表时保守返回 null', () => {
  const refs = listNodeBoundRefs({
    aiHomeDir: '/tmp/aih-egress-test',
    goHasGlobalProxy: false,
    listBindings: () => { throw new Error('db unavailable'); }
  });
  assert.equal(refs, null);
});
