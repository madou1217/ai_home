'use strict';

// Legacy 聊天会话 CRUD 与 canonical 删除路由的零回退 Go 代理。
// 全部 SQLite 合并去重、级联物理删除、附件清理与 JSON 持久化已迁至 Go
// (/v1/management/webui/chat-sessions*)。

const { proxyWebuiGo } = require('./webui-go-proxy');

function parseSingleSessionId(pathname) {
  const matches = String(pathname || '').match(/^\/v0\/webui\/chat-sessions\/([^/]+)$/);
  if (!matches) return { matched: false, valid: false, sessionId: '' };
  let sessionId = '';
  try {
    sessionId = decodeURIComponent(matches[1]);
  } catch (_error) {
    return { matched: true, valid: false, sessionId: '' };
  }
  const trimmed = sessionId.trim();
  if (!trimmed || trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    return { matched: true, valid: false, sessionId: '' };
  }
  return { matched: true, valid: true, sessionId: trimmed };
}

async function handleGetChatSessionsRequest(ctx) {
  return proxyWebuiGo(ctx, {
    method: 'GET',
    path: '/v1/management/webui/chat-sessions',
    passStatuses: [400, 401, 404, 405, 409],
    message: 'Go Core 未就绪，无法读取聊天会话列表'
  });
}

async function handleGetSingleChatSessionRequest(ctx) {
  const parsed = parseSingleSessionId(ctx && ctx.pathname);
  if (!parsed.matched) return false;
  if (!parsed.valid) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_session_id' });
    return true;
  }
  return proxyWebuiGo(ctx, {
    method: 'GET',
    path: `/v1/management/webui/chat-sessions/${encodeURIComponent(parsed.sessionId)}`,
    passStatuses: [400, 401, 404, 405, 409],
    message: 'Go Core 未就绪，无法读取聊天会话'
  });
}

async function handleCreateChatSessionRequest(ctx) {
  let body = {};
  if (ctx && typeof ctx.readRequestBody === 'function') {
    let raw = null;
    try {
      raw = await ctx.readRequestBody(ctx.req, { maxBytes: 1024 * 1024 });
    } catch (_error) {
      ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_request_body' });
      return true;
    }
    const text = raw ? raw.toString('utf8').trim() : '';
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (_error) {
        ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_json' });
        return true;
      }
    }
  }
  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: '/v1/management/webui/chat-sessions',
    body,
    status: 201,
    passStatuses: [400, 401, 404, 405, 409, 413],
    message: 'Go Core 未就绪，无法创建聊天会话'
  });
}

async function handleDeleteChatSessionRequest(ctx) {
  const parsed = parseSingleSessionId(ctx && ctx.pathname);
  if (!parsed.matched) return false;
  if (!parsed.valid) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_session_id' });
    return true;
  }
  return proxyWebuiGo(ctx, {
    method: 'DELETE',
    path: `/v1/management/webui/chat-sessions/${encodeURIComponent(parsed.sessionId)}`,
    passStatuses: [400, 401, 404, 405, 409],
    message: 'Go Core 未就绪，无法删除聊天会话'
  });
}

async function handleWebUiChatSessionsRoutes(ctx) {
  const pathname = ctx && ctx.pathname ? String(ctx.pathname) : '';
  const method = String((ctx && ctx.method) || '').toUpperCase();
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
  handleWebUiChatSessionsRoutes
};
