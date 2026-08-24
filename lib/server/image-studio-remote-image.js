'use strict';

const dns = require('node:dns');
const net = require('node:net');
const { Agent } = require('undici');
const { detectImageMime, normalizeImageMime } = require('./image-data');
const {
  extractEmbeddedIpv4,
  ipv4FromHexWords,
  normalizeIpAddress
} = require('./ip-address-encoding');

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_READ_TIMEOUT_MS = 120000;

const BLOCKED_REMOTE_IMAGE_ADDRESSES = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]) BLOCKED_REMOTE_IMAGE_ADDRESSES.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8]
]) BLOCKED_REMOTE_IMAGE_ADDRESSES.addSubnet(address, prefix, 'ipv6');

function remoteImageError(statusCode, code, detail, cause) {
  const error = new Error(String(detail || code || 'image_asset_fetch_failed'), cause ? { cause } : undefined);
  error.name = 'ImageStudioRemoteImageError';
  error.statusCode = Number(statusCode) || 502;
  error.code = String(code || 'image_asset_fetch_failed');
  error.detail = String(detail || error.message);
  return error;
}

function parseRemoteImageUrl(value, baseUrl) {
  let url;
  try {
    url = baseUrl ? new URL(String(value || ''), baseUrl) : new URL(String(value || ''));
  } catch (_error) {
    throw remoteImageError(502, 'invalid_image_output_url', 'generated image URL is malformed');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw remoteImageError(502, 'invalid_image_output_url', 'generated image URL must use HTTP or HTTPS without credentials');
  }
  return url;
}

