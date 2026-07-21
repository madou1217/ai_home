'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  mapCodexAppServerMessage
} = require('../lib/server/codex-app-server-canonical');
const {
  CodexSessionEventBridge
} = require('../lib/server/chat-runtime/codex-session-event-bridge');
const {
  createNativeInteractionId
} = require('../lib/server/chat-runtime/native-interaction-id');

const SESSION_ID = 'session-interaction-boundary';
const THREAD_ID = 'thread-interaction-boundary';

test('command approvals expose ordered opaque choices while exact native decisions stay private', async () => {
  const nativeDecisions = [
    'acceptForSession',
    {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ['git', 'status']
      }
    },
    {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { host: 'example.com', action: 'allow' }
      }
    },
    'decline'
  ];
  const client = responseClient();
  const bridge = eventBridge();
  const forwarded = bridge.forwardServerRequest(request(
    41,
    'item/commandExecution/requestApproval',
    {
      threadId: THREAD_ID,
      turnId: 'turn-1',
      itemId: 'command-1',
      command: 'git status',
      cwd: '/repo',
      reason: 'Inspect the worktree',
      availableDecisions: nativeDecisions
    }
  ), turnContext(), client);
  const interaction = forwarded.event.payload.interaction;

  assert.deepEqual(interaction.payload.choices.map(({ id, intent }) => ({ id, intent })), [
    { id: 'choice-0', intent: 'accept' },
    { id: 'choice-1', intent: 'accept' },
    { id: 'choice-2', intent: 'accept' },
    { id: 'choice-3', intent: 'deny' }
  ]);
  assert.deepEqual(interaction.payload.presentation, {
    title: 'Run command?',
    description: 'Inspect the worktree',
    detail: 'git status',
    annotations: [{ label: 'Working directory', value: '/repo' }]
  });
  assertPublicInteraction(interaction);

  bridge.respond(interaction.interactionId, 'approval', 1, { choiceId: 'choice-2' });
  assert.deepEqual(client.responses, [{
    id: 41,
    result: { decision: nativeDecisions[2] }
  }]);
});

test('file and permissions approvals advertise their complete provider-owned choices', () => {
  const file = mappedInteraction(request(42, 'item/fileChange/requestApproval', {
    threadId: THREAD_ID,
    turnId: 'turn-1',
    itemId: 'file-1',
    reason: 'Apply changes',
    grantRoot: '/repo'
  }));
  const permissions = mappedInteraction(request(43, 'item/permissions/requestApproval', {
    threadId: THREAD_ID,
    turnId: 'turn-1',
    itemId: 'permissions-1',
    reason: 'Write build output',
    cwd: '/repo',
    permissions: { fileSystem: { write: ['/repo/dist'] } }
  }));

  assert.deepEqual(file.payload.choices.map(({ id, intent }) => ({ id, intent })), [
    { id: 'choice-0', intent: 'accept' },
    { id: 'choice-1', intent: 'accept' },
    { id: 'choice-2', intent: 'deny' },
    { id: 'choice-3', intent: 'cancel' }
  ]);
  assert.deepEqual(permissions.payload.choices.map(({ id, intent }) => ({ id, intent })), [
    { id: 'choice-0', intent: 'accept' },
    { id: 'choice-1', intent: 'accept' },
    { id: 'choice-2', intent: 'accept' },
    { id: 'choice-3', intent: 'deny' }
  ]);
  assertPublicInteraction(file);
  assertPublicInteraction(permissions);
});

