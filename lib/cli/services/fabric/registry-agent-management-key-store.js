'use strict';

const fs = require('node:fs');
const {
  deleteJsonValue,
  readJsonValue,
  writeJsonValue
} = require('../../../server/app-state-store');
const { normalizeNodeId } = require('./registry-heartbeat');

const REGISTRY_AGENT_MANAGEMENT_KEY_PREFIX = 'fabric:registry-agent-management-key:';

function buildRegistryAgentManagementKey(nodeId) {
  const normalizedNodeId = normalizeNodeId(nodeId);
  return normalizedNodeId ? `${REGISTRY_AGENT_MANAGEMENT_KEY_PREFIX}${normalizedNodeId}` : '';
}

function readRegistryAgentManagementKey(nodeId, deps = {}) {
  const key = buildRegistryAgentManagementKey(nodeId);
  if (!key) return '';
  const record = readJsonValue(deps.fs || fs, deps.aiHomeDir, key);
  return String(record && record.managementKey || '').trim();
}

function writeRegistryAgentManagementKey(nodeId, managementKey, deps = {}) {
  const key = buildRegistryAgentManagementKey(nodeId);
  const normalizedKey = String(managementKey || '').trim();
  if (!key) {
    const error = new Error('invalid_fabric_node_id');
    error.code = 'invalid_fabric_node_id';
    throw error;
  }
  if (!normalizedKey) {
    const error = new Error('missing_management_key');
    error.code = 'missing_management_key';
    throw error;
  }
  const written = writeJsonValue(deps.fs || fs, deps.aiHomeDir, key, {
    managementKey: normalizedKey,
    updatedAt: Date.now()
  });
  if (!written) {
    const error = new Error('management_key_database_unavailable');
    error.code = 'management_key_database_unavailable';
    throw error;
  }
  return true;
}

function deleteRegistryAgentManagementKey(nodeId, deps = {}) {
  const key = buildRegistryAgentManagementKey(nodeId);
  return key ? deleteJsonValue(deps.fs || fs, deps.aiHomeDir, key) : false;
}

module.exports = {
  REGISTRY_AGENT_MANAGEMENT_KEY_PREFIX,
  buildRegistryAgentManagementKey,
  deleteRegistryAgentManagementKey,
  readRegistryAgentManagementKey,
  writeRegistryAgentManagementKey
};
