'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  adaptCodexInteractionRequest
} = require('../lib/server/chat-runtime/codex-interaction-request-adapter');
const {
  adaptCodexServerResponse
} = require('../lib/server/chat-runtime/codex-server-response-adapters');

test('opaque choice ids round-trip every authoritative command decision exactly', () => {
  const execpolicy = {
    acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] }
  };
  const network = {
    applyNetworkPolicyAmendment: {
      network_policy_amendment: { host: 'example.com', action: 'allow' }
    }
  };
  const decisions = ['accept', 'acceptForSession', 'decline', 'cancel', execpolicy, network];
  const pending = interaction('item/commandExecution/requestApproval', {
    itemId: 'command-1', command: 'git status', availableDecisions: decisions
  });

  decisions.forEach((decision, index) => {
    assert.deepEqual(
      adaptCodexServerResponse(pending, { choiceId: `choice-${index}` }),
      { decision }
    );
  });
});

test('file, permissions and tool answers use independent native response contracts', () => {
  const file = interaction('item/fileChange/requestApproval', { itemId: 'file-1' });
  const permissions = interaction('item/permissions/requestApproval', {
    itemId: 'permissions-1',
    permissions: { network: { enabled: true } }
  });
  const tool = interaction('item/tool/requestUserInput', {
    itemId: 'question-1',
    questions: [{
      id: 'target', question: 'Target?', isOther: false, isSecret: false,
      options: [
        { label: 'web', description: 'Browser' },
        { label: 'desktop', description: 'Native app' }
      ]
    }]
  });

  assert.deepEqual(adaptCodexServerResponse(file, { choiceId: 'choice-3' }), {
    decision: 'cancel'
  });
  assert.deepEqual(adaptCodexServerResponse(permissions, { choiceId: 'choice-2' }), {
    permissions: { network: { enabled: true } },
    scope: 'session'
  });
  assert.deepEqual(adaptCodexServerResponse(permissions, { choiceId: 'choice-3' }), {
    permissions: {},
    scope: 'turn'
  });
  assert.deepEqual(adaptCodexServerResponse(tool, {
    action: 'submit', answer: { target: ['web'] }
  }), { answers: { target: { answers: ['web'] } } });
  assert.throws(
    () => adaptCodexServerResponse(tool, { action: 'cancel' }),
    (error) => error.code === 'codex_question_action_unsupported'
  );
});

test('free-form tool answers preserve Codex user_note semantics', () => {
  const pending = interaction('item/tool/requestUserInput', {
    itemId: 'question-free-form',
    questions: [{
      id: 'details', question: 'Details?', isOther: false, isSecret: true, options: null
    }]
  });

  assert.deepEqual(adaptCodexServerResponse(pending, {
    action: 'submit', answer: { details: ['temporary token'] }
  }), {
    answers: { details: { answers: ['user_note: temporary token'] } }
  });
  assert.deepEqual(adaptCodexServerResponse(pending, {
    action: 'submit', answer: {}
  }), { answers: {} });
});

test('MCP form and url actions use the exact elicitation result contract', () => {
  const form = interaction('mcpServer/elicitation/request', {
    mode: 'form',
    message: 'Account?',
    requestedSchema: {
      type: 'object',
      properties: { email: { type: 'string' } },
      required: ['email']
    }
  });
  const url = interaction('mcpServer/elicitation/request', {
    mode: 'url',
    message: 'Authorize?',
    url: 'https://example.com/oauth',
    elicitationId: 'auth-1'
  });

  assert.deepEqual(adaptCodexServerResponse(form, {
    action: 'submit', answer: { email: 'user@example.com' }
  }), {
    action: 'accept', content: { email: 'user@example.com' }, _meta: null
  });
  assert.deepEqual(adaptCodexServerResponse(form, { action: 'decline' }), {
    action: 'decline', content: null, _meta: null
  });
  assert.deepEqual(adaptCodexServerResponse(url, { action: 'submit', answer: {} }), {
    action: 'accept', content: null, _meta: null
  });
  assert.throws(() => adaptCodexServerResponse(url, {
    action: 'submit', answer: { unexpected: true }
  }), (error) => error.code === 'codex_question_answer_not_allowed');
  assert.deepEqual(adaptCodexServerResponse(url, { action: 'cancel' }), {
    action: 'cancel', content: null, _meta: null
  });
});

test('MCP enum answers must belong to the provider-advertised options', () => {
  const form = interaction('mcpServer/elicitation/request', {
    mode: 'form',
    message: 'Deployment?',
    requestedSchema: {
      type: 'object',
      properties: {
        region: {
          type: 'string',
          oneOf: [
            { const: 'us', title: 'United States' },
            { const: 'eu', title: 'Europe' }
          ]
        },
        tags: {
          type: 'array',
          items: { type: 'string', enum: ['safe', 'fast'] }
        }
      },
      required: ['region']
    }
  });

  assert.deepEqual(adaptCodexServerResponse(form, {
    action: 'submit', answer: { region: 'eu', tags: ['safe'] }
  }), {
    action: 'accept', content: { region: 'eu', tags: ['safe'] }, _meta: null
  });
  for (const answer of [
    { region: 'unknown', tags: ['safe'] },
    { region: 'us', tags: ['unsafe'] }
  ]) {
    assert.throws(
      () => adaptCodexServerResponse(form, { action: 'submit', answer }),
      (error) => error.code === 'codex_question_answer_not_available'
    );
  }
});

test('unknown choices, actions, fields and answer types fail closed', () => {
  const approval = interaction('item/fileChange/requestApproval', { itemId: 'file-1' });
  const form = interaction('mcpServer/elicitation/request', {
    mode: 'form',
    message: 'Count?',
    requestedSchema: {
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count']
    }
  });

  assert.throws(
    () => adaptCodexServerResponse(approval, { choiceId: 'choice-99' }),
    (error) => error.code === 'codex_approval_choice_not_available'
  );
  assert.throws(
    () => adaptCodexServerResponse(form, { action: 'accept' }),
    (error) => error.code === 'invalid_question_action'
  );
  assert.throws(() => adaptCodexServerResponse(form, {
    action: 'submit', answer: { count: '1' }
  }), (error) => error.code === 'codex_question_answer_type_mismatch');
  assert.throws(() => adaptCodexServerResponse(form, {
    action: 'submit', answer: { count: 1, future: true }
  }), (error) => error.code === 'codex_question_answer_unknown_field');
});

function interaction(method, overrides = {}) {
  const adapted = adaptCodexInteractionRequest({
    method,
    requestId: 'request-1',
    sessionId: 'session-1',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      ...overrides
    }
  });
  return {
    interactionId: adapted.interaction.interactionId,
    envelope: adapted.envelope
  };
}