test('tool questions become strict canonical fields and malformed identities fail closed', () => {
  const interaction = mappedInteraction(request(44, 'item/tool/requestUserInput', {
    threadId: THREAD_ID,
    turnId: 'turn-1',
    itemId: 'question-1',
    questions: [
      {
        id: 'target',
        header: 'Target',
        question: 'Where should this run?',
        isOther: true,
        isSecret: false,
        options: [
          { label: 'Web', description: 'Run in the browser' },
          { label: 'CLI', description: 'Run in the terminal' }
        ]
      },
      {
        id: 'token',
        header: 'Token',
        question: 'Paste the temporary token',
        isOther: false,
        isSecret: true,
        options: null
      }
    ],
    autoResolutionMs: 60_000
  }));

  assert.deepEqual(interaction.payload, {
    presentation: { title: 'Input required' },
    fields: [
      {
        id: 'target',
        label: 'Where should this run?',
        header: 'Target',
        type: 'single_select',
        required: false,
        allowOther: true,
        secret: false,
        options: [
          { value: 'Web', label: 'Web', description: 'Run in the browser' },
          { value: 'CLI', label: 'CLI', description: 'Run in the terminal' }
        ]
      },
      {
        id: 'token',
        label: 'Paste the temporary token',
        header: 'Token',
        type: 'text',
        required: false,
        allowOther: false,
        secret: true
      }
    ],
    actions: ['submit'],
    answerShape: 'answers',
    confirmUnanswered: true,
    autoResolution: {
      mode: 'inactivity_countdown',
      inactivityMs: 60_000,
      countdownMs: 60_000,
      onExpire: 'submit_empty',
      snooze: 'disable'
    }
  });
  assertPublicInteraction(interaction);

  for (const questions of [[], [
    question('duplicate'), question('duplicate')
  ]]) {
    const mapped = map(request(45, 'item/tool/requestUserInput', {
      threadId: THREAD_ID,
      turnId: 'turn-1',
      itemId: 'invalid-question',
      questions
    }));
    assert.equal(mapped.type, 'stream.error');
    assert.equal(mapped.payload.error, 'invalid_codex_tool_question');
    assert.deepEqual(Object.keys(mapped.payload).sort(), ['error', 'message', 'retryable']);
    assert.doesNotMatch(
      JSON.stringify(mapped),
      /"method"\s*:|"requestId"\s*:|"threadId"\s*:|"paramKeys"\s*:/
    );
  }
});

test('standard MCP forms map every supported primitive and enum without exposing schemas', () => {
  const interaction = mappedInteraction(request(46, 'mcpServer/elicitation/request', {
    threadId: THREAD_ID,
    turnId: 'turn-1',
    serverName: 'accounts',
    mode: 'form',
    message: 'Configure the account',
    requestedSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name', description: 'Display name' },
        ratio: { type: 'number', title: 'Ratio' },
        retries: { type: 'integer', title: 'Retries' },
        enabled: { type: 'boolean', title: 'Enabled' },
        region: {
          type: 'string',
          title: 'Region',
          oneOf: [
            { const: 'us', title: 'United States' },
            { const: 'eu', title: 'Europe' }
          ]
        },
        tags: {
          type: 'array',
          title: 'Tags',
          items: { type: 'string', enum: ['safe', 'fast'] }
        }
      },
      required: ['name', 'enabled']
    },
    _meta: { autoResolutionMs: 5000, privateToken: 'must-not-leak' }
  }));

  assert.deepEqual(interaction.payload.fields.map((field) => ({
    id: field.id,
    type: field.type,
    required: field.required,
    options: field.options
  })), [
    { id: 'name', type: 'text', required: true, options: undefined },
    { id: 'ratio', type: 'number', required: false, options: undefined },
    { id: 'retries', type: 'integer', required: false, options: undefined },
    { id: 'enabled', type: 'boolean', required: true, options: undefined },
    {
      id: 'region', type: 'single_select', required: false,
      options: [
        { value: 'us', label: 'United States' },
        { value: 'eu', label: 'Europe' }
      ]
    },
    {
      id: 'tags', type: 'multi_select', required: false,
      options: [
        { value: 'safe', label: 'safe' },
        { value: 'fast', label: 'fast' }
      ]
    }
  ]);
  assert.deepEqual(interaction.payload.autoResolution, {
    mode: 'countdown',
    countdownMs: 5000,
    onExpire: 'decline',
    snooze: 'disable'
  });
  assert.equal(interaction.payload.answerShape, 'object');
  assertPublicInteraction(interaction);
});

