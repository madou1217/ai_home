'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createCliInteractionCoordinator } = require('../lib/server/cli-interaction-coordinator');
const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');
const {
  createProviderSessionCorrelationRegistry
} = require('../lib/server/provider-session-correlation-registry');
const {
  handleWebUiChatRuntimeRequest
} = require('../lib/server/webui-chat-runtime-routes');
const {
  handleProviderHookSessionEventRequest
} = require('../lib/server/webui-session-event-routes');

function createResponse() {
  return {
    statusCode: 0,
    body: '',
    end(chunk = '') {
      this.body += String(chunk);
    }
  };
}

function createHookContext(payload, deps) {
  const res = createResponse();
  return {
    url: new URL('http://127.0.0.1/v0/webui/session-events/provider-hook'),
    req: new EventEmitter(),
    res,
    deps,
    readRequestBody: async () => Buffer.from(JSON.stringify(payload)),
    writeJson(_res, statusCode, body) {
      res.statusCode = statusCode;
      res.end(JSON.stringify(body));
    }
  };
}

function createCommandContext(sessionId, command, deps) {
  const pathname = `/v0/webui/chat/sessions/${encodeURIComponent(sessionId)}/commands`;
  const res = createResponse();
  const req = new EventEmitter();
  req.url = pathname;
  req.headers = { host: '127.0.0.1:9527' };
  return {
    method: 'POST',
    pathname,
    req,
    res,
    deps,
    readRequestBody: async () => Buffer.from(JSON.stringify(command)),
    writeJson(_res, statusCode, body) {
      res.statusCode = statusCode;
      res.end(JSON.stringify(body));
    }
  };
}

test('CLI interaction hook waits for correlation then completes through canonical command routing', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cli-interaction-routes-'));
  const store = openChatRuntimeStore({ aiHomeDir });
  t.after(() => {
    store.close();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  const canonicalSession = store.createSession({
    sessionId: 'canonical-session-1',
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo',
    runtimeBinding: { nativeSessionId: 'native-session-1' },
    capabilitySnapshot: {},
    policy: {}
  });
  const dispatched = [];
  const chatRuntimeService = {
    store,
    async resolveSession() { throw new Error('existing session should be adopted'); },
    async dispatchCommand(sessionId, command) {
      dispatched.push({ sessionId, command });
      return { ready: true };
    }
  };
  const cliInteractionCoordinator = createCliInteractionCoordinator({ chatRuntimeService });
  const providerSessionCorrelationRegistry = createProviderSessionCorrelationRegistry();
  const deps = {
    chatRuntimeService,
    cliInteractionCoordinator,
    providerSessionCorrelationRegistry
  };
  const promptPayload = {
    provider: 'codex',
    eventName: 'AihCliInteractionSync',
    correlationId: 'correlation-1',
    accountRef: 'account-1',
    promptRevision: 1,
    prompt: {
      provider: 'codex',
      kind: 'choice',
      promptId: 'prompt-1',
      question: 'Additional safety checks',
      options: [
        { value: '1', title: 'Continue' },
        { value: '2', title: 'Cancel' }
      ]
    }
  };

  const notReady = createHookContext(promptPayload, deps);
  await handleProviderHookSessionEventRequest(notReady);
  assert.equal(notReady.res.statusCode, 409);
  assert.equal(JSON.parse(notReady.res.body).error, 'session_correlation_not_ready');

  providerSessionCorrelationRegistry.bind('correlation-1', {
    provider: 'codex',
    sessionId: 'native-session-1',
    projectPath: '/repo'
  });
  const created = createHookContext(promptPayload, deps);
  await handleProviderHookSessionEventRequest(created);
  assert.equal(created.res.statusCode, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].sessionId, canonicalSession.sessionId);
  assert.equal(dispatched[0].command.type, 'runtime.prewarm');
  const interaction = store.getSnapshot(canonicalSession.sessionId).interactions[0];
  assert.equal(interaction.payload.presentation.message, 'Additional safety checks');

  const command = {
    commandId: 'command-1',
    type: 'interaction.answer',
    payload: {
      interactionId: interaction.interactionId,
      revision: interaction.revision,
      action: 'submit',
      answer: { choice: ['1'] }
    }
  };
  const commandContext = createCommandContext(canonicalSession.sessionId, command, deps);
  assert.equal(await handleWebUiChatRuntimeRequest(commandContext), true);
  assert.equal(commandContext.res.statusCode, 202);
  assert.equal(JSON.parse(commandContext.res.body).result.queued, true);

  const polled = createHookContext(promptPayload, deps);
  await handleProviderHookSessionEventRequest(polled);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatched.length, 1);
  const delivery = JSON.parse(polled.res.body).command;
  assert.equal(delivery.choiceValue, '1');

  const acknowledged = createHookContext({
    provider: 'codex',
    eventName: 'AihCliInteractionSync',
    correlationId: 'correlation-1',
    resolvedDeliveryId: delivery.deliveryId
  }, deps);
  await handleProviderHookSessionEventRequest(acknowledged);
  assert.equal(acknowledged.res.statusCode, 200);
  assert.deepEqual(store.getSnapshot(canonicalSession.sessionId).interactions, []);
  assert.equal(store.getCommand(command.commandId).status, 'completed');
});

test('Codex lifecycle hooks refresh the matching canonical session history', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hook-prewarm-'));
  const store = openChatRuntimeStore({ aiHomeDir });
  t.after(() => {
    store.close();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  const canonicalSession = store.createSession({
    sessionId: 'canonical-session-hook',
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo',
    runtimeBinding: { nativeSessionId: 'native-session-hook' },
    capabilitySnapshot: {},
    policy: {}
  });
  const dispatched = [];
  const ctx = createHookContext({
    provider: 'codex',
    eventName: 'Stop',
    payload: { session_id: 'native-session-hook', cwd: '/repo' }
  }, {
    chatRuntimeService: {
      store,
      async dispatchCommand(sessionId, command) {
        dispatched.push({ sessionId, command });
        return { ready: true };
      }
    },
    sessionEventBus: { publish: () => true }
  });

  await handleProviderHookSessionEventRequest(ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ctx.res.statusCode, 200);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].sessionId, canonicalSession.sessionId);
  assert.equal(dispatched[0].command.type, 'runtime.prewarm');

  const claudeCtx = createHookContext({
    provider: 'claude',
    eventName: 'Stop',
    payload: { session_id: 'native-session-hook', cwd: '/repo' }
  }, ctx.deps);
  await handleProviderHookSessionEventRequest(claudeCtx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatched.length, 1);
});
