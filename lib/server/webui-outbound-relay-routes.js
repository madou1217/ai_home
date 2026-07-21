'use strict';

const {
  readOutboundRelayConfig,
  toPublicOutboundRelayConfig,
  writeOutboundRelayConfig
} = require('./outbound-relay-config-store');

const OUTBOUND_RELAY_PATH = '/v0/webui/server-routes/relays';

function normalizeText(value, maxLength = 256) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeEndpoint(value) {
  try {
    const url = new URL(normalizeText(value, 2048));
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return '';
    if (url.username || url.password) return '';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch (_error) {
    return '';
  }
}

function routeIo(ctx = {}) {
  const deps = ctx.deps || {};
  return {
    readRequestBody: ctx.readRequestBody || deps.readRequestBody,
    writeJson: ctx.writeJson || deps.writeJson
  };
}

function storeDeps(ctx = {}) {
  const deps = ctx.deps || {};
  return { ...deps, fs: ctx.fs || deps.fs, aiHomeDir: deps.aiHomeDir };
}

function readPrivateConfig(ctx) {
  const deps = ctx.deps || {};
  const read = deps.readOutboundRelayConfig || readOutboundRelayConfig;
  return read(storeDeps(ctx));
}

function projectPublicConfig(ctx, config) {
  const deps = ctx.deps || {};
  const project = deps.toPublicOutboundRelayConfig || toPublicOutboundRelayConfig;
  return project(config);
}

function runtimeSnapshot(ctx) {
  const manager = ctx.deps && ctx.deps.outboundRelayManager;
  return manager && typeof manager.getSnapshot === 'function'
    ? manager.getSnapshot()
    : { running: false, relays: [] };
}

function writeNoStoreHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
}

async function readPayload(ctx) {
  const { readRequestBody } = routeIo(ctx);
  if (typeof readRequestBody !== 'function') return null;
  try {
    const body = await readRequestBody(ctx.req, { maxBytes: 128 * 1024 });
    return body && body.length > 0 ? JSON.parse(body.toString('utf8')) : null;
  } catch (_error) {
    return null;
  }
}

function mergeExistingManagementKeys(payload, current) {
  const source = payload && typeof payload === 'object' && Array.isArray(payload.relays)
    ? payload.relays
    : null;
  if (!source) return payload;
  const currentByEndpoint = new Map((Array.isArray(current && current.relays) ? current.relays : [])
    .map((relay) => [normalizeEndpoint(relay.endpoint), relay]));
  return {
    relays: source.map((relay) => {
      const input = relay && typeof relay === 'object' ? { ...relay } : {};
      if (normalizeText(input.managementKey, 4096)) return input;
      const previous = currentByEndpoint.get(normalizeEndpoint(input.endpoint));
      if (previous && previous.managementKey) input.managementKey = previous.managementKey;
      return input;
    })
  };
}

function errorStatus(code) {
  if (code === 'outbound_relay_config_write_failed') return 500;
  return 400;
}

async function handleGet(ctx) {
  const { writeJson } = routeIo(ctx);
  try {
    const config = readPrivateConfig(ctx);
    writeJson(ctx.res, 200, {
      ok: true,
      config: projectPublicConfig(ctx, config),
      runtime: runtimeSnapshot(ctx)
    });
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: normalizeText(error && error.code, 96) || 'outbound_relay_config_read_failed'
    });
  }
  return true;
}

async function handleUpdate(ctx) {
  const deps = ctx.deps || {};
  const { writeJson } = routeIo(ctx);
  writeNoStoreHeaders(ctx.res);
  const payload = await readPayload(ctx);
  if (!payload) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_outbound_relay_config' });
    return true;
  }
  try {
    const current = readPrivateConfig(ctx);
    const privateInput = mergeExistingManagementKeys(payload, current);
    const write = deps.writeOutboundRelayConfig || writeOutboundRelayConfig;
    const saved = write(privateInput, storeDeps(ctx));
    const manager = deps.outboundRelayManager;
    const runtime = manager && typeof manager.update === 'function'
      ? await manager.update(saved)
      : runtimeSnapshot(ctx);
    writeJson(ctx.res, 200, {
      ok: true,
      config: projectPublicConfig(ctx, saved),
      runtime
    });
    return true;
  } catch (error) {
    const code = normalizeText(error && error.code, 96) || 'invalid_outbound_relay_config';
    writeJson(ctx.res, errorStatus(code), { ok: false, error: code });
    return true;
  }
}

async function handleWebUiOutboundRelayRoutes(ctx = {}) {
  if (ctx.pathname !== OUTBOUND_RELAY_PATH) return false;
  const method = String(ctx.method || 'GET').toUpperCase();
  if (method === 'GET') return handleGet(ctx);
  if (method === 'PUT' || method === 'POST') return handleUpdate(ctx);
  return false;
}

module.exports = {
  OUTBOUND_RELAY_PATH,
  handleWebUiOutboundRelayRoutes,
  mergeExistingManagementKeys,
  normalizeEndpoint
};
