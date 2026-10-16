'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAccountInstanceRegistry } = require('../lib/server/account-instance-registry');

const REF_A = 'acct_0123456789abcdef0123';
const REF_B = 'acct_aaaaaaaaaaaaaaaaaaaa';

test('an accountRef resolves to the same object identity for its whole lifetime', () => {
  const registry = createAccountInstanceRegistry();
  const account = { accountRef: REF_A, provider: 'codex', failCount: 0 };
  registry.register(REF_A, account);

  // 核心不变量：取回来的是**同一个对象**，不是副本、不是 Proxy、不是原型链包装。
  assert.equal(registry.get(REF_A), account);
  assert.equal(registry.get(REF_A), registry.get(REF_A));
  assert.equal(registry.size(), 1);
});

test('mutating the instance is visible through every reader without a write-through proxy', () => {
  const registry = createAccountInstanceRegistry();
  const account = { accountRef: REF_A, provider: 'codex' };
  registry.register(REF_A, account);

  // 注册表不复制对象，所以「写入者」与「读取者」天然是同一份状态。
  account.cooldownUntil = 12345;
  assert.equal(registry.get(REF_A).cooldownUntil, 12345);

  // 反向：从注册表拿到的实例上写入，原对象也看得到。
  registry.get(REF_A).failCount = 3;
  assert.equal(account.failCount, 3);
});

test('re-registering the same ref with the same object is idempotent', () => {
  const registry = createAccountInstanceRegistry();
  const account = { accountRef: REF_A, provider: 'codex' };
  registry.register(REF_A, account);
  registry.register(REF_A, account);
  assert.equal(registry.size(), 1);
  assert.equal(registry.get(REF_A), account);
});

test('reloading a ref with a new object replaces the identity and orphans the old one', () => {
  const registry = createAccountInstanceRegistry();
  const before = { accountRef: REF_A, provider: 'codex', cooldownUntil: 999 };
  const after = { accountRef: REF_A, provider: 'codex', cooldownUntil: 0 };
  registry.register(REF_A, before);
  registry.register(REF_A, after);

  assert.equal(registry.get(REF_A), after, '重载后取到新实例');
  assert.notEqual(registry.get(REF_A), before);
  assert.equal(registry.size(), 1, '同 ref 不产生第二条记录');
});

test('unregister removes both the instance and its provider binding', () => {
  const registry = createAccountInstanceRegistry();
  registry.register(REF_A, { accountRef: REF_A, provider: 'codex' });
  assert.equal(registry.providerOf(REF_A), 'codex');

  assert.equal(registry.unregister(REF_A), true);
  assert.equal(registry.get(REF_A), null);
  assert.equal(registry.providerOf(REF_A), '');
  assert.equal(registry.has(REF_A), false);
  assert.equal(registry.unregister(REF_A), false, '重复删除是幂等的');
});

test('refsForProvider groups by the declared provider, not by a mutated instance field', () => {
  const registry = createAccountInstanceRegistry();
  registry.register(REF_A, { accountRef: REF_A, provider: 'codex' }, 'codex');
  registry.register(REF_B, { accountRef: REF_B, provider: 'claude' }, 'claude');

  // 实例字段被上游改写（例如协议适配器临时标注），分组仍以注册时的声明为准。
  registry.get(REF_A).provider = 'claude';
  assert.deepEqual(registry.refsForProvider('codex'), [REF_A]);
  assert.deepEqual(registry.refsForProvider('claude'), [REF_B]);
});

test('providerOf falls back to the instance field when no provider was declared', () => {
  const registry = createAccountInstanceRegistry();
  registry.register(REF_A, { accountRef: REF_A, provider: 'WorkBuddy' });
  assert.equal(registry.providerOf(REF_A), 'workbuddy', '归一为小写');
});

test('malformed refs and non-object accounts are rejected instead of stored', () => {
  const registry = createAccountInstanceRegistry();
  assert.equal(registry.register('not-a-ref', { provider: 'codex' }), null);
  assert.equal(registry.register('', { provider: 'codex' }), null);
  assert.equal(registry.register(REF_A, null), null);
  assert.equal(registry.register(REF_A, 'account'), null);
  assert.equal(registry.size(), 0);

  // 非法 ref 查询一律返回 null/空，不抛异常。
  assert.equal(registry.get('nope'), null);
  assert.equal(registry.get(''), null);
  assert.equal(registry.providerOf('nope'), '');
  assert.deepEqual(registry.refsForProvider('nope'), []);
});

test('clear drops every instance so a full reload starts from a clean slate', () => {
  const registry = createAccountInstanceRegistry();
  registry.register(REF_A, { accountRef: REF_A, provider: 'codex' });
  registry.register(REF_B, { accountRef: REF_B, provider: 'claude' });
  assert.equal(registry.size(), 2);

  registry.clear();
  assert.equal(registry.size(), 0);
  assert.deepEqual(registry.refs(), []);
  assert.equal(registry.get(REF_A), null);
});

test('byRef exposes the one shared container instead of a per-consumer copy', () => {
  const registry = createAccountInstanceRegistry();
  const account = { accountRef: REF_A, provider: 'codex' };
  registry.register(REF_A, account);

  // 两个「索引」拿到的是同一张 Map：这才是收敛，各存一份副本正是要消灭的形态。
  const indexA = registry.byRef;
  const indexB = registry.byRef;
  assert.equal(indexA, indexB);

  // 任一处的写入，另一处立即可见——不需要 Proxy 写穿透。
  indexA.set(REF_A, account);
  assert.equal(indexB.get(REF_A), account);
});

test('retain keeps the listed refs and drops everything else', () => {
  const registry = createAccountInstanceRegistry();
  registry.register(REF_A, { accountRef: REF_A, provider: 'codex' });
  registry.register(REF_B, { accountRef: REF_B, provider: 'claude' });

  registry.retain([REF_A]);
  assert.equal(registry.has(REF_A), true);
  assert.equal(registry.has(REF_B), false, '不在保留集合里的账号被清掉');
  assert.equal(registry.providerOf(REF_B), '', 'provider 绑定一并清理，不留悬空');
  assert.equal(registry.size(), 1);
});

test('retain accepts a Set and ignores malformed entries', () => {
  const registry = createAccountInstanceRegistry();
  registry.register(REF_A, { accountRef: REF_A, provider: 'codex' });
  registry.register(REF_B, { accountRef: REF_B, provider: 'claude' });

  registry.retain(new Set([REF_A, 'not-a-ref', '', null]));
  assert.deepEqual(registry.refs(), [REF_A]);
});
