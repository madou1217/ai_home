const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
