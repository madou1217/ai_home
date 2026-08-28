'use strict';

const {
  listChatSessions,
  readChatSession,
  saveChatSession,
  deleteChatSession,
} = require('./webui-chat-store');

async function handleGetChatSessionsRequest(ctx) {
  const hostHome = ctx.hostHomeDir || (ctx.deps && ctx.deps.hostHomeDir);
  const sessions = listChatSessions(hostHome);
  ctx.writeJson(ctx.res, 200, { ok: true, sessions });
  return true;
}

async function handleGetSingleChatSessionRequest(ctx) {
  const matches = ctx.pathname.match(/^\/v0\/webui\/chat-sessions\/([^/]+)$/);
  if (!matches) return false;
  const sessionId = decodeURIComponent(matches[1]);
  const hostHome = ctx.hostHomeDir || (ctx.deps && ctx.deps.hostHomeDir);
  const session = readChatSession(sessionId, hostHome);
  if (!session) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: 'chat_session_not_found' });
    return true;
  }
  ctx.writeJson(ctx.res, 200, { ok: true, session });
  return true;
}

async function handleCreateChatSessionRequest(ctx) {
  const hostHome = ctx.hostHomeDir || (ctx.deps && ctx.deps.hostHomeDir);
  const body = await ctx.readRequestBody(ctx.req, { maxBytes: 1024 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);

  const sessionId = (body && body.id) || `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const session = {
    id: sessionId,
    title: (body && body.title) || '新对话',
    provider: (body && body.provider) || 'claude',
    model: (body && body.model) || '',
    accountRef: (body && body.accountRef) || '',
    mode: 'chat',
    createdAt: (body && body.createdAt) || now,
    updatedAt: now,
    messages: (body && body.messages) || [],
  };

  saveChatSession(session, hostHome);
  ctx.writeJson(ctx.res, 201, { ok: true, session });
  return true;
}

async function handleDeleteChatSessionRequest(ctx) {
  const matches = ctx.pathname.match(/^\/v0\/webui\/chat-sessions\/([^/]+)$/);
  if (!matches) return false;
  const sessionId = decodeURIComponent(matches[1]);
  const hostHome = ctx.hostHomeDir || (ctx.deps && ctx.deps.hostHomeDir);
  const deleted = deleteChatSession(sessionId, hostHome);
  ctx.writeJson(ctx.res, 200, { ok: true, deleted });
  return true;
}

async function handleWebUiChatSessionsRoutes(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/v0/webui/chat-sessions')) return false;

  if (pathname === '/v0/webui/chat-sessions') {
    if (method === 'GET') return handleGetChatSessionsRequest(ctx);
    if (method === 'POST') return handleCreateChatSessionRequest(ctx);
  }

  if (pathname.match(/^\/v0\/webui\/chat-sessions\/([^/]+)$/)) {
    if (method === 'GET') return handleGetSingleChatSessionRequest(ctx);
    if (method === 'DELETE') return handleDeleteChatSessionRequest(ctx);
  }

  return false;
}

module.exports = {
  handleGetChatSessionsRequest,
  handleGetSingleChatSessionRequest,
  handleCreateChatSessionRequest,
  handleDeleteChatSessionRequest,
  handleWebUiChatSessionsRoutes,
};
