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

// 结构守卫的发现范围：**凡是持有 attempt 袋子（attemptMutable）的模块**，其代理请求日志出口
// 必须全部经过注解漏斗，失败诊断出口必须带上同一个注解袋子。名单不写死——新增一个 attempt 级
// transport 时它自动进入守卫范围，绕开漏斗会立刻失败，而不是等线上发现注解丢了。
// 历史缺陷：5 个 attempt 级文件各自手写日志字段表（geminiDiagnosticLogFields() 被手工展开 6 次），
// 「新增注解自动进日志」只在 general transport 成立。
function readAttemptScopedModules() {
  const serverDir = path.join(__dirname, '..', 'lib', 'server');
  return fs.readdirSync(serverDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, source: fs.readFileSync(path.join(serverDir, name), 'utf8') }))
    .filter((file) => /attemptMutable/.test(file.source));
}

// 漏斗必须同时满足三件事：①唯一的 appendProxyRequestLog 直调在它体内；
// ②门控用 `if (!options.logRequests) return;`（而非各出口手写 gate）；③注解袋子并入条目。
// 出口可以把自己知道的字段放进 entry（也可以像 code-assist 那样由漏斗统一注入 provider 字段表）。
const ANNOTATION_FUNNEL = /const logRequest = \(entry\) => \{([\s\S]*?)\n\s*\};/;
// 两种合法形态：直接传 entry，或先把 provider 字段表展开再传（`{ ...providerFields(), ...entry }`）。
const ANNOTATION_FUNNEL_CALL = /appendProxyRequestLog\(withAttemptAnnotations\((?:entry|\{[^{}]*\.\.\.entry[^{}]*\}), attemptMutable\)\);/;

test('every attempt-scoped module routes its proxy log exits through the annotation funnel', () => {
  const modules = readAttemptScopedModules();
  // 下限守卫：改名/搬移若让发现逻辑失效，宁可这里报错，也不要静默通过一个空集合。
  assert.ok(modules.length >= 5, `attempt-scoped discovery is broken (found ${modules.length} modules)`);

  for (const { name, source } of modules) {
    const directCallSites = source.match(/appendProxyRequestLog\(/g) || [];
    if (directCallSites.length) {
      // 只允许漏斗里那一次直调：任何新增日志分支都必须走 logRequest(...)。
      assert.equal(
        directCallSites.length,
        1,
        `${name}: proxy log exits must funnel through logRequest(entry), found ${directCallSites.length} appendProxyRequestLog calls`
      );
      const funnel = source.match(ANNOTATION_FUNNEL);
      assert.ok(funnel, `${name}: missing the logRequest annotation funnel`);
      assert.equal(
        (funnel[1].match(/appendProxyRequestLog\(/g) || []).length,
        1,
        `${name}: the single appendProxyRequestLog call must live inside the logRequest funnel`
      );
      assert.match(funnel[1], /if \(!options\.logRequests\) return;/, `${name}: the funnel must own the logRequests gate`);
      assert.match(funnel[1], ANNOTATION_FUNNEL_CALL, `${name}: the funnel must merge withAttemptAnnotations(entry, attemptMutable)`);
    }
    // 失败诊断是另一条出口（走 appendUpstreamFailureDiagnosticLog 的字段表），
    // 必须显式并入同一个注解袋子，否则重试失败/耗尽路径仍然丢注解。
    if (/appendUpstreamFailureDiagnosticLog\(/.test(source)) {
      assert.match(
        source,
        /annotations: attemptAnnotations\(attemptMutable\)/,
        `${name}: failure diagnostics must carry attemptAnnotations(attemptMutable)`
      );
    }
    // 手写门控是绕过漏斗的标志写法（漏斗自身用的是 `if (!options.logRequests) return;`）。
    assert.equal(
      /if \(options\.logRequests\)/.test(source),
      false,
      `${name}: hand-rolled "if (options.logRequests)" log gates are not allowed`
    );
    // 用了助手却没导入，是运行时 ReferenceError（只在真实请求上炸，测试不一定覆盖）——
    // 本守卫历史上真的抓到了 upstream-endpoints-attempt.js 漏 import attemptAnnotations。
    const requireMatch = source.match(/const \{([^}]*)\} = require\('\.\/attempt-annotations'\);/);
    const importedHelpers = requireMatch
      ? requireMatch[1].split(',').map((entry) => entry.trim()).filter(Boolean)
      : [];
    for (const helper of ['annotateAttempt', 'attemptAnnotations', 'withAnnotations', 'withAttemptAnnotations']) {
      if (new RegExp(`\\b${helper}\\(`).test(source)) {
        assert.ok(
          importedHelpers.includes(helper),
          `${name}: uses ${helper}() but does not import it from ./attempt-annotations`
        );
      }
    }
  }
});
