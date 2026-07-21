'use strict';

const os = require('node:os');
const {
  DEFAULT_SERVER_HOST,
  normalizeServerPort,
  formatUrlHost
} = require('../../../server/server-defaults');
const {
  normalizeEndpoint,
  normalizeTransportKind
} = require('../../../server/remote/transport-registry');
const {
  DEFAULT_REMOTE_TRANSPORT_KIND,
  buildRemoteNodeIdentity
} = require('../../../server/remote/node-defaults');

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function readOptionValue(args, index, flag) {
  const token = String(args[index] || '');
  const prefix = `${flag}=`;
  if (token.startsWith(prefix)) {
    return { value: token.slice(prefix.length), consumed: 1 };
  }
  const value = args[index + 1];
  if (value === undefined || isFlag(value)) {
    const error = new Error(`missing_value:${flag}`);
    error.code = 'missing_option_value';
    error.flag = flag;
    throw error;
  }
  return { value: String(value), consumed: 2 };
}

function parseNodeJoinArgs(rawArgs = []) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const options = {
    invite: '',
    endpoint: '',
    transportKind: '',
    provider: '',
    routeRole: 'data-plane',
    trustLevel: '',
    name: '',
    id: '',
    managementKey: '',
    json: false
  };

  for (let index = 0; index < args.length;) {
    const token = String(args[index] || '').trim();
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    if (token === '--endpoint' || token.startsWith('--endpoint=')) {
      const next = readOptionValue(args, index, '--endpoint');
      options.endpoint = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--transport' || token.startsWith('--transport=')) {
      const next = readOptionValue(args, index, '--transport');
      options.transportKind = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--transport-kind' || token.startsWith('--transport-kind=')) {
      const next = readOptionValue(args, index, '--transport-kind');
      options.transportKind = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--provider' || token.startsWith('--provider=')) {
      const next = readOptionValue(args, index, '--provider');
      options.provider = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--route-role' || token.startsWith('--route-role=')) {
      const next = readOptionValue(args, index, '--route-role');
      options.routeRole = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--trust-level' || token.startsWith('--trust-level=')) {
      const next = readOptionValue(args, index, '--trust-level');
      options.trustLevel = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--name' || token.startsWith('--name=')) {
      const next = readOptionValue(args, index, '--name');
      options.name = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--id' || token.startsWith('--id=')) {
      const next = readOptionValue(args, index, '--id');
      options.id = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--node-id' || token.startsWith('--node-id=')) {
      const next = readOptionValue(args, index, '--node-id');
      options.id = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--management-key' || token.startsWith('--management-key=')) {
      const next = readOptionValue(args, index, '--management-key');
      options.managementKey = next.value;
      index += next.consumed;
      continue;
    }
    if (isFlag(token)) {
      const error = new Error(`unknown_option:${token}`);
      error.code = 'unknown_option';
      error.flag = token;
      throw error;
    }
    if (options.invite) {
      const error = new Error('too_many_invites');
      error.code = 'too_many_invites';
      throw error;
    }
    options.invite = token;
    index += 1;
  }

  return options;
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost'
    || host === '::1'
    || host === '0:0:0:0:0:0:0:1'
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function isWildcardHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

function parseIpv4(value) {
  const parts = String(value || '').trim().split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets;
}

function isOverlayIpv4(octets) {
  if (!octets) return false;
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function isPrivateIpv4(octets) {
  if (!octets) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function isReservedIpv4(octets) {
  if (!octets) return true;
  return octets[0] === 0
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 192 && octets[1] === 0 && octets[2] === 0)
    || (octets[0] === 192 && octets[1] === 0 && octets[2] === 2)
    || (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19))
    || (octets[0] === 198 && octets[1] === 51 && octets[2] === 100)
    || (octets[0] === 203 && octets[1] === 0 && octets[2] === 113)
    || octets[0] >= 224;
}

