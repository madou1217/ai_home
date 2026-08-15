'use strict';

const dns = require('node:dns');
const net = require('node:net');
const { Agent, request } = require('undici');

const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_REDIRECTS = 3;

const BLOCKED_SUBSCRIPTION_ADDRESSES = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]) BLOCKED_SUBSCRIPTION_ADDRESSES.addSubnet(address, prefix, 'ipv4');
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
]) BLOCKED_SUBSCRIPTION_ADDRESSES.addSubnet(address, prefix, 'ipv6');

function subscriptionError(code, message = code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function parseSubscriptionUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch (_error) {
    throw subscriptionError('invalid_subscription_url');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw subscriptionError('invalid_subscription_url');
  }
  if (url.username || url.password) {
    throw subscriptionError('subscription_url_credentials_not_allowed');
  }
  return url;
}

function normalizeIpAddress(value) {
  return String(value || '').replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
}

function isBlockedMetadataAddress(value) {
  const address = normalizeIpAddress(value);
  if (net.isIPv4(address)) {
    const octets = address.split('.').map(Number);
    return octets[0] === 169 && octets[1] === 254;
  }
  if (address.startsWith('::ffff:')) return isBlockedMetadataAddress(address.slice(7));
  if (net.isIPv6(address)) {
    const first = Number.parseInt(address.split(':')[0] || '0', 16);
    return first >= 0xfe80 && first <= 0xfebf;
  }
  return false;
}

function isBlockedSubscriptionAddress(value) {
  const address = normalizeIpAddress(value);
  if (address.startsWith('::ffff:')) return true;
  const family = net.isIP(address);
  if (!family) return false;
  return BLOCKED_SUBSCRIPTION_ADDRESSES.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

async function defaultResolveHost(hostname) {
  if (net.isIP(normalizeIpAddress(hostname))) return [normalizeIpAddress(hostname)];
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function enforceUrlPolicy(url, options = {}) {
  const hostname = normalizeIpAddress(url.hostname);
  if (['metadata.google.internal', 'metadata.aws.internal'].includes(hostname)) {
    throw subscriptionError('subscription_url_blocked');
  }
  let addresses;
  try {
    addresses = await (options.resolveHost || defaultResolveHost)(hostname);
  } catch (error) {
    throw subscriptionError('subscription_host_resolution_failed', error.message, error);
  }
  const normalizedAddresses = (Array.isArray(addresses) ? addresses : [addresses])
    .map((entry) => normalizeIpAddress(entry?.address || entry))
    .filter(Boolean);
  if (!normalizedAddresses.length) {
    throw subscriptionError('subscription_host_resolution_failed');
  }
  if (isBlockedSubscriptionAddress(hostname) || normalizedAddresses.some(isBlockedSubscriptionAddress)) {
    throw subscriptionError('subscription_url_blocked');
  }
  if (options.urlPolicy) {
    const policyResult = await options.urlPolicy(url, { addresses: normalizedAddresses });
    if (policyResult === false || policyResult?.allowed === false) {
      throw subscriptionError(policyResult?.error || 'subscription_url_blocked');
    }
  }
  return normalizedAddresses;
}

function createPinnedDispatcher(addresses) {
  const records = addresses.map((address) => ({ address, family: net.isIP(address) }));
  return new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        if (options?.all) {
          callback(null, records);
          return;
        }
        callback(null, records[0].address, records[0].family);
      }
    }
  });
}

async function closeDispatcher(dispatcher) {
  if (!dispatcher) return;
  try {
    if (typeof dispatcher.close === 'function') await dispatcher.close();
    else dispatcher.destroy?.();
  } catch (_error) {
    try { dispatcher.destroy?.(); } catch (_destroyError) { /* best effort */ }
  }
}

async function disposeResponseBody(body) {
  if (!body) return;
  try {
    if (typeof body.dump === 'function') {
      await body.dump();
      return;
    }
    if (typeof body.destroy === 'function') {
      body.destroy();
      return;
    }
    if (typeof body.text === 'function') await body.text();
  } catch (_error) {
    try { body.destroy?.(); } catch (_destroyError) { /* best effort */ }
  }
}

