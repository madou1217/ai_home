'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RESUME_STRATEGIES,
  RESUME_STRATEGIES_PENDING_CONTRACT,
  RESUME_STRATEGYLESS_PROVIDERS,
  listResumeStrategies,
  resolveProviderResumeStrategy,
  providerRequiresExactResumeIdentity,
  providerDeduplicatesResumeIdentity,
  resolveResumeIdentityLabel,
  resolveResumeIdentityKey,
  buildProviderResumeArgs,
  getDeclaredResumeFlags
} = require('../lib/runtime/provider-resume');

const CODEX_THREAD_ID = '019f97d8-2007-7f90-8f8b-d627bd6b0327';
const CLINE_SESSION_ID = '1792050248852_or8f0';

test('every contract-declared resume strategy only uses flags the contract declares', () => {
  for (const strategy of RESUME_STRATEGIES) {
    assert.equal(strategy.contractDeclared, true, `${strategy.id} is declared in the contract`);
    for (const provider of strategy.providers) {
      const declared = getDeclaredResumeFlags(provider);
      assert.ok(Array.isArray(declared), `${provider} must declare nativeBoundary.sessions.flags`);
      for (const flag of strategy.declaredFlags) {
        assert.ok(declared.includes(flag), `${provider}: ${flag} missing from the contract (${declared.join(',')})`);
      }
    }
  }
});

test('strategies pending contract coverage say so explicitly', () => {
  for (const strategy of RESUME_STRATEGIES_PENDING_CONTRACT) {
    assert.equal(strategy.contractDeclared, false);
    for (const provider of strategy.providers) {
      assert.equal(getDeclaredResumeFlags(provider), null, `${provider} must not declare sessions yet`);
    }
  }
});

test('providers that declare sessions but have no non-interactive resume are listed explicitly', () => {
  const withStrategy = new Set(listResumeStrategies().flatMap((strategy) => strategy.providers));
  for (const provider of RESUME_STRATEGYLESS_PROVIDERS) {
    assert.equal(withStrategy.has(provider), false, `${provider} must not gain a strategy silently`);
    assert.ok(Array.isArray(getDeclaredResumeFlags(provider)), `${provider} declares sessions in the contract`);
  }
});

test('cline resumes the exact bound session id and stays honest without one', () => {
  assert.deepEqual(buildProviderResumeArgs('cline', { nativeSessionId: CLINE_SESSION_ID }), ['--id', CLINE_SESSION_ID]);
  // 恢复过的 pane 把身份记在 forwardArgs 里 → 跨重启一路带下去。
  assert.deepEqual(
    buildProviderResumeArgs('cline', { forwardArgs: ['-P', 'cline-pass', '--id', CLINE_SESSION_ID] }),
    ['--id', CLINE_SESSION_ID]
  );
  assert.deepEqual(buildProviderResumeArgs('cline', {}), []);
  assert.deepEqual(buildProviderResumeArgs('cline', { nativeSessionId: 'not-a-session-id' }), []);
  assert.equal(resolveProviderResumeStrategy('CLINE').id, 'cline-session');
});

test('codex keeps its exact-identity rule and claude keeps the --continue fallback', () => {
  assert.deepEqual(buildProviderResumeArgs('codex', { nativeSessionId: CODEX_THREAD_ID }), ['resume', CODEX_THREAD_ID]);
  assert.deepEqual(buildProviderResumeArgs('codex', {}), []);
  assert.equal(providerRequiresExactResumeIdentity('codex'), true);
  assert.equal(resolveResumeIdentityKey('codex', { nativeSessionId: CODEX_THREAD_ID }), CODEX_THREAD_ID);
  assert.equal(resolveResumeIdentityKey('codex', {}), '');

  assert.deepEqual(buildProviderResumeArgs('claude', {}), ['--continue']);
  assert.deepEqual(buildProviderResumeArgs('claude', { nativeSessionId: 'sess-1' }), ['--resume', 'sess-1']);
  assert.equal(providerRequiresExactResumeIdentity('claude'), false);
});

test('gemini only resumes through a resolved session file path', () => {
  const entry = { nativeSessionId: 'gemini-session' };
  assert.deepEqual(buildProviderResumeArgs('gemini', entry), []);
  assert.deepEqual(
    buildProviderResumeArgs('gemini', entry, { resolveSessionFile: () => '/tmp/session-1.json' }),
    ['--session-file', '/tmp/session-1.json']
  );
  assert.deepEqual(
    buildProviderResumeArgs('gemini', entry, { resolveSessionFile: () => { throw new Error('boom'); } }),
    []
  );
});

test('bound-identity providers build their own native resume argv', () => {
  const id = 'session-42';
  assert.deepEqual(buildProviderResumeArgs('agy', { nativeSessionId: id }), ['--conversation', id]);
  assert.deepEqual(buildProviderResumeArgs('opencode', { nativeSessionId: id }), ['--session', id]);
  assert.deepEqual(buildProviderResumeArgs('grok', { nativeSessionId: id }), ['--resume', id]);
  assert.deepEqual(buildProviderResumeArgs('codebuddy', { nativeSessionId: id }), ['--resume', id]);
  assert.deepEqual(buildProviderResumeArgs('workbuddycn', { nativeSessionId: id }), ['--resume', id]);
  // 没有身份一律普通重启，绝不猜测。
  for (const provider of ['agy', 'opencode', 'grok', 'codebuddy']) {
    assert.deepEqual(buildProviderResumeArgs(provider, {}), [], provider);
  }
});

test('providers without a resume standard relaunch plainly', () => {
  for (const provider of ['kiro', 'kimi', 'zcode', 'qoder', 'unknown']) {
    assert.deepEqual(buildProviderResumeArgs(provider, { nativeSessionId: 'whatever' }), [], provider);
    assert.equal(resolveProviderResumeStrategy(provider), null);
    assert.equal(resolveResumeIdentityKey(provider, { nativeSessionId: 'whatever' }), '');
  }
});

test('cline dedupes its exact session identity without failing closed on absence', () => {
  assert.equal(providerRequiresExactResumeIdentity('cline'), false);
  assert.equal(providerDeduplicatesResumeIdentity('cline'), true);
  assert.equal(resolveResumeIdentityLabel('cline'), 'session');
  assert.equal(resolveResumeIdentityKey('cline', { nativeSessionId: CLINE_SESSION_ID }), CLINE_SESSION_ID);
  assert.equal(
    resolveResumeIdentityKey('cline', { forwardArgs: ['--id', CLINE_SESSION_ID] }),
    CLINE_SESSION_ID
  );
  assert.equal(resolveResumeIdentityKey('cline', {}), '');
  // codex 的历史用词不变（不可恢复原因字符串被测试与运维依赖）。
  assert.equal(resolveResumeIdentityLabel('codex'), 'thread');
});
