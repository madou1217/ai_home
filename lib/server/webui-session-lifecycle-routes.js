'use strict';

const { refreshProjectsSnapshot } = require('./webui-project-cache');
const { notifyWebUiProjectWatchers } = require('./webui-project-watch');
const { SessionLifecycleError } = require('./session-lifecycle');

async function handleGetSessionLifecycleCapabilitiesRequest(ctx) {
  try {
    const service = requireLifecycleService(ctx);
    const providers = await service.getCapabilities();
    ctx.writeJson(ctx.res, 200, { ok: true, providers });
  } catch (error) {
    writeLifecycleError(ctx, error);
  }
  return true;
}

async function handleArchiveSessionRequest(ctx) {
  try {
    const service = requireLifecycleService(ctx);
    const payload = await readLifecyclePayload(ctx);
    const result = await service.archive({
      provider: payload && payload.provider,
      sessionId: payload && payload.sessionId
    });
    refreshProjects(ctx);
    ctx.writeJson(ctx.res, 200, { ok: true, ...result });
  } catch (error) {
    writeLifecycleError(ctx, error);
  }
  return true;
}

async function handleGetArchivedSessionsRequest(ctx) {
  try {
    const service = requireLifecycleService(ctx);
    const result = await service.listArchived();
    ctx.writeJson(ctx.res, 200, {
      ok: true,
      archived: Array.isArray(result && result.archived) ? result.archived : [],
      errors: Array.isArray(result && result.errors) ? result.errors : []
    });
  } catch (error) {
    writeLifecycleError(ctx, error);
  }
  return true;
}

async function handleUnarchiveSessionRequest(ctx) {
  try {
    const service = requireLifecycleService(ctx);
    const payload = await readLifecyclePayload(ctx);
    const result = await service.unarchive({
      provider: payload && payload.provider,
      sessionId: payload && payload.sessionId,
      origin: payload && payload.origin
    });
    refreshProjects(ctx);
    ctx.writeJson(ctx.res, 200, { ok: true, ...result });
  } catch (error) {
    writeLifecycleError(ctx, error);
  }
  return true;
}

function requireLifecycleService(ctx) {
  const service = ctx && ctx.deps && ctx.deps.sessionLifecycleService;
  if (!service) {
    throw new SessionLifecycleError('session_lifecycle_unavailable', 503, {
      message: '原生会话生命周期服务未就绪'
    });
  }
  return service;
}

async function readLifecyclePayload(ctx) {
  const buffer = await ctx.readRequestBody(ctx.req, { maxBytes: 64 * 1024 });
  try {
    return buffer ? JSON.parse(buffer.toString('utf8')) : null;
  } catch (_error) {
    throw new SessionLifecycleError('invalid_json', 400, { message: '请求 JSON 无效' });
  }
}

function refreshProjects(ctx) {
  const deps = ctx.deps || {};
  const refresh = typeof deps.refreshProjectsSnapshot === 'function'
    ? deps.refreshProjectsSnapshot
    : refreshProjectsSnapshot;
  const notify = typeof deps.notifyWebUiProjectWatchers === 'function'
    ? deps.notifyWebUiProjectWatchers
    : notifyWebUiProjectWatchers;
  Promise.resolve(refresh(ctx, { force: true }))
    .then(() => notify(ctx, { force: true }))
    .catch(() => {});
}

function writeLifecycleError(ctx, error) {
  const normalized = normalizeLifecycleError(error);
  ctx.writeJson(ctx.res, normalized.statusCode, {
    ok: false,
    error: normalized.code,
    message: normalized.message,
    ...(normalized.details ? { details: normalized.details } : {})
  });
}

function normalizeLifecycleError(error) {
  if (error instanceof SessionLifecycleError) {
    return {
      code: error.code,
      statusCode: error.statusCode,
      message: String(error.message || error.code),
      ...(error.details ? { details: error.details } : {})
    };
  }
  const code = String(error && error.code || 'session_lifecycle_failed');
  const statusCode = Number(error && error.statusCode) || statusForErrorCode(code);
  return {
    code,
    statusCode,
    message: String(error && error.message || code)
  };
}

function statusForErrorCode(code) {
  if (code === 'missing_params' || code === 'invalid_json') return 400;
  if (code === 'legacy_archive_not_found') return 404;
  if (code === 'session_lifecycle_active' || code === 'legacy_archive_restore_conflict') return 409;
  if (code.endsWith('_unsupported')) return 422;
  if (code === 'session_lifecycle_timeout') return 504;
  if (code === 'provider_runtime_not_found' || code === 'codex_lifecycle_spawn_failed') return 503;
  if (code.startsWith('codex_')) return 502;
  return 500;
}

module.exports = {
  handleArchiveSessionRequest,
  handleGetArchivedSessionsRequest,
  handleGetSessionLifecycleCapabilitiesRequest,
  handleUnarchiveSessionRequest,
  normalizeLifecycleError
};