async function readResponseBody(body, maxBytes) {
  const chunks = [];
  let totalBytes = 0;
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        body.destroy?.();
        throw subscriptionError('subscription_response_too_large');
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  }
  if (body && typeof body.text === 'function') {
    const text = await body.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw subscriptionError('subscription_response_too_large');
    return text;
  }
  throw subscriptionError('subscription_response_body_unavailable');
}

class SubscriptionFetcher {
  constructor(options = {}) {
    this.requestImpl = options.requestImpl || request;
    this.resolveHost = options.resolveHost || defaultResolveHost;
    this.urlPolicy = options.urlPolicy || null;
    this.dispatcherFactory = options.dispatcherFactory || createPinnedDispatcher;
    this.maxResponseBytes = Number(options.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES);
    this.timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
    this.maxRedirects = Number(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS);
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) throw subscriptionError('invalid_subscription_response_limit');
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) throw subscriptionError('invalid_subscription_timeout');
    if (!Number.isInteger(this.maxRedirects) || this.maxRedirects < 0) throw subscriptionError('invalid_subscription_redirect_limit');
  }

  async fetch(value) {
    let currentUrl = parseSubscriptionUrl(value);
    const initialProtocol = currentUrl.protocol;
    for (let redirectCount = 0; redirectCount <= this.maxRedirects; redirectCount += 1) {
      const addresses = await enforceUrlPolicy(currentUrl, {
        resolveHost: this.resolveHost,
        urlPolicy: this.urlPolicy
      });
      const dispatcher = this.dispatcherFactory(addresses);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      timeout.unref?.();
      let response;
      try {
        try {
          response = await this.requestImpl(currentUrl.toString(), {
            method: 'GET',
            headers: {
              'User-Agent': 'AI-Home-Proxy-Pool/1.0',
              Accept: 'text/plain, application/yaml, application/json;q=0.9, */*;q=0.1'
            },
            headersTimeout: this.timeoutMs,
            bodyTimeout: this.timeoutMs,
            maxRedirections: 0,
            signal: controller.signal,
            dispatcher
          });
        } catch (error) {
          const code = error.name === 'AbortError' ? 'subscription_fetch_timeout' : 'subscription_fetch_failed';
          throw subscriptionError(code, error.message, error);
        }

        const statusCode = Number(response.statusCode || 0);
        if (statusCode >= 300 && statusCode < 400) {
          const location = response.headers?.location;
          await disposeResponseBody(response.body);
          if (!location) throw subscriptionError('subscription_redirect_without_location');
          if (redirectCount >= this.maxRedirects) throw subscriptionError('subscription_redirect_limit_exceeded');
          const redirectedUrl = parseSubscriptionUrl(new URL(location, currentUrl).toString());
          if (initialProtocol === 'https:' && redirectedUrl.protocol !== 'https:') {
            throw subscriptionError('subscription_redirect_downgrade_blocked');
          }
          currentUrl = redirectedUrl;
          continue;
        }

        if (statusCode < 200 || statusCode >= 300) {
          await disposeResponseBody(response.body);
          throw subscriptionError('subscription_http_error', `subscription_http_${statusCode}`);
        }
        const contentLength = Number(response.headers?.['content-length']);
        if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
          await disposeResponseBody(response.body);
          throw subscriptionError('subscription_response_too_large');
        }
        try {
          const content = await readResponseBody(response.body, this.maxResponseBytes);
          return { ok: true, content, url: currentUrl.toString(), statusCode };
        } catch (error) {
          if (error.code) throw error;
          const code = error.name === 'AbortError' ? 'subscription_fetch_timeout' : 'subscription_fetch_failed';
          throw subscriptionError(code, error.message, error);
        }
      } finally {
        clearTimeout(timeout);
        await closeDispatcher(dispatcher);
      }
    }
    throw subscriptionError('subscription_redirect_limit_exceeded');
  }
}

module.exports = {
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  SubscriptionFetcher,
  closeDispatcher,
  createPinnedDispatcher,
  disposeResponseBody,
  enforceUrlPolicy,
  isBlockedMetadataAddress,
  isBlockedSubscriptionAddress,
  parseSubscriptionUrl,
  readResponseBody
};
