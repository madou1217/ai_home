'use strict';

// provider 作用域的两条硬约束：
//   1. 通配符只认 * 和 ?，大小写不敏感；匹配不到必须报错，绝不静默退化成全量；
//   2. `aih '*buddy*' ls` 与 `aih ls --scope codebuddy codebuddycn workbuddy workbuddycn`
//      必须解析成同一份名单 —— 两种写法是同一个语义的两个入口。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isProviderPattern,
  matchProviderPattern,
  resolveProviderScope,
  parseProviderScopeArgs,
  describeScopeMiss
} = require('../lib/cli/services/profile/provider-scope');
const { resolveLsRequest } = require('../lib/cli/services/profile/ls-request');
const {
  listAccountProviders,
  isSupportedAiCli
} = require('../lib/cli/services/ai-cli/provider-registry');

const PROVIDERS = listAccountProviders();
const BUDDY = ['codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn'];

test('通配符：* 前后缀与中间匹配都成立', () => {
  assert.deepEqual(matchProviderPattern('*buddy*', PROVIDERS), BUDDY);
  assert.deepEqual(matchProviderPattern('*buddy', PROVIDERS), ['codebuddy', 'workbuddy']);
  assert.deepEqual(matchProviderPattern('buddy*', PROVIDERS), []);
  assert.deepEqual(matchProviderPattern('code*', PROVIDERS), ['codex', 'codebuddy', 'codebuddycn']);
  assert.deepEqual(matchProviderPattern('code?uddy', PROVIDERS), ['codebuddy']);
});

test('通配符：大小写不敏感，全名精确匹配不被通配抢走', () => {
  assert.deepEqual(matchProviderPattern('CodeBuddy', PROVIDERS), ['codebuddy']);
  assert.deepEqual(matchProviderPattern('CODEBUDDY*', PROVIDERS), ['codebuddy', 'codebuddycn']);
  assert.deepEqual(matchProviderPattern('  codex  ', PROVIDERS), ['codex']);
  assert.equal(isProviderPattern('codex'), false);
  assert.equal(isProviderPattern('code*'), true);
  assert.equal(isProviderPattern('code?'), true);
});

test('resolveProviderScope：并集去重、未命中单独返回', () => {
  const resolved = resolveProviderScope(['*buddy*', 'codebuddy', 'codex'], PROVIDERS);
  assert.deepEqual(resolved.providers, [...BUDDY, 'codex']);
  assert.deepEqual(resolved.unmatched, []);

  const partial = resolveProviderScope(['codex', 'nope*'], PROVIDERS);
  assert.deepEqual(partial.providers, ['codex']);
  assert.deepEqual(partial.unmatched, ['nope*']);
});

test('parseProviderScopeArgs：三种 --scope 写法与位置参数分离', () => {
  assert.deepEqual(parseProviderScopeArgs(['--scope', 'codebuddy', 'workbuddy']), {
    patterns: ['codebuddy', 'workbuddy'], rest: [], used: true
  });
  assert.deepEqual(parseProviderScopeArgs(['--scope=codebuddy,workbuddy']), {
    patterns: ['codebuddy', 'workbuddy'], rest: [], used: true
  });
  assert.deepEqual(parseProviderScopeArgs(['--scope', 'codex', '--scope', 'zcode']), {
    patterns: ['codex', 'zcode'], rest: [], used: true
  });
  // 纯数字是账号 id，不是 provider 名：留在位置参数里。
  assert.deepEqual(parseProviderScopeArgs(['--scope', 'codebuddy', '24444', 'x']), {
    patterns: ['codebuddy'], rest: ['24444', 'x'], used: true
  });
  assert.deepEqual(parseProviderScopeArgs(['codebuddy', 'ls']), {
    patterns: [], rest: ['codebuddy', 'ls'], used: false
  });
});

test('describeScopeMiss：报错带上可选值，前缀写错时给出更宽松的建议', () => {
  const plain = describeScopeMiss(['nope*'], PROVIDERS);
  assert.match(plain, /No provider matches "nope\*"/);
  assert.match(plain, /Known providers: .*codebuddy/);
  assert.doesNotMatch(plain, /Did you mean/);

  const hinted = describeScopeMiss(['buddy*'], PROVIDERS);
  assert.match(hinted, /Did you mean "\*buddy\*"/);
  assert.match(hinted, /codebuddy, codebuddycn, workbuddy, workbuddycn/);
});

function plan(tokens) {
  return resolveLsRequest(tokens, { providerNames: PROVIDERS, isSupportedCli: isSupportedAiCli });
}

test('resolveLsRequest：全量 / 单 provider / 账号 id', () => {
  assert.deepEqual(plan(['ls']), { action: 'list', providers: null, filterId: null, pattern: null });
  assert.deepEqual(plan(['codebuddy', 'ls']), {
    action: 'list', providers: ['codebuddy'], filterId: null, pattern: null
  });
  assert.deepEqual(plan(['codebuddy', 'ls', '24444']), {
    action: 'list', providers: ['codebuddy'], filterId: '24444', pattern: null
  });
});

test('resolveLsRequest：通配符与 --scope 是同一个语义的两个入口', () => {
  const globbed = plan(['*buddy*', 'ls']);
  const scoped = plan(['ls', '--scope', ...BUDDY]);
  assert.deepEqual(globbed.providers, BUDDY);
  assert.deepEqual(scoped.providers, BUDDY);
  assert.equal(globbed.filterId, null);
  assert.equal(scoped.filterId, null);

  assert.deepEqual(plan(['*buddy', 'ls']).providers, ['codebuddy', 'workbuddy']);
  assert.deepEqual(plan(['*buddy*', 'ls', '7']).filterId, '7');
});

test('resolveLsRequest：匹配不到就报错，不退化成全量列表', () => {
  const missing = plan(['buddy*', 'ls']);
  assert.equal(missing.action, 'error');
  assert.match(missing.message, /Did you mean "\*buddy\*"/);

  const unknownScope = plan(['ls', '--scope', 'nope']);
  assert.equal(unknownScope.action, 'error');

  const emptyScope = plan(['ls', '--scope']);
  assert.equal(emptyScope.action, 'error');
  assert.match(emptyScope.message, /--scope needs at least one provider/);

  const noOverlap = plan(['codebuddy', 'ls', '--scope', 'workbuddy']);
  assert.equal(noOverlap.action, 'error');
});

test('resolveLsRequest：help 与非法 id', () => {
  assert.deepEqual(plan(['ls', '--help']), { action: 'help', scope: null });
  assert.deepEqual(plan(['codebuddy', 'ls', '-h']), { action: 'help', scope: 'codebuddy' });
  const badId = plan(['*buddy*', 'ls', 'abc']);
  assert.equal(badId.action, 'error');
  assert.match(badId.message, /Invalid ID/);
  assert.equal(plan(['ss']).action, 'none');
  assert.equal(plan([]).action, 'none');
});
