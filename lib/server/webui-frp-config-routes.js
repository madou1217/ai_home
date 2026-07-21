'use strict';

const path = require('node:path');
const net = require('node:net');

const {
  listManagedFrpRoutes,
  removeManagedFrpRoute,
  upsertManagedFrpRoute
} = require('./frp-route-registry');
const {
  verifyFrpVisitorIdentity
} = require('./frp-proxy-router');
const {
  validateCanonicalFabricServerId
} = require('./fabric-server-id');

const FRP_STATUS_PATHS = new Set([
  '/v0/webui/server-routes/frp',
  '/v0/webui/server-routes/frp/status'
]);
const FRP_APPLY_PATH = '/v0/webui/server-routes/frp/apply';
const FRP_REMOVE_PATH = '/v0/webui/server-routes/frp/remove';
const DEFAULT_VISITOR_VERIFY_ATTEMPTS = 5;
const DEFAULT_VISITOR_VERIFY_RETRY_DELAY_MS = 250;
const DEFAULT_VISITOR_VERIFY_TIMEOUT_MS = 1_000;
const frpRouteMutationTails = new Map();

function normalizeText(value, maxLength = 256) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function writeNoStoreHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
}

function routeIo(ctx = {}) {
  const deps = ctx.deps || {};
  return {
    readRequestBody: ctx.readRequestBody || deps.readRequestBody,
    writeJson: ctx.writeJson || deps.writeJson
  };
}

function registryContext(ctx = {}) {
  const deps = ctx.deps || {};
  return {
    fs: ctx.fs || deps.fs,
    aiHomeDir: deps.aiHomeDir
  };
}

function registryDeps(deps = {}) {
  return {
    readJsonValue: deps.readJsonValue,
    writeJsonValue: deps.writeJsonValue,
    nowMs: deps.nowMs
  };
}

function listVisitors(ctx) {
  const deps = ctx.deps || {};
  if (typeof deps.listFrpVisitorRoutes === 'function') {
    return deps.listFrpVisitorRoutes();
  }
  return listManagedFrpRoutes(registryContext(ctx), registryDeps(deps));
}

function saveVisitor(ctx, route) {
  const deps = ctx.deps || {};
  if (typeof deps.saveFrpVisitorRoute === 'function') return deps.saveFrpVisitorRoute(route);
  return upsertManagedFrpRoute(route, registryContext(ctx), registryDeps(deps));
}

function removeVisitor(ctx, stableServerId) {
  const deps = ctx.deps || {};
  if (typeof deps.removeFrpVisitorRoute === 'function') {
    return deps.removeFrpVisitorRoute(stableServerId);
  }
  return removeManagedFrpRoute(
    stableServerId,
    registryContext(ctx),
    registryDeps(deps)
  );
}

function findVisitor(ctx, stableServerId) {
  return listVisitors(ctx).find((route) => route.stableServerId === stableServerId) || null;
}

function restoreVisitor(ctx, stableServerId, previousVisitor) {
  return previousVisitor
    ? saveVisitor(ctx, previousVisitor)
    : removeVisitor(ctx, stableServerId);
}

async function validateAndCommitVisitor(ctx, input, visitor, previousVisitor) {
  let registryMutationStarted = false;
  try {
    await verifyVisitorRoute(ctx, visitor);
    registryMutationStarted = true;
    return saveVisitor(ctx, {
      stableServerId: input.stableServerId,
      name: input.name,
      bindPort: input.bindPort,
      health: 'healthy'
    });
  } catch (cause) {
    if (registryMutationStarted) {
      try {
        restoreVisitor(ctx, input.stableServerId, previousVisitor);
      } catch (_error) {
        const error = new Error('frp_visitor_registry_rollback_failed');
        error.code = 'frp_visitor_registry_rollback_failed';
        throw error;
      }
    }
    throw cause;
  }
}

function discoverConfig(ctx) {
  const deps = ctx.deps || {};
  if (typeof deps.discoverFrpcConfigPath !== 'function') return '';
  try {
    return normalizeText(deps.discoverFrpcConfigPath({}, deps), 2048);
  } catch (_error) {
    return '';
  }
}

async function readJsonPayload(ctx) {
  const { readRequestBody } = routeIo(ctx);
  if (typeof readRequestBody !== 'function') return null;
  try {
    const body = await readRequestBody(ctx.req, { maxBytes: 32 * 1024 });
    return body && body.length > 0 ? JSON.parse(body.toString('utf8')) : null;
  } catch (_error) {
    return null;
  }
}

