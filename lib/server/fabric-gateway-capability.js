'use strict';

const { buildAccountCapabilityRegistry } = require('./account-capabilities');
const { listModelIdLookupKeys } = require('./model-id');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const { FABRIC_GATEWAY_PROTOCOL_VERSION } = require('./fabric-gateway-protocol');

function buildFabricGatewayCapability(state, options = {}) {
  const registry = buildAccountCapabilityRegistry(state, options);
  const enabledProviders = new Set(registry.enabledProviders);
  const providers = {};
  const availableModels = new Set();
  let accountCount = 0;
  let availableCount = 0;

  SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
    if (!enabledProviders.has(provider)) return;
    const capability = registry.providers[provider] || {};
    const providerAvailableModels = (Array.isArray(capability.modelIds) ? capability.modelIds : [])
      .filter((model) => Array.isArray(capability.availableAccountRefsByModel?.[model])
        && capability.availableAccountRefsByModel[model].length > 0);
    providerAvailableModels.forEach((model) => availableModels.add(model));
    accountCount += Number(capability.accountCount || 0);
    availableCount += Number(capability.availableCount || 0);
    providers[provider] = {
      accounts: Number(capability.accountCount || 0),
      available: Number(capability.availableCount || 0),
      models: providerAvailableModels
    };
  });

  return {
    protocolVersion: FABRIC_GATEWAY_PROTOCOL_VERSION,
    enabled: availableCount > 0,
    accounts: accountCount,
    available: availableCount,
    models: Array.from(availableModels).sort(),
    providers
  };
}

function isCompatibleFabricGatewayCapability(capability) {
  return Boolean(
    capability
    && Number(capability.protocolVersion) === FABRIC_GATEWAY_PROTOCOL_VERSION
    && capability.enabled === true
    && Number(capability.available || 0) > 0
  );
}

function gatewayCapabilityModels(capability, provider) {
  const requestedProvider = String(provider || '').trim().toLowerCase();
  const source = requestedProvider
    ? capability?.providers?.[requestedProvider]?.models
    : capability?.models;
  return Array.isArray(source)
    ? source.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function gatewayCapabilitySupportsModel(capability, model, provider) {
  const requested = String(model || '').trim();
  if (!requested) return true;
  const models = gatewayCapabilityModels(capability, provider);
  if (models.length === 0) return true;
  const requestedKeys = new Set(listModelIdLookupKeys(requested));
  return models.some((candidate) => (
    listModelIdLookupKeys(candidate).some((key) => requestedKeys.has(key))
  ));
}

function gatewayCapabilitySupportsProvider(capability, provider) {
  const requested = String(provider || '').trim().toLowerCase();
  if (!requested) return true;
  const providerCapability = capability?.providers?.[requested];
  return Boolean(providerCapability && Number(providerCapability.available || 0) > 0);
}

function gatewayAvailability(capability, provider) {
  const requested = String(provider || '').trim().toLowerCase();
  if (!requested) return Number(capability && capability.available || 0);
  return Number(capability?.providers?.[requested]?.available || 0);
}

function listFabricGatewayServers(servers, model, provider) {
  return (Array.isArray(servers) ? servers : [])
    .filter((server) => {
      const capability = server?.capabilities?.gateway;
      return server?.online !== false
        && isCompatibleFabricGatewayCapability(capability)
        && gatewayCapabilitySupportsProvider(capability, provider)
        && gatewayCapabilitySupportsModel(capability, model, provider);
    })
    .sort((left, right) => {
      const availability = gatewayAvailability(right.capabilities.gateway, provider)
        - gatewayAvailability(left.capabilities.gateway, provider);
      if (availability !== 0) return availability;
      return String(left.stableServerId || '').localeCompare(String(right.stableServerId || ''));
    });
}

function selectFabricGatewayServer(servers, model, provider) {
  return listFabricGatewayServers(servers, model, provider)[0] || null;
}

function buildFabricGatewayReadiness(registry) {
  const servers = registry && typeof registry.listBrokerServers === 'function'
    ? listFabricGatewayServers(registry.listBrokerServers(), '')
    : [];
  return {
    ready: servers.length > 0,
    connectedServers: servers.length,
    availableAccounts: servers.reduce((total, server) => (
      total + Number(server.capabilities.gateway.available || 0)
    ), 0)
  };
}

module.exports = {
  buildFabricGatewayCapability,
  buildFabricGatewayReadiness,
  gatewayCapabilitySupportsModel,
  gatewayCapabilitySupportsProvider,
  isCompatibleFabricGatewayCapability,
  listFabricGatewayServers,
  selectFabricGatewayServer
};
