'use strict';

const { buildControlPlaneDescriptor } = require('./control-plane-descriptor');

const FABRIC_PROTOCOL_VERSION = 1;

const FABRIC_CLIENT_CAPABILITIES = Object.freeze([
  'server-profile',
  'device-pairing',
  'node-directory',
  'role-registry',
  'native-tui-session',
  'transport-lab'
]);

const FABRIC_ROLE_CAPABILITIES = Object.freeze({
  server: ['identity', 'pairing', 'registry', 'role-registry', 'audit'],
  relay: ['wss-relay'],
  node: ['remote-runtime'],
  client: ['profile-selection'],
  lab: ['webrtc-signaling', 'webrtc-datachannel']
});

function normalizeEndpoint(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function buildFabricDescriptor(input = {}) {
  const controlPlane = buildControlPlaneDescriptor(input);
  const endpoint = normalizeEndpoint(controlPlane.endpoint || input.endpoint);
  return {
    ok: true,
    service: 'aih-fabric',
    protocolVersion: FABRIC_PROTOCOL_VERSION,
    server: {
      id: `fabric-${String(controlPlane.host || 'localhost')}-${Number(controlPlane.port || 0)}`,
      name: String(input.name || 'AIH Fabric Server'),
      endpoint,
      host: controlPlane.host,
      port: controlPlane.port,
      serverTime: controlPlane.serverTime,
      uptimeSec: controlPlane.uptimeSec
    },
    roles: ['server', 'relay'],
    auth: {
      methods: ['device-pair'],
      devicePairing: Boolean(controlPlane.capabilities && controlPlane.capabilities.devicePairing),
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
        'webrtc-datachannel-lab'
      ])),
      transportLab: FABRIC_ROLE_CAPABILITIES.lab.slice(),
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
