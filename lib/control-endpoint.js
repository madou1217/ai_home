'use strict';

const DEFAULT_LOOPBACK_CONTROL_ENDPOINT_WARNING = 'Control Endpoint points to loopback; phones and remote targets will treat it as themselves. Use a LAN, overlay, FRP, tunnel, or public Control Endpoint before pairing or bootstrap.';

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}

function isLoopbackHost(value) {
  const host = normalizeHost(value);
  return host === 'localhost'
    || host === '::1'
    || host === '0:0:0:0:0:0:0:1'
    || /^127(?:\.|$)/.test(host);
}

function parseControlEndpoint(value) {
  try {
    return new URL(String(value || '').trim());
  } catch (_error) {
    return null;
  }
}

function isLoopbackControlEndpoint(value) {
  const parsed = parseControlEndpoint(value);
  return parsed ? isLoopbackHost(parsed.hostname) : false;
}

function getLoopbackControlEndpointWarning(value, message = DEFAULT_LOOPBACK_CONTROL_ENDPOINT_WARNING) {
  return isLoopbackControlEndpoint(value) ? String(message || '').trim() : '';
}

module.exports = {
  DEFAULT_LOOPBACK_CONTROL_ENDPOINT_WARNING,
  normalizeHost,
  isLoopbackHost,
  isLoopbackControlEndpoint,
  getLoopbackControlEndpointWarning
};
