'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RESUME_STRATEGIES,
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
const { listProviderIds } = require('../lib/provider-catalog');

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
      // 统一 `aih <cli> resume` 动词用的是同一批事实：它下发的每个参数也必须在合同里声明过，
      // 否则「aih 帮你续接」会变成替用户认一个原生客户端并不支持的参数。
      const verbFlags = new Set();
      const collect = (value) => {
        if (typeof value === 'string' && value.startsWith('-')) verbFlags.add(value);
      };
      (strategy.interactive.latestArgs || []).forEach(collect);
      collect(strategy.interactive.idArgs('probe-id')[0]);
      for (const flag of verbFlags) {
        assert.ok(declared.includes(flag), `${provider}: resume 动词用到的 ${flag} 未在合同声明（${declared.join(',')}）`);
      }
      // 子命令形态（codex 的 `resume`）也必须出现在合同里。
      if (!String(strategy.interactive.idArgs('probe-id')[0]).startsWith('-')) {
        const sub = String(strategy.interactive.idArgs('probe-id')[0]);
        assert.ok(declared.includes(sub), `${provider}: 子命令 ${sub} 未在合同声明`);
      }
    }
  }
});

test('every resume strategy is covered by the contract and by an explicit no-strategy list', () => {
  // 合同声明了 sessions 的 provider：要么有策略，要么在「无非交互 resume 标准」名单里。
  const withStrategy = new Set(listResumeStrategies().flatMap((strategy) => strategy.providers));
  const declared = [];
  for (const provider of listProviderIds()) {
    const flags = getDeclaredResumeFlags(provider);
    if (Array.isArray(flags)) declared.push(provider);
  }
  for (const provider of declared) {
    const covered = withStrategy.has(provider) || RESUME_STRATEGYLESS_PROVIDERS.includes(provider);
    assert.ok(covered, `${provider} declares sessions but has neither a strategy nor an explicit reason`);
  }
  // 反向：有策略的 provider 必须在合同里声明（不许静默加策略）。
  for (const strategy of RESUME_STRATEGIES) {
    for (const provider of strategy.providers) {
      assert.ok(Array.isArray(getDeclaredResumeFlags(provider)), `${provider} has a strategy but no contract declaration`);
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
  for (const provider of ['kiro', 'kimi', 'zcode', 'unknown']) {
    assert.deepEqual(buildProviderResumeArgs(provider, { nativeSessionId: 'whatever' }), [], provider);
    assert.equal(resolveProviderResumeStrategy(provider), null);
    assert.equal(resolveResumeIdentityKey(provider, { nativeSessionId: 'whatever' }), '');
  }
});

test('qoder 家族按 CLI 事实续接（--resume <id> / 无身份时 --continue）', () => {
  for (const provider of ['qoder', 'qodercn']) {
    assert.equal(resolveProviderResumeStrategy(provider).id, 'qoder-session');
    assert.deepEqual(buildProviderResumeArgs(provider, { nativeSessionId: 'sid-1' }), ['--resume', 'sid-1']);
    assert.deepEqual(
      buildProviderResumeArgs(provider, {}),
      ['--continue'],
      `${provider}: 没有身份时用同 cwd 的 --continue（安全近似），不是普通重启`
    );
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
