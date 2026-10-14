'use strict';

// 尝试注解通道（lib/server/attempt-annotations.js）的契约测试。
//
// 它要守住的不变量：**新增一个诊断注解，只要产生方记一次，所有代理请求日志出口自动带上**，
// 不需要回到每个 appendProxyRequestLog 调用点补字段。历史缺陷：codebuddyFamilyInjectedSystemPrompt
// 只在 attempt 上记录、从未进过任何日志行（调用点手写字段表，漏补即丢失）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  annotateAttempt,
  attemptAnnotations,
  withAnnotations,
  withAttemptAnnotations
} = require('../lib/server/attempt-annotations');
const {
  buildAccountRetryFailureLogEntry,
  buildRequestSafetyRejectedLogEntry
} = require('../lib/server/diagnostic-log');

test('annotateAttempt records namespaced annotations on the attempt bag', () => {
  const attempt = {};
  assert.equal(annotateAttempt(attempt, 'codebuddyFamilyToolChoicePin', 'get_weather'), attempt);
  annotateAttempt(attempt, 'codebuddyFamilyToolChoiceNormalized', true);
  assert.deepEqual(attempt.annotations, {
    codebuddyFamilyToolChoicePin: 'get_weather',
    codebuddyFamilyToolChoiceNormalized: true
  });
});

test('annotateAttempt ignores values that mean "nothing happened"', () => {
  const attempt = {};
  annotateAttempt(attempt, 'a', undefined);
  annotateAttempt(attempt, 'b', null);
  annotateAttempt(attempt, 'c', false);
  annotateAttempt(attempt, 'd', '');
  annotateAttempt(attempt, '', 'x');
  annotateAttempt(null, 'e', 'x');
  assert.equal(Object.hasOwn(attempt, 'annotations'), false);
  // 0 是有效值（例如「收窄到 0 个工具」这类计数），不能被当成空值丢掉。
  annotateAttempt(attempt, 'codebuddyFamilyCount', 0);
  assert.deepEqual(attempt.annotations, { codebuddyFamilyCount: 0 });
});

test('annotateAttempt refuses to overwrite the log entry identity fields', () => {
  const attempt = {};
  for (const key of ['status', 'accountRef', 'route', 'provider', 'kind', 'durationMs']) {
    annotateAttempt(attempt, key, 'hijacked');
  }
  assert.equal(Object.hasOwn(attempt, 'annotations'), false);
});

test('withAttemptAnnotations merges the bag without mutating the entry', () => {
  const entry = { kind: 'account_retry_failure', status: 502 };
  const attempt = {};
  annotateAttempt(attempt, 'codebuddyFamilyToolChoice', 'required');
  const merged = withAttemptAnnotations(entry, attempt);
  assert.deepEqual(merged, { kind: 'account_retry_failure', status: 502, codebuddyFamilyToolChoice: 'required' });
  assert.deepEqual(entry, { kind: 'account_retry_failure', status: 502 });
  // 身份字段不可被注解顶掉，即使有人绕过 annotateAttempt 直接写袋子。
  const hijack = withAttemptAnnotations(entry, { annotations: { status: 500, codebuddyFamilyX: 1 } });
  assert.equal(hijack.status, 502);
  assert.equal(hijack.codebuddyFamilyX, 1);
});

test('withAttemptAnnotations is a no-op without annotations', () => {
  const entry = { kind: 'account_retry_failure' };
  assert.equal(withAttemptAnnotations(entry, {}), entry);
  assert.equal(withAttemptAnnotations(entry, { annotations: {} }), entry);
  assert.equal(withAttemptAnnotations(entry, { annotations: [1, 2] }), entry);
  assert.equal(withAttemptAnnotations(entry, null), entry);
  assert.equal(attemptAnnotations({}), null);
  assert.equal(attemptAnnotations({ annotations: {} }), null);
});

test('withAnnotations merges a plain annotation object (non-attempt log exits)', () => {
  const entry = { kind: 'account_retry_failure' };
  assert.equal(withAnnotations(entry, { codebuddyFamilyToolChoice: 'required' }).codebuddyFamilyToolChoice, 'required');
  assert.equal(withAnnotations(entry, null), entry);
  assert.equal(withAnnotations(entry, {}), entry);
  assert.equal(Object.hasOwn(withAnnotations(entry, { status: 500 }), 'status'), false);
});

test('account retry failure log entries carry the attempt annotations', () => {
  const entry = buildAccountRetryFailureLogEntry({
    requestId: 'req-1',
    route: '/v1/chat/completions',
    provider: 'codebuddy',
    account: { accountRef: 'acc-1' },
    policy: { kind: 'upstream_error', failureReason: 'upstream_error' },
    annotations: { codebuddyFamilyToolChoice: 'required', codebuddyFamilyToolChoicePin: 'get_weather' }
  });
  assert.equal(entry.kind, 'account_retry_failure');
  assert.equal(entry.codebuddyFamilyToolChoice, 'required');
  assert.equal(entry.codebuddyFamilyToolChoicePin, 'get_weather');
});

test('safety rejected log entries keep their explicit allowlist', () => {
  // 该路径刻意保留 allowlist：注解不得把任意字段带进安全拒绝日志。
  const entry = buildRequestSafetyRejectedLogEntry({
    requestId: 'req-2',
    policy: { kind: 'safety_rejected' },
    annotations: { codebuddyFamilyToolChoice: 'required' }
  });
  assert.equal(entry.kind, 'request_safety_rejected');
  assert.equal(Object.hasOwn(entry, 'codebuddyFamilyToolChoice'), false);
});

test('the general transport logs only through the annotation funnel', () => {
  // 结构守卫：本文件只允许一个 appendProxyRequestLog 调用点，且它必须经过 withAttemptAnnotations。
  // 未来若新增日志分支而绕开漏斗，这个断言会失败——「新增注解自动进日志」就不会被悄悄破坏。
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'server', 'upstream-endpoints-transport-general.js'),
    'utf8'
  );
  const callSites = source.match(/appendProxyRequestLog\(/g) || [];
  assert.equal(callSites.length, 1);
  assert.match(source, /appendProxyRequestLog\(withAttemptAnnotations\(entry, attemptMutable\)\)/);
  assert.match(source, /annotations: attemptAnnotations\(attemptMutable\)/);
});
