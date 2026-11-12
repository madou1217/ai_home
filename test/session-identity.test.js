'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildContinuationArgs,
  createSessionIdentity,
  extractOscTitles,
  extractResumeSessionId,
  formatSessionLabel,
  hasContinuationIntent,
  listResumeFlags,
  normalizeSessionTitle,
  parseProbeOutput,
  planAccountSwitch,
  resolveSessionIdentityAsync,
  stripContinuationArgs
} = require('../lib/cli/services/pty/session-identity');

test('formatSessionLabel always yields a session frame', () => {
  assert.equal(formatSessionLabel({ title: '修复登录', project: 'ai_home', sessionId: 'abc' }), '修复登录');
  assert.equal(formatSessionLabel({ title: '', named: 'deploy-fix', project: 'ai_home' }), 'deploy-fix');
  assert.equal(
    formatSessionLabel({ project: 'ai_home', sessionId: '01a19fb6-48ac-7ee1-9e88-7428b4b0a1f3' }),
    'ai_home · #01a19f'
  );
  assert.equal(formatSessionLabel({ project: 'ai_home' }), 'ai_home');
  assert.equal(formatSessionLabel({ sessionId: 'sess_9f' }), '#sess9f');
  assert.equal(formatSessionLabel({}), '');
});

test('normalizeSessionTitle unwraps slash-command envelopes', () => {
  assert.equal(
    normalizeSessionTitle('<command-name>/goal</command-name><command-args>给 agy 加自动换号</command-args>'),
    '给 agy 加自动换号'
  );
  assert.equal(normalizeSessionTitle('\u001b]0;x\u0007hello\n\nworld  '), 'hello world');
  assert.equal(normalizeSessionTitle('Caveat: 这是系统提示'), '');
  assert.equal(normalizeSessionTitle('<command-name>/clear</command-name>'), '');
  assert.equal(normalizeSessionTitle('   '), '');
  assert.equal(normalizeSessionTitle('x'.repeat(200)).length, 60);
});

test('extractResumeSessionId reads the native flag of each provider family', () => {
  assert.equal(extractResumeSessionId('codex', ['resume', 'thread-1']), 'thread-1');
  assert.equal(extractResumeSessionId('codex', ['--model', 'gpt-5']), '');
  assert.equal(extractResumeSessionId('claude', ['--resume', 'sess-1', '--model', 'opus']), 'sess-1');
  assert.equal(extractResumeSessionId('codebuddy', ['--resume=sess-2']), 'sess-2');
  assert.equal(extractResumeSessionId('codebuddycn', ['-r', 'sess-3']), 'sess-3');
  assert.equal(extractResumeSessionId('agy', ['--conversation', 'conv-4']), 'conv-4');
  assert.equal(extractResumeSessionId('claude', ['--continue']), '');
});

test('hasContinuationIntent detects every explicit continuation form', () => {
  assert.equal(hasContinuationIntent('claude', ['--continue']), true);
  assert.equal(hasContinuationIntent('claude', ['--resume', 'sess-1']), true);
  assert.equal(hasContinuationIntent('claude', ['--resume=sess-1']), true);
  assert.equal(hasContinuationIntent('codebuddy', ['-c']), true);
  assert.equal(hasContinuationIntent('codex', ['resume', 'thread-1']), true);
  assert.equal(hasContinuationIntent('codex', ['--model', 'gpt-5']), false);
  assert.equal(hasContinuationIntent('agy', ['--model', 'gemini-3']), false);
});

test('listResumeFlags covers long flags, short flags and latest-session entries', () => {
  const codebuddy = listResumeFlags('codebuddy');
  for (const flag of ['--resume', '--continue', '-r', '-c']) assert.ok(codebuddy.has(flag), flag);
  const codex = listResumeFlags('codex');
  assert.ok(codex.has('resume'));
  assert.equal(codex.has('--resume'), false);
});

test('stripContinuationArgs removes continuation identity and keeps real flags', () => {
  assert.deepEqual(
    stripContinuationArgs('claude', ['--resume', 'sess-1', '--model', 'opus']),
    ['--model', 'opus']
  );
  assert.deepEqual(
    stripContinuationArgs('codebuddy', ['--continue', '--fork-session', '--model', 'deepseek']),
    ['--fork-session', '--model', 'deepseek']
  );
  assert.deepEqual(
    stripContinuationArgs('codex', ['resume', 'thread-1', '--model', 'gpt-5']),
    ['--model', 'gpt-5']
  );
  assert.deepEqual(stripContinuationArgs('agy', ['--model', 'x']), ['--model', 'x']);
});

