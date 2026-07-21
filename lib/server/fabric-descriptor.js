'use strict';

const { buildControlPlaneDescriptor } = require('./control-plane-descriptor');
const { buildFabricGatewayCapability } = require('./fabric-gateway-capability');

const FABRIC_PROTOCOL_VERSION = 1;

const FABRIC_CLIENT_CAPABILITIES = Object.freeze([
  'server-profile',
  'node-directory',
  'role-registry',
  'remote-development-session',
  'transport-lab'
]);

const FABRIC_ROLE_CAPABILITIES = Object.freeze({
  server: ['identity', 'registry', 'role-registry', 'audit'],
  relay: ['wss-relay'],
  node: ['remote-runtime'],
  client: ['profile-selection'],
  lab: ['webrtc-signaling', 'webrtc-datachannel', 'ws-echo']
});

function normalizeEndpoint(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function buildFabricDescriptor(input = {}) {
  const controlPlane = buildControlPlaneDescriptor(input);
  const endpoint = normalizeEndpoint(controlPlane.endpoint || input.endpoint);
  const state = input.state && typeof input.state === 'object' ? input.state : {};
  const identity = state.serverIdentity && typeof state.serverIdentity === 'object'
    ? state.serverIdentity
    : {};
  const gateway = buildFabricGatewayCapability(state, input.options || {});
  return {
    ok: true,
    service: 'aih-fabric',
    protocolVersion: FABRIC_PROTOCOL_VERSION,
    server: {
      id: String(identity.id || `fabric-${String(controlPlane.host || 'localhost')}-${Number(controlPlane.port || 0)}`),
      name: String(input.name || identity.name || 'AI Home Server'),
      endpoint,
      host: controlPlane.host,
      port: controlPlane.port,
      serverTime: controlPlane.serverTime,
      uptimeSec: controlPlane.uptimeSec
    },
    roles: ['server', 'relay'],
    auth: {
      methods: ['management-key'],
      managementKeyConfigured: Boolean(controlPlane.auth && controlPlane.auth.managementKeyConfigured),
      clientKeyConfigured: Boolean(controlPlane.auth && controlPlane.auth.clientKeyConfigured)
    },
    capabilities: {
      client: FABRIC_CLIENT_CAPABILITIES.slice(),
      roles: {
        server: FABRIC_ROLE_CAPABILITIES.server.slice(),
        relay: FABRIC_ROLE_CAPABILITIES.relay.slice(),
        node: FABRIC_ROLE_CAPABILITIES.node.slice(),
        client: FABRIC_ROLE_CAPABILITIES.client.slice()
      },
      transports: Array.from(new Set([
        ...(Array.isArray(controlPlane.capabilities && controlPlane.capabilities.transports)
          ? controlPlane.capabilities.transports
          : []),
        'webrtc-datachannel-lab',
        'ws-echo'
      ])),
      transportLab: FABRIC_ROLE_CAPABILITIES.lab.slice(),
      gateway,
      legacyControlPlane: {
        protocolVersion: controlPlane.protocolVersion,
        nodeRpc: Array.isArray(controlPlane.capabilities && controlPlane.capabilities.nodeRpc)
          ? controlPlane.capabilities.nodeRpc.slice()
          : [],
        management: Array.isArray(controlPlane.capabilities && controlPlane.capabilities.management)
          ? controlPlane.capabilities.management.slice()
          : []
      }
    }
  };
}

module.exports = {
  FABRIC_PROTOCOL_VERSION,
  buildFabricDescriptor
};
