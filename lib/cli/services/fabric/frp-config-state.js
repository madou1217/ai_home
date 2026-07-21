'use strict';

const path = require('node:path');

const {
  DEFAULT_WEB_SERVER_PORT,
  normalizeFragmentOptions
} = require('./frp-config-document');
const { createFrpError } = require('./frp-config-errors');

const FRP_DESIRED_STATE_VERSION = 1;
const FRP_DESIRED_STATE_FILE = 'desired-routes.json';

function normalizeConfigPath(value) {
  const configPath = String(value || '').trim();
  if (!configPath || configPath.includes('\0')) {
    throw createFrpError('frpc_config_path_invalid', 'A valid frpc config path is required');
  }
  return configPath;
}

function normalizeWebServerPort(value) {
  const port = value == null || value === '' ? DEFAULT_WEB_SERVER_PORT : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw createFrpError(
      'frp_port_invalid',
      'webServerPort must be an integer between 1 and 65535',
      { field: 'webServerPort' }
    );
  }
  return port;
}

function desiredRouteKey(route) {
  return `${route.role}:${route.serverId}`;
}

function assertSingleConfigPath(routes) {
  const configPaths = new Set(routes.map((route) => route.configPath));
  if (configPaths.size > 1) {
    throw createFrpError(
      'frp_multiple_instances_unsupported',
      'One AIH_HOME can manage only one frpc config path'
    );
  }
}

function normalizeDesiredFrpRoute(input = {}) {
  const fragment = normalizeFragmentOptions(input);
  const common = {
    role: fragment.role,
    serverId: fragment.serverId,
    proxyName: fragment.proxyName,
    ...(fragment.role === 'visitor' ? { visitorName: fragment.visitorName } : {}),
    secretKey: fragment.secretKey,
    configPath: normalizeConfigPath(input.configPath),
    webServerPort: normalizeWebServerPort(input.webServerPort)
  };
  return fragment.role === 'provider'
    ? { ...common, localIP: fragment.localIP, localPort: fragment.localPort }
    : { ...common, bindAddr: fragment.bindAddr, bindPort: fragment.bindPort };
}

function emptyDesiredFrpState() {
  return { version: FRP_DESIRED_STATE_VERSION, routes: [] };
}

function normalizeDesiredFrpState(value) {
  if (!value || typeof value !== 'object'
    || value.version !== FRP_DESIRED_STATE_VERSION
    || !Array.isArray(value.routes)) {
    throw createFrpError('frp_desired_state_invalid', 'Invalid managed FRP desired state');
  }
  const routes = value.routes.map(normalizeDesiredFrpRoute);
  assertSingleConfigPath(routes);
  const keys = new Set();
  for (const route of routes) {
    const key = desiredRouteKey(route);
    if (keys.has(key)) {
      throw createFrpError('frp_desired_state_invalid', 'Duplicate managed FRP desired route', { key });
    }
    keys.add(key);
  }
  routes.sort((left, right) => desiredRouteKey(left).localeCompare(desiredRouteKey(right)));
  return { version: FRP_DESIRED_STATE_VERSION, routes };
}

function parseDesiredFrpState(content) {
  try {
    return normalizeDesiredFrpState(JSON.parse(String(content)));
  } catch (error) {
    if (error && (
      error.code === 'frp_desired_state_invalid'
      || error.code === 'frp_multiple_instances_unsupported'
    )) throw error;
    throw createFrpError('frp_desired_state_invalid', 'Unable to read managed FRP desired state', {
      cause: error
    });
  }
}

function renderDesiredFrpState(state) {
  return `${JSON.stringify(normalizeDesiredFrpState(state), null, 2)}\n`;
}

function upsertDesiredFrpRoute(state, input) {
  const route = normalizeDesiredFrpRoute(input);
  assertSingleConfigPath(state.routes.concat(route));
  const key = desiredRouteKey(route);
  return normalizeDesiredFrpState({
    version: FRP_DESIRED_STATE_VERSION,
    routes: state.routes.filter((item) => desiredRouteKey(item) !== key).concat(route)
  });
}

function removeDesiredFrpRoute(state, role, serverId) {
  const key = `${role}:${serverId}`;
  return normalizeDesiredFrpState({
    version: FRP_DESIRED_STATE_VERSION,
    routes: state.routes.filter((route) => desiredRouteKey(route) !== key)
  });
}

function resolveDesiredFrpStatePath(aiHomeDir, deps = {}) {
  const pathImpl = deps.path || path;
  return pathImpl.join(aiHomeDir, 'frp', FRP_DESIRED_STATE_FILE);
}

module.exports = {
  FRP_DESIRED_STATE_FILE,
  FRP_DESIRED_STATE_VERSION,
  desiredRouteKey,
  emptyDesiredFrpState,
  normalizeDesiredFrpRoute,
  normalizeDesiredFrpState,
  parseDesiredFrpState,
  removeDesiredFrpRoute,
  renderDesiredFrpState,
  resolveDesiredFrpStatePath,
  upsertDesiredFrpRoute
};