test('buildContinuationArgs prefers the exact native entry', () => {
  assert.deepEqual(buildContinuationArgs('codebuddy', 'sess-1'), {
    ok: true, exact: true, sessionId: 'sess-1', args: ['--resume', 'sess-1']
  });
  assert.deepEqual(buildContinuationArgs('codebuddycn', 'sess-1').args, ['--resume', 'sess-1']);
  assert.deepEqual(buildContinuationArgs('agy', 'conv-1').args, ['--conversation', 'conv-1']);
  assert.deepEqual(buildContinuationArgs('claude', 'sess-1').args, ['--resume', 'sess-1']);
});

test('buildContinuationArgs falls back to the latest-session entry without identity', () => {
  const plan = buildContinuationArgs('codebuddy', '');
  assert.equal(plan.ok, true);
  assert.equal(plan.exact, false);
  assert.deepEqual(plan.args, ['--continue']);
});

test('buildContinuationArgs refuses providers without a CLI resume entry', () => {
  const plan = buildContinuationArgs('kimi', 'sess-1');
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'resume_in_tui_only');
  assert.ok(plan.message.length > 0);
});

test('planAccountSwitch keeps an explicit continuation untouched', () => {
  const plan = planAccountSwitch({
    provider: 'codebuddy',
    forwardArgs: ['--continue', '--model', 'deepseek'],
    sessionId: 'sess-1',
    hasRunningPty: true
  });
  assert.equal(plan.keepExplicit, true);
  assert.deepEqual(plan.args, ['--continue', '--model', 'deepseek']);
  assert.equal(plan.continuation, null);
});

test('planAccountSwitch prepends the resolved identity', () => {
  const plan = planAccountSwitch({
    provider: 'codebuddy',
    forwardArgs: ['--model', 'deepseek'],
    sessionId: 'sess-9',
    hasRunningPty: true
  });
  assert.equal(plan.keepExplicit, false);
  assert.deepEqual(plan.args, ['--resume', 'sess-9', '--model', 'deepseek']);
  assert.equal(plan.continuation.exact, true);
});

test('planAccountSwitch falls back to the latest-session entry without identity', () => {
  const plan = planAccountSwitch({
    provider: 'agy',
    forwardArgs: ['--model', 'gemini-3'],
    sessionId: '',
    hasRunningPty: true
  });
  assert.deepEqual(plan.args, ['--continue', '--model', 'gemini-3']);
  assert.equal(plan.continuation.exact, false);
});

test('planAccountSwitch never guesses a conversation without a running pty', () => {
  const plan = planAccountSwitch({
    provider: 'codebuddy',
    forwardArgs: ['--model', 'deepseek'],
    sessionId: 'sess-1',
    hasRunningPty: false
  });
  assert.equal(plan.keepExplicit, false);
  assert.equal(plan.continuation, null);
  assert.deepEqual(plan.args, ['--model', 'deepseek']);
});

test('planAccountSwitch reports providers that cannot resume', () => {
  const plan = planAccountSwitch({
    provider: 'kimi',
    forwardArgs: ['--model', 'kimi-k2'],
    sessionId: 'sess-1',
    hasRunningPty: true
  });
  assert.equal(plan.continuation.ok, false);
  assert.deepEqual(plan.args, ['--model', 'kimi-k2']);
});

test('session identity prefers what we already know over a store probe', () => {
  const identity = createSessionIdentity({
    provider: 'codebuddy',
    cwd: '/tmp/project-x/',
    startedAt: 1000,
    now: () => 2000,
    getForwardArgs: () => ['--resume', 'from-args'],
    getRegistrySessionId: () => 'from-registry',
    getCorrelationSessionId: () => 'from-hook'
  });
  assert.equal(identity.peekSessionId(), 'from-args');
  assert.equal(identity.projectLabel(), 'project-x');
  identity.setKnownSessionId('after-switch', '会话标题');
  assert.equal(identity.peekSessionId(), 'after-switch');
  assert.equal(identity.label(), '会话标题');
  assert.deepEqual(identity.current(), { sessionId: 'after-switch', title: '会话标题', source: 'cache' });
});