test('MCP url requests expose a safe link and unknown openai forms are explicit unsupported errors', () => {
  const url = mappedInteraction(request(47, 'mcpServer/elicitation/request', {
    threadId: THREAD_ID,
    turnId: 'turn-1',
    serverName: 'accounts',
    mode: 'url',
    message: 'Authorize the account',
    url: 'https://example.com/oauth',
    elicitationId: 'native-elicitation-1',
    _meta: { autoResolutionMs: 300_000 }
  }));
  const unsupported = map(request(48, 'mcpServer/elicitation/request', {
    threadId: THREAD_ID,
    turnId: 'turn-1',
    serverName: 'accounts',
    mode: 'openai/form',
    message: 'Unsupported form',
    requestedSchema: { type: 'future-widget' }
  }));

  assert.deepEqual(url.payload.presentation, {
    title: 'Action required',
    message: 'Authorize the account',
    link: { label: 'Open link', url: 'https://example.com/oauth' }
  });
  assert.deepEqual(url.payload.fields, []);
  assert.equal(url.payload.answerShape, 'none');
  assertPublicInteraction(url);
  assert.doesNotMatch(JSON.stringify(url), /native-elicitation-1/);
  assert.equal(unsupported.type, 'stream.error');
  assert.equal(unsupported.payload.error, 'unsupported_codex_mcp_openai_form_schema');
  assert.doesNotMatch(JSON.stringify(unsupported), /future-widget|Unsupported form/);
});

test('replay compares durable canonical interactions and rebuilds only the private bridge envelope', async () => {
  const params = {
    threadId: THREAD_ID,
    turnId: 'turn-replayed',
    itemId: 'file-replayed',
    reason: 'Apply changes',
    grantRoot: '/repo',
    providerPrivateNonce: 'first'
  };
  const durable = mappedInteraction(request(
    49,
    'item/fileChange/requestApproval',
    params
  ));
  assertPublicInteraction(durable);
  const bridge = eventBridge();
  bridge.expectReplays([durable]);

  const forwarded = bridge.forwardServerRequest(request(
    49,
    'item/fileChange/requestApproval',
    { ...params, providerPrivateNonce: 'changed-on-replay' }
  ), turnContext(), responseClient());

  await bridge.waitForExpectedReplays();
  assert.equal(forwarded.event.payload.interaction.interactionId, durable.interactionId);
  assert.equal(bridge.events.length, 0);
});

function eventBridge() {
  const events = [];
  const bridge = new CodexSessionEventBridge({
    sessionId: SESSION_ID,
    eventSink: async (event) => events.push(event)
  });
  bridge.events = events;
  return bridge;
}

function responseClient() {
  return {
    responses: [],
    errors: [],
    respond(id, result) { this.responses.push({ id, result }); return true; },
    respondError(id, code, message) { this.errors.push({ id, code, message }); return true; }
  };
}

function mappedInteraction(message) {
  const mapped = map(message);
  assert.equal(mapped.type, 'interaction.requested');
  return mapped.payload.interaction;
}

function map(message) {
  return mapCodexAppServerMessage(message, { sessionId: SESSION_ID });
}

function request(id, method, params) {
  return { jsonrpc: '2.0', id, method, params };
}

function question(id) {
  return {
    id,
    header: 'Question',
    question: 'Continue?',
    isOther: false,
    isSecret: false,
    options: null
  };
}

function turnContext() {
  return { turnId: 'turn-1', runId: 'run-1' };
}

function assertPublicInteraction(interaction) {
  const forbidden = new Set([
    '_meta', 'availableDecisions', 'elicitationId', 'grantRoot', 'isOther',
    'isSecret', 'method', 'requestId', 'requestedSchema', 'threadId'
  ]);
  visitKeys(interaction.payload, (key) => {
    assert.equal(forbidden.has(key), false, `provider wire key leaked: ${key}`);
  });
  assert.doesNotMatch(JSON.stringify(interaction), /must-not-leak/);
}

function visitKeys(value, visit) {
  if (Array.isArray(value)) {
    value.forEach((item) => visitKeys(item, visit));
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([key, child]) => {
    visit(key);
    visitKeys(child, visit);
  });
}

function interactionId(requestId) {
  return createNativeInteractionId({
    provider: 'codex',
    sessionId: SESSION_ID,
    nativeThreadId: THREAD_ID,
    nativeRequestId: requestId
  });
}

void interactionId;
