'use strict';

const REMOTE_MANAGEMENT_ROUTES = Object.freeze([
  {
    key: 'status',
    localPath: 'status',
    remotePath: '/v0/management/status',
    method: 'GET',
    capability: 'status',
    scope: 'status:read'
  },
  {
    key: 'metrics',
    localPath: 'metrics',
    remotePath: '/v0/management/metrics',
    method: 'GET',
    capability: 'metrics',
    scope: 'metrics:read'
  },
  {
    key: 'accounts.list',
    localPath: 'accounts',
    remotePath: '/v0/management/accounts',
    method: 'GET',
    capability: 'accounts',
    scope: 'accounts:read'
  },
  {
    key: 'models.list',
    localPath: 'models',
    remotePath: '/v0/management/models',
    method: 'GET',
    capability: 'models',
    scope: 'models:read'
  },
  {
    key: 'usage.stats',
    localPath: 'usage',
    remotePath: '/v0/management/usage',
    method: 'GET',
    capability: 'usage',
    scope: 'usage:read'
  },
  {
    key: 'usage.stats',
    localPath: 'usage/stats',
    remotePath: '/v0/management/usage/stats',
    method: 'GET',
    capability: 'usage',
    scope: 'usage:read'
  },
  {
    key: 'usage.models',
    localPath: 'usage/models',
    remotePath: '/v0/management/usage/models',
    method: 'GET',
    capability: 'usage',
    scope: 'usage:read'
  },
  {
    key: 'usage.sessions',
    localPath: 'usage/sessions',
    remotePath: '/v0/management/usage/sessions',
    method: 'GET',
    capability: 'usage',
    scope: 'usage:read'
  },
  {
    key: 'usage.session-detail',
    localPath: 'usage/session-detail',
    remotePath: '/v0/management/usage/session-detail',
    method: 'GET',
    capability: 'usage',
    scope: 'usage:read'
  }
]);

function normalizeLocalPath(value) {
  return String(value || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function matchRemoteManagementRoute(method, localPath) {
  const normalizedMethod = String(method || '').trim().toUpperCase();
  const normalizedPath = normalizeLocalPath(localPath);
  return REMOTE_MANAGEMENT_ROUTES.find((route) => {
    return route.method === normalizedMethod && route.localPath === normalizedPath;
  }) || null;
}

function appendSearch(remotePath, url) {
  const path = String(remotePath || '').trim();
  const search = url && typeof url.search === 'string' ? url.search : '';
  if (!search || search === '?') return path;
  const suffix = search.replace(/^\?/, '');
  if (!suffix) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${suffix}`;
}

function nodeSupportsCapability(node, capability) {
  const required = String(capability || '').trim();
  if (!required) return true;
  const capabilities = Array.isArray(node && node.capabilities) ? node.capabilities : [];
  return capabilities.map((item) => String(item || '').trim()).includes(required);
}

module.exports = {
  REMOTE_MANAGEMENT_ROUTES,
  normalizeLocalPath,
  matchRemoteManagementRoute,
  appendSearch,
  nodeSupportsCapability
};