test('extractOscTitles reads the CLI terminal title and drops status markers', () => {
  assert.deepEqual(extractOscTitles('\x1b]0;✳ 要求只回复 PINEAPPLE\x07'), ['要求只回复 PINEAPPLE']);
  assert.deepEqual(extractOscTitles('\x1b]2;⠂ 修登录\x1b\\'), ['修登录']);
  assert.deepEqual(extractOscTitles('\x1b]0;✳ Thinking…\x07'), []);
  assert.deepEqual(extractOscTitles('no title here'), []);
  assert.deepEqual(extractOscTitles('\x1b]0;未闭合'), []);
});

test('the observed CLI title wins over the store title', () => {
  const identity = createSessionIdentity({ provider: 'codebuddy', cwd: '/Users/me/proj-x' });
  identity.setKnownSessionId('sess-1', '首条消息');
  assert.equal(identity.label(), '首条消息');
  assert.equal(identity.setObservedTitle('✳ 现在在聊换号'), true);
  assert.equal(identity.label(), '现在在聊换号');
  assert.equal(identity.setObservedTitle('✳ 现在在聊换号'), false);
  assert.equal(identity.setObservedTitle('✳ 未命名会话'), false);
});

test('a project-derived provider title is treated as noise', () => {
  const identity = createSessionIdentity({ provider: 'codebuddy', cwd: '/Users/me/proj-x' });
  identity.setKnownSessionId('sess-1', 'Users-me-proj-x');
  assert.equal(identity.label(), '');
  identity.setKnownSessionId('sess-1', '修复登录');
  assert.equal(identity.label(), '修复登录');
});

test('session identity falls back to registry, hook and cache in order', () => {
  const registryFirst = createSessionIdentity({
    provider: 'agy', cwd: '/tmp/p', getRegistrySessionId: () => 'from-registry', getCorrelationSessionId: () => 'from-hook'
  });
  assert.equal(registryFirst.peekSessionId(), 'from-registry');
  const hookFirst = createSessionIdentity({
    provider: 'agy', cwd: '/tmp/p', getCorrelationSessionId: () => 'from-hook'
  });
  assert.equal(hookFirst.peekSessionId(), 'from-hook');
  assert.equal(createSessionIdentity({ provider: 'agy', cwd: '/tmp/p' }).peekSessionId(), '');
});

test('session identity caches the probed title and honours the refresh interval', async () => {
  let calls = 0;
  let now = 5000;
  const identity = createSessionIdentity({
    provider: 'codebuddy',
    cwd: '/tmp/project-x',
    startedAt: 1000,
    now: () => now,
    execFile: (file, args, options, callback) => {
      calls += 1;
      callback(null, JSON.stringify({ sessionId: 'sess-9', title: '真需求' }));
    }
  });
  const first = await identity.resolve();
  assert.equal(first.sessionId, 'sess-9');
  assert.equal(identity.label(), '真需求');
  await identity.resolve({ minIntervalMs: 60000 });
  assert.equal(calls, 1);
  now += 61000;
  await identity.resolve({ minIntervalMs: 60000 });
  assert.equal(calls, 2);
});

test('resolveSessionIdentityAsync runs the probe in a child process', async () => {
  let captured = null;
  const result = await resolveSessionIdentityAsync({
    provider: 'codebuddy',
    cwd: '/tmp/project-x',
    execFile: (file, args, options, callback) => {
      captured = { file, args, options };
      callback(null, JSON.stringify({
        sessionId: 'sess-1',
        title: '<command-name>/goal</command-name><command-args>真正的需求</command-args>'
      }));
    }
  });
  assert.equal(result.sessionId, 'sess-1');
  assert.equal(result.title, '真正的需求');
  assert.equal(captured.args[0], '-e');
  assert.ok(captured.args[1].includes('resolveAgentSessionIds'));
  const payload = JSON.parse(captured.args[2]);
  assert.equal(payload.provider, 'codebuddy');
  assert.equal(payload.cwd, '/tmp/project-x');
  assert.ok(payload.resolverPath.includes('session-title-resolver'));
});

test('parseProbeOutput tolerates junk and empty output', () => {
  assert.equal(parseProbeOutput(''), null);
  assert.equal(parseProbeOutput('not json'), null);
  assert.deepEqual(parseProbeOutput('{"sessionId":" a ","title":"  "}'), {
    sessionId: 'a', title: '', source: 'store'
  });
});
