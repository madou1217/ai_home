'use strict';

const { DEFAULT_SERVER_PORT } = require('./server-defaults');
const { SUPPORTED_TRANSPORT_KINDS } = require('./remote/transport-registry');

const CONTROL_PLANE_PROTOCOL_VERSION = 1;

const NODE_RPC_CAPABILITIES = Object.freeze([
  'descriptor',
  'status',
  'session-messages',
  'session-stream',
  'session-command',
  'session-ack',
  'session-artifact',
  'join',
  'device-pair',
  'device-profile',
  'device-status',
  'device-accounts',
  'device-sessions',
  'device-session-messages',
  'device-session-events',
  'device-session-stream',
  'device-node-sessions',
  'device-node-session-catalog',
  'device-node-session-messages',
  'device-node-session-stream',
  'device-node-session-input',
  'device-node-session-start',
  'device-node-session-attach',
  'device-node-session-command',
  'device-node-session-ack',
  'device-node-session-run-events',
  'device-node-session-artifact',
  'device-node-session-run-input',
  'device-nodes'
]);

const MANAGEMENT_CAPABILITIES = Object.freeze([
  'status',
  'metrics',
  'accounts',
  'models',
  'usage.stats',
  'usage.models',
  'usage.sessions',
  'usage.sessionDetail'
]);

function normalizeEndpoint(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function buildControlPlaneDescriptor(input = {}) {
  const options = input.options && typeof input.options === 'object' ? input.options : {};
  const state = input.state && typeof input.state === 'object' ? input.state : {};
  const nowMs = Number(input.nowMs) || Date.now();
  const startedAt = Number(state.startedAt) || nowMs;

  return {
    ok: true,
    service: 'aih-control-plane',
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    endpoint: normalizeEndpoint(input.endpoint),
    host: String(options.host || '127.0.0.1'),
    port: Number(options.port || DEFAULT_SERVER_PORT),
    serverTime: new Date(nowMs).toISOString(),
    uptimeSec: Math.max(0, Math.floor((nowMs - startedAt) / 1000)),
    auth: {
      managementKeyConfigured: Boolean(String(input.requiredManagementKey || '').trim()),
      clientKeyConfigured: Boolean(String(options.clientKey || '').trim())
    },
    capabilities: {
      nodeRpc: NODE_RPC_CAPABILITIES.slice(),
      management: MANAGEMENT_CAPABILITIES.slice(),
      remoteManagement: true,
      remoteInvite: true,
      devicePairing: true,
      transports: SUPPORTED_TRANSPORT_KINDS.slice()
    }
  };
}

module.exports = {
  CONTROL_PLANE_PROTOCOL_VERSION,
  buildControlPlaneDescriptor
};
