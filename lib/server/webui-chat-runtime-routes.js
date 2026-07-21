'use strict';

const { openChatRuntimeEventStream } = require('./webui-chat-runtime-sse');
const {
  scheduleSessionPrewarm
} = require('./chat-runtime/session-prewarm-scheduler');
const {
  sanitizeCanonicalDiagnostic
} = require('./chat-runtime/canonical-diagnostic-sanitizer');

const SESSIONS_PATH = '/v0/webui/chat/sessions';
const SESSION_RESOLVE_PATH = `${SESSIONS_PATH}/resolve`;
const ARTIFACTS_PATH = '/v0/webui/chat/artifacts';
const ATTACHMENT_BODY_LIMIT = 32 * 1024 * 1024;

function createRouteError(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function getService(ctx) {
  const service = ctx.deps && ctx.deps.chatRuntimeService;
  if (!service) throw createRouteError('chat_runtime_unavailable', 503);
  return service;
}

function parseRequestUrl(req) {
  return new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
}

async function readJsonBody(ctx, maxBytes = 1024 * 1024) {
  let body;
  try {
    body = await ctx.readRequestBody(ctx.req, { maxBytes });
    return body && body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
  } catch (_error) {
    throw createRouteError('invalid_chat_runtime_payload', 400);
  }
}

function writeError(ctx, error) {
  const diagnostic = sanitizeCanonicalDiagnostic(error, {
    fallbackCode: 'chat_runtime_failed',
    includeDetails: true,
    includeStatusCode: true
  });
  ctx.writeJson(ctx.res, diagnostic.statusCode, {
    ok: false,
    error: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.details === undefined ? {} : { details: diagnostic.details })
  });
}

function sessionRoute(pathname, suffix) {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = pathname.match(new RegExp(`^${SESSIONS_PATH}/([^/]+)${escapedSuffix}$`));
  return match ? decodeURIComponent(match[1]) : '';
}

function listQuery(req) {
  const url = parseRequestUrl(req);
  const provider = String(url.searchParams.get('provider') || '').trim();
  const projectPath = String(url.searchParams.get('projectPath') || '').trim();
  const nativeSessionId = String(url.searchParams.get('nativeSessionId') || '').trim();
  return {
    ...(provider ? { provider } : {}),
    ...(projectPath ? { projectPath } : {}),
    ...(nativeSessionId ? { nativeSessionId } : {})
  };
}

function timelineQuery(req) {
  const url = parseRequestUrl(req);
  const before = String(url.searchParams.get('before') || '').trim();
  const requestedLimit = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(200, Math.floor(requestedLimit)))
    : 30;
  return { ...(before ? { before } : {}), limit };
}

async function handleSessionCollection(ctx, service) {
  if (ctx.pathname !== SESSIONS_PATH) return false;
  if (ctx.method === 'POST') {
    const session = await service.createSession(createSessionDto(await readJsonBody(ctx)));
    ctx.writeJson(ctx.res, 201, { ok: true, session });
    scheduleSessionPrewarm(service, session);
    return true;
  }
  if (ctx.method === 'GET') {
    const sessions = await service.listSessions(listQuery(ctx.req));
    ctx.writeJson(ctx.res, 200, { ok: true, sessions });
    return true;
  }
  return false;
}

function createSessionDto(input = {}) {
  return {
    provider: input.provider,
    executionAccountRef: input.executionAccountRef,
    projectPath: input.projectPath,
    policy: input.policy
  };
}

async function handleSessionResolve(ctx, service) {
  if (ctx.pathname !== SESSION_RESOLVE_PATH || ctx.method !== 'POST') return false;
  const result = await service.resolveSession(await readJsonBody(ctx));
  ctx.writeJson(ctx.res, result.status === 'created' ? 201 : 200, { ok: true, ...result });
  scheduleSessionPrewarm(service, result.session);
  return true;
}