function isBlockedRemoteImageAddress(value) {
  const address = normalizeIpAddress(value);
  const embeddedIpv4 = extractEmbeddedIpv4(address);
  if (embeddedIpv4 && isBlockedRemoteImageAddress(embeddedIpv4)) return true;
  const family = net.isIP(address);
  if (!family) return false;
  return BLOCKED_REMOTE_IMAGE_ADDRESSES.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

async function defaultResolveHost(hostname) {
  const normalized = normalizeIpAddress(hostname);
  if (net.isIP(normalized)) return [normalized];
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function normalizeTrustedOrigins(values) {
  const origins = new Set();
  (Array.isArray(values) ? values : []).forEach((value) => {
    try {
      origins.add(new URL(String(value || '')).origin.toLowerCase());
    } catch (_error) {}
  });
  return origins;
}

function normalizeResolvedAddresses(values) {
  const seen = new Set();
  const addresses = [];
  (Array.isArray(values) ? values : [values]).forEach((entry) => {
    const address = normalizeIpAddress(entry && entry.address || entry);
    const family = Number(entry && entry.family) || net.isIP(address);
    if (!address || ![4, 6].includes(family)) return;
    const key = `${family}:${address}`;
    if (seen.has(key)) return;
    seen.add(key);
    addresses.push({ address, family });
  });
  return addresses;
}

function createPinnedLookup(expectedHostname, addresses) {
  const expected = normalizeIpAddress(expectedHostname);
  const records = normalizeResolvedAddresses(addresses);
  return (hostname, lookupOptions, callback) => {
    const actual = normalizeIpAddress(hostname);
    const options = typeof lookupOptions === 'number'
      ? { family: lookupOptions }
      : lookupOptions || {};
    const family = Number(options.family) || 0;
    const candidates = records.filter((record) => family === 0 || record.family === family);
    if (actual !== expected || candidates.length < 1) {
      const error = new Error(`pinned DNS lookup rejected ${String(hostname || '')}`);
      error.code = 'ENOTFOUND';
      callback(error);
      return;
    }
    if (options.all) {
      callback(null, candidates.map((record) => ({ ...record })));
      return;
    }
    callback(null, candidates[0].address, candidates[0].family);
  };
}

function createPinnedDispatcher(input) {
  return new Agent({
    connect: {
      lookup: createPinnedLookup(input.hostname, input.addresses)
    }
  });
}

async function closeDispatcher(dispatcher) {
  if (!dispatcher) return;
  try {
    if (typeof dispatcher.close === 'function') await dispatcher.close();
    else if (typeof dispatcher.destroy === 'function') dispatcher.destroy();
  } catch (_error) {}
}

async function enforceRemoteImageUrlPolicy(url, options = {}) {
  const trustedOrigins = normalizeTrustedOrigins(options.trustedOrigins);
  const trusted = trustedOrigins.has(url.origin.toLowerCase());
  const hostname = normalizeIpAddress(url.hostname);
  if (!trusted && ['metadata.google.internal', 'metadata.aws.internal'].includes(hostname)) {
    throw remoteImageError(502, 'image_asset_url_blocked', 'generated image URL resolves to a blocked host');
  }
  let addresses;
  try {
    addresses = await (options.resolveHost || defaultResolveHost)(hostname);
  } catch (error) {
    throw remoteImageError(502, 'image_asset_host_resolution_failed', 'generated image host could not be resolved', error);
  }
  const normalizedAddresses = normalizeResolvedAddresses(addresses);
  if (normalizedAddresses.length < 1) {
    throw remoteImageError(502, 'image_asset_host_resolution_failed', 'generated image host resolved to no addresses');
  }
  if (!trusted && (isBlockedRemoteImageAddress(hostname)
    || normalizedAddresses.some((entry) => isBlockedRemoteImageAddress(entry.address)))) {
    throw remoteImageError(502, 'image_asset_url_blocked', 'generated image URL resolves to a blocked address');
  }
  return normalizedAddresses;
}

function readHeader(response, name) {
  if (response && response.headers && typeof response.headers.get === 'function') {
    return response.headers.get(name);
  }
  const headers = response && response.headers && typeof response.headers === 'object' ? response.headers : {};
  return headers[String(name || '').toLowerCase()] || headers[name] || null;
}

async function disposeResponseBody(body) {
  if (!body) return;
  try {
    if (typeof body.cancel === 'function') await body.cancel();
    else if (typeof body.destroy === 'function') body.destroy();
  } catch (_error) {}
}

async function readArrayBufferWithDeadline(response, body, timeoutMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(remoteImageError(
      504,
      'image_asset_read_timeout',
      'generated image body timed out'
    )), timeoutMs);
  });
  try {
    return await Promise.race([response.arrayBuffer(), deadline]);
  } catch (error) {
    await disposeResponseBody(body);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedChunks(source, maxBytes, timeoutMs) {
  const chunks = [];
  let totalBytes = 0;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(remoteImageError(504, 'image_asset_read_timeout', 'generated image body timed out')), timeoutMs);
  });
  try {
    for (;;) {
      const entry = await Promise.race([source.next(), timeout]);
      if (entry.done) return Buffer.concat(chunks, totalBytes);
      const chunk = Buffer.isBuffer(entry.value) ? entry.value : Buffer.from(entry.value || []);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        throw remoteImageError(413, 'image_asset_too_large', 'generated image exceeds the configured size limit');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    try { await source.cancel(error); } catch (_cancelError) {}
    throw error;
  } finally {
    clearTimeout(timer);
    source.release();
  }
}

async function readResponseBytes(response, maxBytes, timeoutMs = DEFAULT_READ_TIMEOUT_MS) {
  const contentLength = Number(readHeader(response, 'content-length')) || 0;
  if (contentLength > maxBytes) {
    await disposeResponseBody(response && response.body);
    throw remoteImageError(413, 'image_asset_too_large', 'generated image exceeds the configured size limit');
  }
  const body = response && response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    return readBoundedChunks({
      next: () => reader.read(),
      cancel: (reason) => typeof reader.cancel === 'function' ? reader.cancel(reason) : undefined,
      release: () => {
        try { reader.releaseLock && reader.releaseLock(); } catch (_error) {}
      }
    }, maxBytes, timeoutMs);
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const iterator = body[Symbol.asyncIterator]();
    return readBoundedChunks({
      next: () => iterator.next(),
      cancel: (reason) => typeof iterator.return === 'function' ? iterator.return(reason) : disposeResponseBody(body),
      release: () => {}
    }, maxBytes, timeoutMs);
  }
  if (!response || typeof response.arrayBuffer !== 'function') {
    throw remoteImageError(502, 'invalid_image_output', 'generated image response body is unavailable');
  }
  const bytes = Buffer.from(await readArrayBufferWithDeadline(response, body, timeoutMs));
  if (bytes.length > maxBytes) {
    throw remoteImageError(413, 'image_asset_too_large', 'generated image exceeds the configured size limit');
  }
  return bytes;
}

