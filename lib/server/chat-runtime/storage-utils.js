'use strict';

const { ChatRuntimeError } = require('./contracts');

function requiredText(value, code) {
  const text = String(value || '').trim();
  if (!text) throw new ChatRuntimeError(code);
  return text;
}

function jsonText(value, code = 'invalid_chat_runtime_json') {
  try {
    return JSON.stringify(sortJson(value === undefined ? {} : value));
  } catch (_error) {
    throw new ChatRuntimeError(code);
  }
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    if (value[key] !== undefined) result[key] = sortJson(value[key]);
    return result;
  }, {});
}

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined || value === '') return structuredClone(fallback);
  return JSON.parse(String(value));
}

function mapSession(row) {
  if (!row) return null;
  const session = {
    sessionId: row.session_id,
    provider: row.provider,
    executionAccountRef: row.execution_account_ref,
    projectPath: row.project_path,
    state: row.state,
    runtimeBinding: parseJson(row.runtime_binding_json),
    capabilitySnapshot: parseJson(row.capability_snapshot_json),
    policy: parseJson(row.policy_json),
    lastEventSeq: Number(row.last_event_seq),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
  if (row.active_turn_json) session.activeTurn = parseJson(row.active_turn_json);
  return session;
}

function mapCommand(row) {
  if (!row) return null;
  const command = {
    commandId: row.command_id,
    sessionId: row.session_id,
    type: row.type,
    payload: parseJson(row.payload_json),
    status: row.status,
    acceptedSeq: Number(row.accepted_seq),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
  if (row.result_json) command.result = parseJson(row.result_json);
  return command;
}

function mapQueueItem(row) {
  if (!row) return null;
  const item = {
    queueId: row.queue_id,
    sessionId: row.session_id,
    commandId: row.command_id,
    position: Number(row.position),
    policy: row.policy,
    payload: parseJson(row.payload_json),
    status: row.state,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
  if (row.lease_id) item.leaseId = row.lease_id;
  if (row.boundary_item_id) item.boundaryItemId = row.boundary_item_id;
  if (row.result_json) item.result = parseJson(row.result_json);
  return item;
}

function mapInteraction(row) {
  if (!row) return null;
  const interaction = {
    interactionId: row.interaction_id,
    sessionId: row.session_id,
    itemId: row.item_id,
    kind: row.kind,
    revision: Number(row.revision),
    payload: parseJson(row.payload_json),
    state: row.state,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
  if (row.resolution_json) interaction.resolution = parseJson(row.resolution_json);
  return interaction;
}

module.exports = {
  jsonText,
  mapCommand,
  mapInteraction,
  mapQueueItem,
  mapSession,
  parseJson,
  requiredText
};
