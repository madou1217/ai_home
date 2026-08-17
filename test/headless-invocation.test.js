'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  DISABLE_ENV_KEY,
  detectHeadlessInvocation
} = require('../lib/cli/services/pty/headless-invocation');

function detect(provider, args, options = {}) {
  return detectHeadlessInvocation(provider, args, { env: {}, ...options });
}

test('claude 的 -p/--print 各种写法都判为 headless', () => {
  for (const args of [['-p', 'hi'], ['--print', 'hi'], ['--print=hi'], ['--model', 'x', '-p', 'hi']]) {
    assert.equal(detect('claude', args).headless, true, JSON.stringify(args));
  }
});

test('交互调用不判为 headless', () => {
  assert.equal(detect('claude', []).headless, false);
  assert.equal(detect('claude', ['--resume', 'abc']).headless, false);
  assert.equal(detect('codex', ['resume', '--last']).headless, false);
});

test('位置参数子命令只认第一个位置参数', () => {
  assert.equal(detect('codex', ['exec', '写一行']).headless, true);
  assert.equal(detect('opencode', ['run', 'hi']).headless, true);
  // "exec" 只是提示词内容时不能误判
  assert.equal(detect('codex', ['resume', 'exec']).headless, false);
});

test('provider 覆盖面来自生成的合同表', () => {
  assert.equal(detect('agy', ['--print', 'hi']).headless, true);
  assert.equal(detect('grok', ['--single', 'hi']).headless, true);
  assert.equal(detect('qoder', ['--print', 'hi']).headless, true);
  assert.equal(detect('qodercn', ['--print', 'hi']).headless, true);
});

test('gemini 没有 headless 入口', () => {
  const result = detect('gemini', ['-p', 'hi']);
  assert.equal(result.headless, false);
  assert.equal(result.reason, 'provider_has_no_headless_mode');
});

test('stream-json 输入才要求接通 stdin', () => {
  assert.equal(detect('claude', ['-p', 'hi']).wantsStdin, false);
  assert.equal(detect('claude', ['-p', '--input-format', 'stream-json']).wantsStdin, true);
  assert.equal(detect('claude', ['--input-format=stream-json', '-p']).wantsStdin, true);
  assert.equal(detect('claude', ['-p', '--input-format', 'text']).wantsStdin, false);
});

test('login 流程与 env 开关可以关掉 headless', () => {
  assert.equal(detect('claude', ['-p', 'hi'], { isLogin: true }).reason, 'login_flow');
  assert.equal(
    detect('claude', ['-p', 'hi'], { env: { [DISABLE_ENV_KEY]: '0' } }).reason,
    'disabled_by_env'
  );
});

test('未知 provider 与空参数安全回退', () => {
  assert.equal(detect('nope', ['-p']).headless, false);
  assert.equal(detect('claude', null).headless, false);
  assert.equal(detect('', ['-p']).headless, false);
});