function normalizePort(value, fallback = 0) {
  const port = Number(value == null || value === '' ? fallback : value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

async function serializeFrpRouteMutation(input, operation) {
  const key = `${input.role}:${input.stableServerId}`;
  const previous = frpRouteMutationTails.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  frpRouteMutationTails.set(key, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (frpRouteMutationTails.get(key) === current) frpRouteMutationTails.delete(key);
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function waitForRetry(delayMs, deps) {
  if (delayMs <= 0) return Promise.resolve();
  if (typeof deps.waitForFrpVisitorRetry === 'function') {
    return Promise.resolve(deps.waitForFrpVisitorRetry(delayMs));
  }
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function verifyVisitorRoute(ctx, visitor) {
  const deps = ctx.deps || {};
  const verify = typeof deps.verifyFrpVisitorIdentity === 'function'
    ? deps.verifyFrpVisitorIdentity
    : verifyFrpVisitorIdentity;
  const maxAttempts = boundedInteger(
    deps.frpVisitorVerifyMaxAttempts,
    DEFAULT_VISITOR_VERIFY_ATTEMPTS,
    1,
    10
  );
  const retryDelayMs = boundedInteger(
    deps.frpVisitorVerifyRetryDelayMs,
    DEFAULT_VISITOR_VERIFY_RETRY_DELAY_MS,
    0,
    2_000
  );
  const timeoutMs = boundedInteger(
    deps.frpVisitorVerifyTimeoutMs,
    DEFAULT_VISITOR_VERIFY_TIMEOUT_MS,
    250,
    5_000
  );
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await verify(visitor, { timeoutMs });
      if (result && result.ok === true && result.stableServerId === visitor.stableServerId) {
        return result;
      }
      const error = new Error('fabric_frp_server_identity_mismatch');
      error.code = 'fabric_frp_server_identity_mismatch';
      lastError = error;
    } catch (error) {
      lastError = error;
    }
    if (attempt < maxAttempts) await waitForRetry(retryDelayMs, deps);
  }
  throw lastError || new Error('fabric_frp_server_identity_unavailable');
}

function normalizeApplyPayload(payload, ctx) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const role = normalizeText(source.role, 16).toLowerCase();
  const rawStableServerId = String(source.stableServerId || source.serverId || '');
  const stableServerId = validateCanonicalFabricServerId(rawStableServerId);
  const secretKey = String(source.secretKey || '');
  if (!['provider', 'visitor'].includes(role)
    || !stableServerId
    || stableServerId !== rawStableServerId
    || !secretKey
    || secretKey.length > 4096
    || /[\r\n\0]/.test(secretKey)) {
    return null;
  }
  const localPort = role === 'provider'
    ? normalizePort(source.localPort, (ctx.options && ctx.options.port) || 9527)
    : 0;
  const bindPort = role === 'visitor' ? normalizePort(source.bindPort) : 0;
  if (role === 'provider' && !localPort) return null;
  return {
    role,
    stableServerId,
    name: normalizeText(source.name || source.serverName, 120) || stableServerId,
    secretKey,
    localPort,
    bindPort
  };
}

function normalizeRemovePayload(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const role = normalizeText(source.role, 16).toLowerCase();
  const rawStableServerId = String(source.stableServerId || source.serverId || '');
  const stableServerId = validateCanonicalFabricServerId(rawStableServerId);
  if (!['provider', 'visitor'].includes(role)
    || !stableServerId
    || stableServerId !== rawStableServerId) return null;
  return { role, stableServerId };
}

function stablePortOffset(value, range) {
  let hash = 2166136261;
  for (const character of String(value || '')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % range;
}

function canBindLoopbackPort(port, deps = {}) {
  if (typeof deps.canBindLoopbackPort === 'function') {
    return Promise.resolve(deps.canBindLoopbackPort(port));
  }
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      resolve(Boolean(available));
    };
    server.once('error', () => finish(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => finish(true));
    });
  });
}

async function allocateVisitorPort(ctx, stableServerId) {
  const deps = ctx.deps || {};
  if (typeof deps.allocateFrpVisitorPort === 'function') {
    return normalizePort(await deps.allocateFrpVisitorPort(stableServerId));
  }
  const visitors = listVisitors(ctx);
  const existing = visitors.find((route) => route.stableServerId === stableServerId);
  if (existing && normalizePort(existing.bindPort)) return normalizePort(existing.bindPort);
  const used = new Set(visitors.map((route) => normalizePort(route.bindPort)).filter(Boolean));
  const first = 19527 + stablePortOffset(stableServerId, 400);
  for (let offset = 0; offset < 400; offset += 1) {
    const port = 19527 + ((first - 19527 + offset) % 400);
    if (used.has(port)) continue;
    if (await canBindLoopbackPort(port, deps)) return port;
  }
  return 0;
}

function safeApplyResponse(input, report = {}) {
  return {
    ok: true,
    role: input.role,
    stableServerId: input.stableServerId,
    action: normalizeText(report.action, 32) || 'none',
    bindPort: input.bindPort,
    changes: {
      main: Boolean(report.changes && report.changes.main),
      fragment: Boolean(report.changes && report.changes.fragment),
      permissions: Boolean(report.changes && report.changes.permissions)
    }
  };
}

function applyErrorStatus(code) {
  if (code === 'frpc_config_not_found') return 404;
  if (code === 'frp_config_locked') return 409;
  if (code === 'frp_role_invalid'
    || code === 'frp_server_id_invalid'
    || code === 'frp_secret_key_invalid'
    || code === 'frp_port_invalid') return 400;
  return 502;
}

