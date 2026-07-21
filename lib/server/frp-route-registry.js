'use strict';

const {
  readJsonValue,
  writeJsonValue
} = require('./app-state-store');
const {
  validateCanonicalFabricServerId
} = require('./fabric-server-id');

const FRP_VISITOR_ROUTES_KEY = 'server:frp-visitor-routes';

function normalizeText(value, maxLength = 256) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeStableServerId(value) {
  return validateCanonicalFabricServerId(value);
}

function normalizeBindPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

function normalizeRoute(value, nowMs = Date.now) {
  const source = value && typeof value === 'object' ? value : {};
  const stableServerId = normalizeStableServerId(source.stableServerId || source.serverId);
  const bindPort = normalizeBindPort(source.bindPort);
  if (!stableServerId || !bindPort) return null;
  return {
    stableServerId,
    name: normalizeText(source.name, 120) || stableServerId,
    bindPort,
    endpoint: `http://127.0.0.1:${bindPort}`,
    health: ['healthy', 'degraded', 'offline'].includes(source.health)
      ? source.health
      : 'unknown',
    updatedAt: Math.max(0, Number(source.updatedAt) || nowMs())
  };
}

function deduplicateRoutes(routes) {
  const routesByServerId = new Map();
  const conflicts = new Set();
  routes.forEach((route) => {
    if (conflicts.has(route.stableServerId)) return;
    const existing = routesByServerId.get(route.stableServerId);
    if (existing && existing.bindPort !== route.bindPort) {
      routesByServerId.delete(route.stableServerId);
      conflicts.add(route.stableServerId);
      return;
    }
    routesByServerId.set(route.stableServerId, route);
  });
  return Array.from(routesByServerId.values());
}

function readRoutes(context = {}, deps = {}) {
  const read = deps.readJsonValue || readJsonValue;
  const stored = read(context.fs, context.aiHomeDir, FRP_VISITOR_ROUTES_KEY);
  const values = Array.isArray(stored)
    ? stored
    : (stored && Array.isArray(stored.routes) ? stored.routes : []);
  return deduplicateRoutes(values
    .map((route) => normalizeRoute(route, deps.nowMs || Date.now))
    .filter(Boolean))
    .sort((left, right) => left.name.localeCompare(right.name)
      || left.stableServerId.localeCompare(right.stableServerId));
}

function writeRoutes(routes, context = {}, deps = {}) {
  const write = deps.writeJsonValue || writeJsonValue;
  if (!write(context.fs, context.aiHomeDir, FRP_VISITOR_ROUTES_KEY, { version: 1, routes })) {
    const error = new Error('frp_route_registry_write_failed');
    error.code = 'frp_route_registry_write_failed';
    throw error;
  }
}

function listManagedFrpRoutes(context = {}, deps = {}) {
  return readRoutes(context, deps);
}

function upsertManagedFrpRoute(input = {}, context = {}, deps = {}) {
  const route = normalizeRoute(input, deps.nowMs || Date.now);
  if (!route) {
    const error = new Error('invalid_frp_visitor_route');
    error.code = 'invalid_frp_visitor_route';
    throw error;
  }
  const routes = readRoutes(context, deps)
    .filter((item) => item.stableServerId !== route.stableServerId);
  routes.push(route);
  writeRoutes(routes, context, deps);
  return route;
}

function removeManagedFrpRoute(stableServerId, context = {}, deps = {}) {
  const id = normalizeStableServerId(stableServerId);
  if (!id) return false;
  const current = readRoutes(context, deps);
  const routes = current.filter((item) => item.stableServerId !== id);
  if (routes.length === current.length) return false;
  writeRoutes(routes, context, deps);
  return true;
}

module.exports = {
  FRP_VISITOR_ROUTES_KEY,
  listManagedFrpRoutes,
  normalizeStableServerId,
  removeManagedFrpRoute,
  upsertManagedFrpRoute
};
