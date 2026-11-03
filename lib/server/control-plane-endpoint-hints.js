'use strict';

const os = require('node:os');
const {
  normalizeHost,
  isLoopbackHost
} = require('../control-endpoint');

function firstHeaderValue(headers, name) {
  const key = String(name || '').toLowerCase();
  const value = headers && (headers[key] || headers[name]);
  return String(Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();
}

function normalizeProto(value) {
  const proto = String(value || '').split(',')[0].trim().toLowerCase().replace(/:$/, '');
  return proto === 'https' ? 'https' : 'http';
}

function inferControlEndpoint(ctx) {
  const headers = ctx.req && ctx.req.headers ? ctx.req.headers : {};
  const host = firstHeaderValue(headers, 'x-forwarded-host') || firstHeaderValue(headers, 'host');
  if (!host) return '';
  return `${normalizeProto(firstHeaderValue(headers, 'x-forwarded-proto'))}://${host}`;
}

function parseUrl(value) {
  try {
    return new URL(String(value || '').trim());
  } catch (_error) {
    return null;
  }
}

function isWildcardHost(value) {
  const host = normalizeHost(value);
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

function isLinkLocalIPv4(value) {
  return /^169\.254\./.test(String(value || '').trim());
}

function parseIPv4Octets(value) {
  const parts = String(value || '').trim().split('.');
  if (parts.length !== 4) return [];
  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) return -1;
    return Number(part);
  });
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : [];
}

function isSpecialUseIPv4(value) {
  const [a, b, c] = parseIPv4Octets(value);
  if (!Number.isInteger(a)) return true;
  if (a === 0 || a >= 224) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

function isUsableLanIPv4(value) {
  const address = String(value || '').trim();
  return Boolean(address)
    && !isLoopbackHost(address)
    && !isLinkLocalIPv4(address)
    && !isSpecialUseIPv4(address)
    && address !== '0.0.0.0';
}

function listLanIPv4Candidates(networkInterfaces) {
  const interfaces = typeof networkInterfaces === 'function' ? networkInterfaces() : {};
  const seen = new Set();
  const candidates = [];

  Object.entries(interfaces || {}).forEach(([name, entries]) => {
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
      const family = entry && entry.family;
      const address = String(entry && entry.address || '').trim();
      if (!(family === 'IPv4' || family === 4)) return;
      if (entry.internal || !isUsableLanIPv4(address) || seen.has(address)) return;
      seen.add(address);
      candidates.push({ address, name: String(name || '').trim() });
    });
  });

  return candidates;
}

function resolvePort(url, ctx) {
  const explicit = Number(url && url.port);
  if (Number.isInteger(explicit) && explicit > 0 && explicit <= 65535) return explicit;

  const configured = Number(ctx && ctx.options && ctx.options.port);
  if (Number.isInteger(configured) && configured > 0 && configured <= 65535) return configured;

  return 0;
}

function formatEndpoint(protocol, host, port) {
  const normalizedProtocol = normalizeProto(protocol);
  const suffix = port ? `:${port}` : '';
  return `${normalizedProtocol}://${host}${suffix}`;
}

function addWarning(warnings, value) {
  const warning = String(value || '').trim();
  if (warning && !warnings.includes(warning)) warnings.push(warning);
}

function addHint(hints, hint) {
  const endpoint = String(hint && hint.endpoint || '').replace(/\/+$/, '');
  if (!endpoint || hints.some((item) => item.endpoint === endpoint)) return;
  hints.push({
    ...hint,
    endpoint
  });
}

function canLanReachBindHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  return isWildcardHost(normalized) || (!isLoopbackHost(normalized) && isUsableLanIPv4(normalized));
}

function buildControlPlaneEndpointHints(ctx) {
  const hints = [];
  const warnings = [];
  const requestEndpoint = inferControlEndpoint(ctx);
  const requestUrl = parseUrl(requestEndpoint);
  const requestHost = requestUrl ? requestUrl.hostname : '';
  const requestIsLoopback = isLoopbackHost(requestHost);
  const bindHost = ctx && ctx.options ? ctx.options.host : '';
  const lanReachableBind = canLanReachBindHost(bindHost);

  if (requestEndpoint) {
    if (requestIsLoopback) {
      addWarning(warnings, '当前浏览器地址是 localhost，只适合同机访问，手机不能直接使用。');
    }
    addHint(hints, {
      endpoint: requestEndpoint,
      source: 'request',
      label: '当前浏览器地址',
      warning: requestIsLoopback ? 'localhost 只适合同机访问。' : '',
      recommended: !requestIsLoopback
    });
  }

  const protocol = requestUrl ? requestUrl.protocol : 'http:';
  const port = resolvePort(requestUrl, ctx);
  const networkInterfaces = ctx && ctx.deps && ctx.deps.networkInterfaces
    ? ctx.deps.networkInterfaces
    : os.networkInterfaces;
  const shouldIncludeLan = requestIsLoopback || lanReachableBind;
  const lanCandidates = shouldIncludeLan ? listLanIPv4Candidates(networkInterfaces) : [];

  if (requestIsLoopback && lanCandidates.length === 0) {
    addWarning(warnings, '没有发现可用于手机访问的局域网 IPv4 地址。');
  }

  if (lanCandidates.length > 0 && !lanReachableBind) {
    addWarning(warnings, '当前服务可能只监听本机地址；手机使用局域网候选前需要开启开放网络或接入隧道。');
  }

  lanCandidates.slice(0, 8).forEach((candidate) => {
    addHint(hints, {
      endpoint: formatEndpoint(protocol, candidate.address, port),
      source: 'lan',
      label: candidate.name ? `局域网候选 ${candidate.name}` : '局域网候选',
      warning: lanReachableBind
        ? '需要手机与 Server 在同一网络，并允许防火墙访问。'
        : '当前服务可能只监听本机地址。',
      recommended: requestIsLoopback && lanReachableBind
    });
  });

  return {
    endpoints: hints,
    warnings
  };
}

module.exports = {
  buildControlPlaneEndpointHints,
  inferControlEndpoint,
  isLoopbackHost,
  listLanIPv4Candidates
};