async function handleStatus(ctx) {
  const { writeJson } = routeIo(ctx);
  const configPath = discoverConfig(ctx);
  writeJson(ctx.res, 200, {
    ok: true,
    available: Boolean(configPath),
    configFileName: configPath ? path.basename(configPath) : '',
    visitors: listVisitors(ctx)
  });
  return true;
}

async function handleApply(ctx) {
  const deps = ctx.deps || {};
  const { writeJson } = routeIo(ctx);
  writeNoStoreHeaders(ctx.res);
  const input = normalizeApplyPayload(await readJsonPayload(ctx), ctx);
  if (!input) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_frp_config_payload' });
    return true;
  }
  if (typeof deps.applyAihFrpConfig !== 'function') {
    writeJson(ctx.res, 503, { ok: false, error: 'frp_config_management_unavailable' });
    return true;
  }
  return serializeFrpRouteMutation(input, async () => {
    try {
      if (input.role === 'visitor' && !input.bindPort) {
        input.bindPort = await allocateVisitorPort(ctx, input.stableServerId);
        if (!input.bindPort) {
          writeJson(ctx.res, 503, { ok: false, error: 'frp_visitor_port_unavailable' });
          return true;
        }
      }
      const visitor = input.role === 'visitor'
        ? {
          stableServerId: input.stableServerId,
          bindPort: input.bindPort
        }
        : null;
      const previousVisitor = visitor
        ? findVisitor(ctx, input.stableServerId)
        : null;
      const report = await deps.applyAihFrpConfig({
        aiHomeDir: deps.aiHomeDir,
        role: input.role,
        serverId: input.stableServerId,
        secretKey: input.secretKey,
        ...(input.role === 'provider'
          ? { localPort: input.localPort }
          : {
            bindPort: input.bindPort,
            validateActivation: () => validateAndCommitVisitor(
              ctx,
              input,
              visitor,
              previousVisitor
            )
          })
      });
      writeJson(ctx.res, 200, safeApplyResponse(input, report));
      return true;
    } catch (error) {
      const managerCode = normalizeText(error && error.code, 96) || 'frp_config_apply_failed';
      const code = managerCode === 'frp_activation_validation_failed'
        ? 'frp_visitor_identity_verification_failed'
        : managerCode;
      writeJson(ctx.res, applyErrorStatus(code), {
        ok: false,
        error: code,
        message: code === 'frp_visitor_identity_verification_failed'
          ? 'FRP Visitor 身份校验失败，已恢复原配置。'
          : 'FRP 配置未能生效，已尝试恢复原配置。'
      });
      return true;
    }
  });
}

async function handleRemove(ctx) {
  const deps = ctx.deps || {};
  const { writeJson } = routeIo(ctx);
  writeNoStoreHeaders(ctx.res);
  const input = normalizeRemovePayload(await readJsonPayload(ctx));
  if (!input) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_frp_remove_payload' });
    return true;
  }
  if (typeof deps.removeAihFrpConfig !== 'function') {
    writeJson(ctx.res, 503, { ok: false, error: 'frp_config_management_unavailable' });
    return true;
  }
  return serializeFrpRouteMutation(input, async () => {
    try {
      const report = await deps.removeAihFrpConfig({
        aiHomeDir: deps.aiHomeDir,
        role: input.role,
        serverId: input.stableServerId
      });
      if (input.role === 'visitor') removeVisitor(ctx, input.stableServerId);
      writeJson(ctx.res, 200, {
        ok: true,
        removed: Boolean(report && report.removed),
        role: input.role,
        stableServerId: input.stableServerId,
        action: normalizeText(report && report.action, 32) || 'none'
      });
      return true;
    } catch (error) {
      const code = normalizeText(error && error.code, 96) || 'frp_config_remove_failed';
      writeJson(ctx.res, applyErrorStatus(code), {
        ok: false,
        error: code,
        message: 'FRP 受管路径未能删除，已尝试恢复原配置。'
      });
      return true;
    }
  });
}

async function handleWebUiFrpConfigRoutes(ctx = {}) {
  const method = String(ctx.method || 'GET').toUpperCase();
  if (method === 'GET' && FRP_STATUS_PATHS.has(ctx.pathname)) return handleStatus(ctx);
  if (method === 'POST' && ctx.pathname === FRP_APPLY_PATH) return handleApply(ctx);
  if (method === 'DELETE' && ctx.pathname === FRP_REMOVE_PATH) return handleRemove(ctx);
  return false;
}

module.exports = {
  FRP_APPLY_PATH,
  FRP_REMOVE_PATH,
  FRP_STATUS_PATHS,
  handleWebUiFrpConfigRoutes,
  allocateVisitorPort,
  normalizeApplyPayload,
  normalizeRemovePayload,
  safeApplyResponse,
  verifyVisitorRoute
};