function scoreInterfaceAddress(address) {
  const octets = parseIpv4(address);
  if (!octets) return 0;
  if (isOverlayIpv4(octets)) return 100;
  if (isPrivateIpv4(octets)) return 70;
  if (isReservedIpv4(octets)) return 0;
  return 40;
}

function selectAdvertisedHost(networkInterfaces) {
  const interfaces = typeof networkInterfaces === 'function' ? networkInterfaces() : {};
  const candidates = [];
  Object.values(interfaces || {}).forEach((items) => {
    (Array.isArray(items) ? items : []).forEach((item) => {
      if (!item || item.internal || item.family !== 'IPv4') return;
      const address = String(item.address || '').trim();
      const score = scoreInterfaceAddress(address);
      if (score > 0) candidates.push({ address, score });
    });
  });
  candidates.sort((left, right) => right.score - left.score || left.address.localeCompare(right.address));
  return candidates.length ? candidates[0].address : '';
}

function parseInviteUrl(invite) {
  const raw = String(invite || '').trim();
  if (!raw) {
    const error = new Error('missing_invite');
    error.code = 'missing_invite';
    throw error;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_error) {
    const error = new Error('invalid_invite_url');
    error.code = 'invalid_invite_url';
    throw error;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    const error = new Error('invalid_invite_url');
    error.code = 'invalid_invite_url';
    throw error;
  }

  if (parsed.pathname === '/v0/node-rpc/join') {
    if (!parsed.searchParams.get('code')) {
      const error = new Error('missing_invite_code');
      error.code = 'missing_invite_code';
      throw error;
    }
    return parsed;
  }

  const match = parsed.pathname.match(/\/invite\/([^/]+)\/?$/);
  if (match && match[1]) {
    const next = new URL('/v0/node-rpc/join', parsed.origin);
    next.searchParams.set('code', decodeURIComponent(match[1]));
    return next;
  }

  const code = String(parsed.searchParams.get('code') || '').trim();
  if (code) {
    const next = new URL('/v0/node-rpc/join', parsed.origin);
    next.searchParams.set('code', code);
    return next;
  }

  const error = new Error('missing_invite_code');
  error.code = 'missing_invite_code';
  throw error;
}

function assertValidTransport(kind) {
  const normalized = normalizeTransportKind(kind || DEFAULT_REMOTE_TRANSPORT_KIND);
  if (!normalized) {
    const error = new Error('invalid_transport_kind');
    error.code = 'invalid_transport_kind';
    throw error;
  }
  return normalized;
}

function resolveJoinTransportKind(options = {}) {
  const explicitKind = String(options.transportKind || '').trim();
  if (explicitKind) return assertValidTransport(explicitKind);
  return assertValidTransport(options.endpoint ? 'direct' : DEFAULT_REMOTE_TRANSPORT_KIND);
}

function resolveLocalEndpoint(options, serverConfig, inviteUrl, deps = {}) {
  if (options.transportKind === 'relay') return '';

  const explicitEndpoint = normalizeEndpoint(options.endpoint);
  if (options.endpoint && !explicitEndpoint) {
    const error = new Error('invalid_endpoint');
    error.code = 'invalid_endpoint';
    throw error;
  }
  if (explicitEndpoint) return explicitEndpoint;

  const host = String(serverConfig.host || DEFAULT_SERVER_HOST).trim() || DEFAULT_SERVER_HOST;
  const port = normalizeServerPort(serverConfig.port);
  const joinHost = inviteUrl && inviteUrl.hostname;
  const localOnlyJoin = isLoopbackHost(joinHost);
  const localOnlyServer = isLoopbackHost(host) || isWildcardHost(host);

  if (isWildcardHost(host)) {
    const detectedHost = selectAdvertisedHost(deps.networkInterfaces || os.networkInterfaces);
    if (detectedHost) return `http://${formatUrlHost(detectedHost)}:${port}`;
  }

  if (localOnlyServer && !localOnlyJoin) {
    const error = new Error('endpoint_required');
    error.code = 'endpoint_required';
    throw error;
  }

  const advertisedHost = isWildcardHost(host) ? DEFAULT_SERVER_HOST : host;
  return `http://${formatUrlHost(advertisedHost)}:${port}`;
}