function isRedirectStatus(status) {
  return status >= 300 && status < 400;
}

async function fetchRemoteImage(options = {}) {
  const fetchWithTimeout = options.fetchWithTimeout;
  if (typeof fetchWithTimeout !== 'function') {
    throw remoteImageError(500, 'image_asset_transport_unavailable', 'image asset transport is not configured');
  }
  const maxBytes = Math.max(1, Number(options.maxBytes) || 1);
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_READ_TIMEOUT_MS);
  const maxRedirects = Math.max(0, Number(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS));
  let currentUrl = parseRemoteImageUrl(options.url);
  const initialProtocol = currentUrl.protocol;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const addresses = await enforceRemoteImageUrlPolicy(currentUrl, options);
    let dispatcher;
    try {
      dispatcher = (options.createPinnedDispatcher || createPinnedDispatcher)({
        hostname: normalizeIpAddress(currentUrl.hostname),
        addresses
      });
    } catch (error) {
      throw remoteImageError(502, 'image_asset_transport_unavailable', 'generated image transport could not pin its DNS target', error);
    }
    let response;
    try {
      response = await fetchWithTimeout(currentUrl.toString(), {
        method: 'GET',
        headers: { accept: 'image/*' },
        redirect: 'manual',
        // Supplying the vetted dispatcher also prevents fetchWithTimeout from
        // replacing it with a proxy dispatcher that would resolve DNS again.
        dispatcher
      }, timeoutMs, options.proxyOptions || {});
    } catch (error) {
      await closeDispatcher(dispatcher);
      throw remoteImageError(502, 'image_asset_fetch_failed', `generated image fetch failed: ${String(error && error.message || error)}`, error);
    }

    const status = Number(response && response.status) || 0;
    if (isRedirectStatus(status)) {
      const location = readHeader(response, 'location');
      await disposeResponseBody(response && response.body);
      await closeDispatcher(dispatcher);
      if (!location) throw remoteImageError(502, 'image_asset_redirect_invalid', 'generated image redirect is missing a location');
      if (redirectCount >= maxRedirects) {
        throw remoteImageError(502, 'image_asset_redirect_limit', 'generated image exceeded the redirect limit');
      }
      const redirectedUrl = parseRemoteImageUrl(location, currentUrl);
      if (initialProtocol === 'https:' && redirectedUrl.protocol !== 'https:') {
        throw remoteImageError(502, 'image_asset_url_blocked', 'generated image redirect downgraded from HTTPS');
      }
      currentUrl = redirectedUrl;
      continue;
    }

    if (status < 200 || status >= 300) {
      await disposeResponseBody(response && response.body);
      await closeDispatcher(dispatcher);
      throw remoteImageError(502, 'image_asset_fetch_failed', `generated image URL returned HTTP ${status}`);
    }
    let bytes;
    try {
      bytes = await readResponseBytes(response, maxBytes, timeoutMs);
    } finally {
      await closeDispatcher(dispatcher);
    }
    if (bytes.length < 1) throw remoteImageError(502, 'empty_image_output', 'generated image output is empty');
    const detectedMimeType = detectImageMime(bytes);
    if (!detectedMimeType) {
      throw remoteImageError(502, 'invalid_image_output', 'generated image response is not a supported image');
    }
    const declaredMimeType = normalizeImageMime(readHeader(response, 'content-type'));
    if (declaredMimeType && declaredMimeType !== detectedMimeType) {
      throw remoteImageError(502, 'invalid_image_output', 'generated image response mime type does not match its bytes');
    }
    return { bytes, mimeType: detectedMimeType, url: currentUrl.toString() };
  }
  throw remoteImageError(502, 'image_asset_redirect_limit', 'generated image exceeded the redirect limit');
}

module.exports = {
  fetchRemoteImage,
  __private: {
    DEFAULT_MAX_REDIRECTS,
    DEFAULT_READ_TIMEOUT_MS,
    enforceRemoteImageUrlPolicy,
    createPinnedDispatcher,
    createPinnedLookup,
    extractEmbeddedIpv4,
    ipv4FromHexWords,
    isBlockedRemoteImageAddress,
    normalizeResolvedAddresses,
    normalizeTrustedOrigins,
    parseRemoteImageUrl,
    readArrayBufferWithDeadline,
    readResponseBytes,
    remoteImageError
  }
};