async function handleSessionReads(ctx, service) {
  const snapshotId = sessionRoute(ctx.pathname, '/snapshot');
  if (ctx.method === 'GET' && snapshotId) {
    const snapshot = await service.getSnapshot(snapshotId);
    ctx.writeJson(ctx.res, 200, { ok: true, snapshot });
    return true;
  }
  const timelineId = sessionRoute(ctx.pathname, '/timeline');
  if (ctx.method === 'GET' && timelineId) {
    const timeline = await service.readTimeline(timelineId, timelineQuery(ctx.req));
    ctx.writeJson(ctx.res, 200, { ok: true, timeline });
    return true;
  }
  const catalogId = sessionRoute(ctx.pathname, '/commands/catalog');
  if (ctx.method === 'GET' && catalogId) {
    const commands = await service.getCommandCatalog(catalogId);
    ctx.writeJson(ctx.res, 200, { ok: true, commands });
    return true;
  }
  const composerCatalogId = sessionRoute(ctx.pathname, '/composer/catalog');
  if (ctx.method === 'GET' && composerCatalogId) {
    const catalog = await service.readComposerCatalog(composerCatalogId);
    ctx.writeJson(ctx.res, 200, { ok: true, catalog });
    return true;
  }
  return false;
}

async function handleSessionCommands(ctx, service) {
  const sessionId = sessionRoute(ctx.pathname, '/commands');
  if (ctx.method !== 'POST' || !sessionId) return false;
  const command = await readJsonBody(ctx);
  const coordinator = ctx.deps && ctx.deps.cliInteractionCoordinator;
  const external = coordinator && typeof coordinator.dispatch === 'function'
    ? await coordinator.dispatch(sessionId, command)
    : null;
  const result = external || await service.dispatchCommand(sessionId, command);
  ctx.writeJson(ctx.res, 202, { ok: true, ...result });
  return true;
}

async function handleSessionAttachments(ctx, service) {
  const sessionId = sessionRoute(ctx.pathname, '/attachments');
  if (ctx.method !== 'POST' || !sessionId) return false;
  const attachments = await service.uploadAttachments(
    sessionId,
    await readJsonBody(ctx, ATTACHMENT_BODY_LIMIT)
  );
  ctx.writeJson(ctx.res, 201, { ok: true, sessionId, attachments });
  return true;
}

async function handleSessionEvents(ctx, service) {
  const sessionId = sessionRoute(ctx.pathname, '/events');
  if (ctx.method !== 'GET' || !sessionId) return false;
  return openChatRuntimeEventStream(ctx, service, sessionId);
}

async function handleArtifact(ctx, service) {
  if (ctx.method !== 'GET' || !ctx.pathname.startsWith(`${ARTIFACTS_PATH}/`)) return false;
  const artifactId = decodeURIComponent(ctx.pathname.slice(ARTIFACTS_PATH.length + 1));
  const artifact = await service.readArtifact(artifactId);
  if (!artifact || artifact.body == null) throw createRouteError('artifact_not_found', 404);
  ctx.res.writeHead(200, { 'Content-Type': artifact.contentType || 'application/octet-stream' });
  ctx.res.end(artifact.body);
  return true;
}

async function handleWebUiChatRuntimeRequest(ctx) {
  const isCandidate = ctx.pathname === SESSIONS_PATH
    || ctx.pathname.startsWith(`${SESSIONS_PATH}/`)
    || ctx.pathname.startsWith(`${ARTIFACTS_PATH}/`);
  if (!isCandidate) return false;
  try {
    const service = getService(ctx);
    return await handleSessionResolve(ctx, service)
      || await handleSessionCollection(ctx, service)
      || await handleSessionReads(ctx, service)
      || await handleSessionAttachments(ctx, service)
      || await handleSessionCommands(ctx, service)
      || await handleSessionEvents(ctx, service)
      || await handleArtifact(ctx, service);
  } catch (error) {
    writeError(ctx, error);
    return true;
  }
}

module.exports = {
  handleWebUiChatRuntimeRequest
};