function resolveManagementKey(options, serverConfig, endpoint, transportKind) {
  const key = String(options.managementKey || serverConfig.managementKey || '').trim();
  if (transportKind === 'relay' && !key) {
    const error = new Error('management_key_required');
    error.code = 'management_key_required';
    throw error;
  }
  if (!key) {
    const endpointUrl = new URL(endpoint);
    if (!isLoopbackHost(endpointUrl.hostname)) {
      const error = new Error('management_key_required');
      error.code = 'management_key_required';
      throw error;
    }
  }
  return key;
}

function readServerConfigSafe(readServerConfig) {
  if (typeof readServerConfig !== 'function') return {};
  try {
    return readServerConfig() || {};
  } catch (_error) {
    return {};
  }
}

function buildNodeJoinPayload(options, deps = {}) {
  const inviteUrl = parseInviteUrl(options.invite);
  const serverConfig = readServerConfigSafe(deps.readServerConfig);
  const transportKind = resolveJoinTransportKind(options);
  const endpoint = resolveLocalEndpoint({ ...options, transportKind }, serverConfig, inviteUrl, deps);
  const managementKey = resolveManagementKey(options, serverConfig, endpoint, transportKind);
  const hostname = typeof deps.hostname === 'function' ? deps.hostname() : os.hostname();
  const identity = buildRemoteNodeIdentity({
    id: options.id,
    name: options.name || hostname
  }, deps);
  const node = {
    transportKind,
    name: identity.name,
    id: identity.nodeId
  };
  if (endpoint) node.endpoint = endpoint;

  if (String(options.provider || '').trim()) node.provider = String(options.provider || '').trim();
  if (String(options.routeRole || '').trim() && String(options.routeRole || '').trim() !== 'data-plane') {
    node.routeRole = String(options.routeRole || '').trim();
  }
  if (String(options.trustLevel || '').trim()) node.trustLevel = String(options.trustLevel || '').trim();
  if (managementKey) node.managementKey = managementKey;

  return {
    inviteUrl,
    requestBody: { node }
  };
}

async function readJoinResponse(response) {
  if (!response) return {};
  if (typeof response.json === 'function') {
    try {
      return await response.json();
    } catch (_error) {
      return {};
    }
  }
  if (typeof response.text === 'function') {
    const text = await response.text().catch(() => '');
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (_error) {
      return {};
    }
  }
  return {};
}

function buildJoinFailure(response, payload) {
  const code = String((payload && payload.error) || 'node_join_failed');
  const message = String((payload && payload.message) || code);
  const error = new Error(message);
  error.code = code;
  error.statusCode = response && response.status;
  return error;
}

async function runNodeJoin(rawArgs = [], deps = {}) {
  const options = parseNodeJoinArgs(rawArgs);
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    const error = new Error('fetch_unavailable');
    error.code = 'fetch_unavailable';
    throw error;
  }

  const join = buildNodeJoinPayload(options, deps);
  const response = await fetchImpl(join.inviteUrl.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(join.requestBody)
  });
  const payload = await readJoinResponse(response);
  if (!response || !response.ok || !payload.ok) {
    throw buildJoinFailure(response, payload);
  }

  return {
    ok: true,
    json: Boolean(options.json),
    node: payload.node || null,
    invite: payload.invite || null,
    endpoint: join.requestBody.node.endpoint || '',
    transportKind: join.requestBody.node.transportKind
  };
}

module.exports = {
  parseNodeJoinArgs,
  isLoopbackHost,
  isWildcardHost,
  parseIpv4,
  isOverlayIpv4,
  isPrivateIpv4,
  isReservedIpv4,
  scoreInterfaceAddress,
  selectAdvertisedHost,
  parseInviteUrl,
  buildNodeJoinPayload,
  runNodeJoin
};
