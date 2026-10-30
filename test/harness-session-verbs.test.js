'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { rewriteHarnessNativeVerb } = require('../lib/harness/session-verbs');
const { parseExternalHarnessArgs } = require('../lib/cli/commands/ai-cli/router');
const { getExternalHarness } = require('../lib/harness/catalog');

const SESSION_ID = '01a18c27-6bb1-72c4-b1d0-44918b5bcd2d';

test('aih pi resume <id> → pi --session <id>（不再是首条消息）', () => {
  const result = rewriteHarnessNativeVerb('pi', ['pi', 'resume', SESSION_ID]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.args, ['pi', '--session', SESSION_ID]);

  // 改写后的 argv 必须让 harness 参数解析器把它当成原生参数，而不是账号/模型。
  const parsed = parseExternalHarnessArgs('pi', result.args);
  assert.deepEqual(parsed.nativeArgs, ['--session', SESSION_ID]);
  assert.equal(parsed.accountRef, '');
  assert.equal(parsed.model, '');
});

test('aih pi resume（无 id）→ pi --continue（最近一段）', () => {
  const result = rewriteHarnessNativeVerb('pi', ['pi', 'resume']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.args, ['pi', '--continue']);
});

test('aih pi <账号> resume <id>：账号 token 原样保留', () => {
  const result = rewriteHarnessNativeVerb('pi', ['pi', 'acct_0123456789abcdef0123', 'resume', SESSION_ID]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.args, ['pi', 'acct_0123456789abcdef0123', '--session', SESSION_ID]);
  const parsed = parseExternalHarnessArgs('pi', result.args);
  assert.equal(parsed.accountRef, 'acct_0123456789abcdef0123');
  assert.deepEqual(parsed.nativeArgs, ['--session', SESSION_ID]);
});

test('aih pi resume <id> 的额外原生参数跟在后面', () => {
  const result = rewriteHarnessNativeVerb('pi', ['pi', 'resume', SESSION_ID, '--model', 'x']);
  assert.deepEqual(result.args, ['pi', '--session', SESSION_ID, '--model', 'x']);
});

test('aih pi fork <id> → pi --fork <id>；无 id 明确拒绝（pi 没有 fork picker）', () => {
  const withId = rewriteHarnessNativeVerb('pi', ['pi', 'fork', SESSION_ID]);
  assert.equal(withId.ok, true);
  assert.deepEqual(withId.args, ['pi', '--fork', SESSION_ID]);

  const withoutId = rewriteHarnessNativeVerb('pi', ['pi', 'fork']);
  assert.equal(withoutId.ok, false);
  assert.equal(withoutId.reason, 'resume_identity_required');
});

test('aih pi resume --help 打印统一动词用法（退出码 0 的路径）', () => {
  const result = rewriteHarnessNativeVerb('pi', ['pi', 'resume', '--help']);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'verb_help');
  assert.match(result.message, /aih <harness> resume/);
});

test('dsh 声明「已核实不可用」：明确拒绝并说明会话在 Web UI 里（不猜参数）', () => {
  // dsh 0.2.1-rc.5 实测：aih 的 aih profile 是 web app，`dsh web --session-id` 直接报
  // unknown option；只有 headless profile 才有 --session-id。所以这里必须是「不可用」，
  // 而不是把 --session-id 硬塞给 web app。
  for (const verb of ['resume', 'fork']) {
    const result = rewriteHarnessNativeVerb('dsh', ['dsh', verb, SESSION_ID]);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'harness_session_verb_unavailable');
    assert.match(result.message, /headless/);
    assert.match(result.message, /Web UI/);
  }
  assert.equal(getExternalHarness('dsh').sessions.resume, null);
  assert.equal(getExternalHarness('dsh').sessions.fork, null);
});

test('未声明 sessions 的 harness（dsh-tui）明确拒绝，不猜参数', () => {
  const result = rewriteHarnessNativeVerb('dsh-tui', ['dsh-tui', 'resume', SESSION_ID]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'harness_sessions_undeclared');
  assert.match(result.message, /未声明/);
});

test('非动词参数照原样透传（返回 null）', () => {
  assert.equal(rewriteHarnessNativeVerb('pi', ['pi', '--model', 'x']), null);
  assert.equal(rewriteHarnessNativeVerb('pi', ['pi']), null);
  // 会话身份里带空白/控制字符一律拒绝，绝不拼出会打到别的会话的参数。
  const invalid = rewriteHarnessNativeVerb('pi', ['pi', 'resume', 'a b']);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'resume_identity_invalid');
});

test('catalog 里 pi 声明的原生形态与 pi --help 一致', () => {
  const sessions = getExternalHarness('pi').sessions;
  assert.deepEqual(sessions.resume, { idArgs: ['--session'], latestArgs: ['--continue'] });
  assert.deepEqual(sessions.fork, { idArgs: ['--fork'], latestArgs: [] });
});
