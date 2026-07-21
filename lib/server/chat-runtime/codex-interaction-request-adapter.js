'use strict';

const {
  normalizeCanonicalInteractionPayload
} = require('./canonical-interaction-payload');
const {
  adaptCommandApproval,
  adaptFileApproval,
  adaptPermissionsApproval
} = require('./codex-approval-request-adapter');
const {
  adaptMcpElicitation
} = require('./codex-mcp-elicitation-request-adapter');
const {
  clone,
  codexError,
  record,
  requiredText
} = require('./codex-interaction-adapter-support');
const {
  adaptToolQuestion
} = require('./codex-tool-question-request-adapter');
const { createNativeInteractionId } = require('./native-interaction-id');

const CODEX_INTERACTION_ENVELOPE = Symbol('codexInteractionEnvelope');
const REQUEST_ADAPTERS = new Map([
  ['item/commandExecution/requestApproval', adaptCommandApproval],
  ['item/fileChange/requestApproval', adaptFileApproval],
  ['item/permissions/requestApproval', adaptPermissionsApproval],
  ['item/tool/requestUserInput', adaptToolQuestion],
  ['mcpServer/elicitation/request', adaptMcpElicitation]
]);

function adaptCodexInteractionRequest(input = {}) {
  const method = requiredText(input.method, 'codex_interaction_method_required');
  const adapt = REQUEST_ADAPTERS.get(method);
  if (!adapt) throw codexError('unsupported_codex_interaction_method');
  const params = record(input.params, 'invalid_codex_interaction_request');
  const identity = nativeIdentity(input, params);
  const projection = adapt(params);
  const interaction = canonicalInteraction(identity.interactionId, params, projection);
  return {
    interaction,
    envelope: privateEnvelope(input, params, identity, projection)
  };
}

function canonicalInteraction(interactionId, params, projection) {
  return {
    interactionId,
    kind: projection.kind,
    revision: 1,
    state: 'pending',
    itemId: projection.itemId || String(params.itemId || interactionId),
    payload: normalizeCanonicalInteractionPayload(projection.kind, projection.payload)
  };
}

function nativeIdentity(input, params) {
  const requestId = input.requestId;
  if (!['string', 'number'].includes(typeof requestId)) {
    throw codexError('invalid_codex_interaction_request_id');
  }
  const nativeThreadId = requiredText(params.threadId, 'invalid_codex_interaction_thread');
  const sessionId = requiredText(input.sessionId, 'invalid_codex_interaction_session');
  return {
    interactionId: createNativeInteractionId({
      provider: 'codex', sessionId, nativeThreadId, nativeRequestId: requestId
    }),
    nativeThreadId,
    sessionId
  };
}

function privateEnvelope(input, params, identity, projection) {
  return Object.freeze({
    method: input.method,
    nativeRequest: clone(params),
    nativeThreadId: identity.nativeThreadId,
    provider: 'codex',
    requestId: clone(input.requestId),
    sessionId: identity.sessionId,
    choiceResponses: projection.choiceResponses || new Map()
  });
}

function attachCodexInteractionEnvelope(target, envelope) {
  Object.defineProperty(target, CODEX_INTERACTION_ENVELOPE, {
    configurable: false,
    enumerable: false,
    value: envelope,
    writable: false
  });
  return target;
}

function readCodexInteractionEnvelope(target) {
  return target && target[CODEX_INTERACTION_ENVELOPE];
}

module.exports = {
  adaptCodexInteractionRequest,
  attachCodexInteractionEnvelope,
  readCodexInteractionEnvelope
};
