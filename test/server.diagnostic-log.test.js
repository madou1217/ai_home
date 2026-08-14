const test = require('node:test');
const assert = require('node:assert/strict');

const {
  appendAccountRetryFailureLog,
  buildAccountRetryFailureLogEntry
} = require('../lib/server/diagnostic-log');

test('account retry failure log preserves Code Assist protocol diagnostics', () => {
  const entry = buildAccountRetryFailureLogEntry({
    requestId: 'req-1',
    route: 'POST /v1/messages',
    provider: 'agy',
    account: { id: 'agy-1', email: 'agy@example.com', authType: 'oauth-personal' },
    attempt: 1,
    maxAttempts: 2,
    status: 400,
    requestedModel: 'claude-opus-4-6-thinking',
    effectiveModel: 'claude-opus-4-6-thinking',
    geminiCodeAssist: {
      publicModel: 'claude-opus-4-6-thinking',
      wireModel: 'claude-opus-4-6-thinking',
      clientProtocol: 'anthropic_messages',
      sourceClientProtocol: 'anthropic_messages',
      requestProtocol: 'anthropic_messages_direct',
      upstreamProtocol: 'gemini_code_assist_generate_content',
      requestAdapter: 'claude_to_agy',
      responseAdapter: 'agy_to_claude',
      protocolAdapterPath: 'anthropic_messages->gemini_code_assist_generate_content',
      providerProtocolPlan: { provider: 'agy', route: 'direct' },
      responsePolicy: { kind: 'anthropic_direct', output: 'anthropic_messages' },
      requestSummary: {
        toolDeclarationSchemaKey: 'parameters',
        toolDeclarationCount: 12,
        toolConfigMode: 'AUTO',
        allowedFunctionNames: ['JS']
      },
      responseToolCalls: [{ name: 'JS', emptyArgs: false }],
      responseFinishReasons: ['STOP'],
      streamToolDiagnostics: [{ name: 'JS', state: 'complete' }]
    }
  });

  assert.equal(entry.geminiCodeAssistClientProtocol, 'anthropic_messages');
  assert.equal(entry.geminiCodeAssistRequestProtocol, 'anthropic_messages_direct');
  assert.equal(entry.geminiCodeAssistUpstreamProtocol, 'gemini_code_assist_generate_content');
  assert.equal(entry.geminiCodeAssistRequestAdapter, 'claude_to_agy');
  assert.equal(entry.geminiCodeAssistResponseAdapter, 'agy_to_claude');
  assert.deepEqual(entry.geminiCodeAssistRequestSummary, {
    toolDeclarationSchemaKey: 'parameters',
    toolDeclarationCount: 12,
    toolConfigMode: 'AUTO',
    allowedFunctionNames: ['JS']
  });
  assert.deepEqual(entry.geminiCodeAssistResponseToolCalls, [{ name: 'JS', emptyArgs: false }]);
  assert.deepEqual(entry.geminiCodeAssistResponseFinishReasons, ['STOP']);
  assert.deepEqual(entry.geminiCodeAssistStreamToolDiagnostics, [{ name: 'JS', state: 'complete' }]);
});

test('safety rejection log emits a request-scoped low-sensitivity event', () => {
  let entry = null;
  appendAccountRetryFailureLog({
    options: { logRequests: true },
    appendProxyRequestLog: (value) => { entry = value; },
    requestId: 'req-safety-1',
    route: 'POST /v1/responses',
    provider: 'codex',
    account: {
      accountRef: 'acct-safe-1',
      email: 'private@example.com',
      authType: 'api-key'
    },
    attempt: 1,
    maxAttempts: 3,
    status: 403,
    requestedModel: 'gpt-5.6-sol',
    effectiveModel: 'gpt-5.6-sol',
    upstreamUrl: 'https://private-upstream.example/v1/responses',
    upstreamStatus: 500,
    upstreamHeaders: new Map([
      ['x-request-id', 'upstream-safety-123'],
      ['authorization', 'Bearer secret-token']
    ]),
    upstreamBody: JSON.stringify({
      error: {
        code: 'sensitive_words_detected',
        message: 'private rejected prompt excerpt'
      }
    }),
    upstreamError: new Error('private upstream error'),
    durationMs: 12,
    policy: {
      kind: 'safety_rejected',
      retryable: false,
      cooldownMs: 0,
      failureThreshold: 0,
      clientStatusCode: 403,
      failureReason: 'safety_rejected',
      detail: 'upstream_safety_rejected'
    }
  });

  assert.ok(entry);
  assert.equal(entry.kind, 'request_safety_rejected');
  assert.equal(entry.error, 'upstream_safety_rejected');
  assert.equal(entry.requestId, 'req-safety-1');
  assert.equal(entry.upstreamRequestId, 'upstream-safety-123');
  assert.equal(entry.provider, 'codex');
  assert.equal(entry.accountRef, 'acct-safe-1');
  assert.equal(entry.retryable, false);
  assert.equal(entry.cooldownMs, 0);
  assert.equal(entry.failureThreshold, 0);
  assert.equal(Object.hasOwn(entry, 'upstreamHeaders'), false);
  assert.equal(Object.hasOwn(entry, 'upstreamBody'), false);
  assert.equal(Object.hasOwn(entry, 'upstreamError'), false);
  assert.equal(Object.hasOwn(entry, 'upstreamUrl'), false);
  assert.equal(Object.hasOwn(entry, 'accountEmail'), false);
  assert.equal(JSON.stringify(entry).includes('private'), false);
  assert.equal(JSON.stringify(entry).includes('secret-token'), false);
});
