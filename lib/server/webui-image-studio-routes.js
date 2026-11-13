'use strict';

// Image Studio（AI 生图工作台）的 Node 薄代理边界（零 Node 业务逻辑与零回落）。
//
// 全部模型目录筛选、会话/修订/资产 SQLite 持久化、上游生图/编辑执行与 SSRF 资产拉取
// 均由 Go Core（/v1/management/webui/studio/image/*）承担。

const { proxyWebuiGo, resolveGoHost } = require('./webui-go-proxy');

const IMAGE_STUDIO_BASE_PATH = '/v0/webui/studio/image';
const GO_IMAGE_STUDIO_BASE_PATH = '/v1/management/webui/studio/image';
const DEFAULT_BODY_BYTES = 1024 * 1024;
const IMAGE_STUDIO_BODY_BYTES = 16 * 1024 * 1024;
const STUDIO_PASS_STATUSES = Object.freeze([400, 401, 403, 404, 409, 413, 415, 422, 429, 502, 503]);

function readQueryString(ctx) {
  if (ctx && ctx.url && ctx.url.searchParams) {
    return ctx.url.searchParams.toString();
  }
  const rawUrl = String((ctx && ctx.req && ctx.req.url) || '');
  const qIndex = rawUrl.indexOf('?');
  return qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '';
}

function writeStudioError(ctx, statusCode, code, detail) {
  ctx.writeJson(ctx.res, Number(statusCode) || 500, {
    ok: false,
    error: String(code || 'image_studio_error'),
    detail: String(detail || 'image Studio request failed')
  });
}

async function readJsonBody(ctx, maxBytes = DEFAULT_BODY_BYTES) {
  const result = await ctx.readRequestBody(ctx.req, { maxBytes }).catch((error) => ({ __error: error }));
  if (!result || result.__error) {
    const error = result && result.__error;
    if (error && error.code === 'request_body_too_large') {
      writeStudioError(ctx, 413, 'request_body_too_large', 'request body is too large');
      return null;
    }
    writeStudioError(ctx, 400, 'invalid_request_body', 'request body could not be read');
    return null;
  }
  try {
    return result.length > 0 ? JSON.parse(result.toString('utf8')) : {};
  } catch (_error) {
    writeStudioError(ctx, 400, 'invalid_json', 'request body must be valid JSON');
    return null;
  }
}

async function proxyRunRequest(ctx, sessionId, body) {
  const goHost = resolveGoHost(ctx);
  if (!goHost) {
    writeStudioError(ctx, 503, 'go_core_unavailable', 'Go Core 未就绪，生图工作台不可用');
    return true;
  }
  const goPath = `${GO_IMAGE_STUDIO_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/runs`;
  // 生图上游耗时常超过 management-client 的 30s 默认超时，优先走无短超时的 openWebuiStream。
  if (typeof goHost.openWebuiStream === 'function') {
    let upstream = null;
    try {
      upstream = await goHost.openWebuiStream({
        method: 'POST',
        path: goPath,
        body,
        accept: 'application/json',
        headers: { 'content-type': 'application/json' }
      });
    } catch (_error) {
      upstream = null;
    }
    if (!upstream) {
      writeStudioError(ctx, 503, 'go_core_unavailable', 'Go Core 未就绪，生图工作台不可用');
      return true;
    }
    const text = typeof upstream.text === 'function' ? await upstream.text().catch(() => '') : '';
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_error) { payload = null; }
    ctx.writeJson(ctx.res, Number(upstream.status) || 502, payload || {
      ok: false,
      error: 'image_studio_run_failed',
      detail: 'image studio run failed'
    });
    return true;
  }
  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: goPath,
    body,
    useFullBody: true,
    passStatuses: STUDIO_PASS_STATUSES,
    message: 'Go Core 未就绪，生图工作台不可用'
  });
}

async function proxyAssetStream(ctx, sessionId, assetId) {
  const { req, res } = ctx;
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.openWebuiStream !== 'function') {
    writeStudioError(ctx, 503, 'go_core_unavailable', 'Go Core 未就绪，图片资产读取不可用');
    return true;
  }

  let closed = false;
  let reader = null;
  const abort = () => {
    if (closed) return;
    closed = true;
    if (reader) {
      try { reader.cancel(); } catch (_error) {}
    }
  };
  req.on('close', abort);
  res.on('close', abort);
  res.on('error', abort);

  let upstream = null;
  try {
    upstream = await goHost.openWebuiStream({
      method: 'GET',
      path: `${GO_IMAGE_STUDIO_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/assets/${encodeURIComponent(assetId)}`,
      accept: '*/*'
    });
  } catch (_error) {
    upstream = null;
  }

  if (closed || req.destroyed || res.destroyed || res.writableEnded) {
    if (upstream && upstream.body && typeof upstream.body.cancel === 'function') {
      try { await upstream.body.cancel(); } catch (_error) {}
    }
    return true;
  }

  if (!upstream) {
    writeStudioError(ctx, 503, 'go_core_unavailable', 'Go Core 未就绪，图片资产读取不可用');
    return true;
  }

  if (!upstream.ok || !upstream.body) {
    const text = typeof upstream.text === 'function' ? await upstream.text().catch(() => '') : '';
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_error) { payload = null; }
    ctx.writeJson(res, Number(upstream.status) || 502, payload || {
      ok: false,
      error: 'read_asset_failed',
      detail: 'image asset could not be read'
    });
    return true;
  }

  const headers = {
    'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
    'cache-control': upstream.headers.get('cache-control') || 'private, max-age=31536000, immutable',
    'content-disposition': upstream.headers.get('content-disposition') || `inline; filename="${assetId}"`,
    'x-content-type-options': upstream.headers.get('x-content-type-options') || 'nosniff'
  };
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) {
    headers['content-length'] = contentLength;
  }
  res.writeHead(Number(upstream.status) || 200, headers);

  reader = upstream.body.getReader();
  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => {
          const doneWait = () => {
            res.off('drain', doneWait);
            res.off('close', doneWait);
            res.off('error', doneWait);
            resolve();
          };
          res.once('drain', doneWait);
          res.once('close', doneWait);
          res.once('error', doneWait);
        });
      }
    }
  } catch (_error) {
    // 客户端或 Go 上游断开后结束响应。
  } finally {
    abort();
    req.off('close', abort);
    res.off('close', abort);
    res.off('error', abort);
    if (!res.destroyed && !res.writableEnded) {
      try { res.end(); } catch (_error) {}
    }
  }
  return true;
}

async function handleWebUiImageStudioRoutes(ctx) {
  const { method, pathname } = ctx;
  if (!String(pathname || '').startsWith(IMAGE_STUDIO_BASE_PATH)) return false;

  if (method === 'GET' && pathname === `${IMAGE_STUDIO_BASE_PATH}/models`) {
    return proxyWebuiGo(ctx, {
      method: 'GET',
      path: `${GO_IMAGE_STUDIO_BASE_PATH}/models`,
      query: readQueryString(ctx),
      useFullBody: true,
      passStatuses: STUDIO_PASS_STATUSES,
      message: 'Go Core 未就绪，生图模型目录不可用'
    });
  }

  if (pathname === `${IMAGE_STUDIO_BASE_PATH}/sessions`) {
    if (method === 'GET') {
      return proxyWebuiGo(ctx, {
        method: 'GET',
        path: `${GO_IMAGE_STUDIO_BASE_PATH}/sessions`,
        useFullBody: true,
        passStatuses: STUDIO_PASS_STATUSES,
        message: 'Go Core 未就绪，生图会话列表不可用'
      });
    }
    if (method === 'POST') {
      const body = await readJsonBody(ctx, DEFAULT_BODY_BYTES);
      if (body === null) return true;
      return proxyWebuiGo(ctx, {
        method: 'POST',
        path: `${GO_IMAGE_STUDIO_BASE_PATH}/sessions`,
        body,
        status: 201,
        useFullBody: true,
        passStatuses: STUDIO_PASS_STATUSES,
        message: 'Go Core 未就绪，无法创建生图会话'
      });
    }
  }

  const runMatch = pathname.match(/^\/v0\/webui\/studio\/image\/sessions\/([^/]+)\/runs$/);
  if (method === 'POST' && runMatch) {
    const body = await readJsonBody(ctx, IMAGE_STUDIO_BODY_BYTES);
    if (body === null) return true;
    return proxyRunRequest(ctx, runMatch[1], body);
  }

  const assetMatch = pathname.match(/^\/v0\/webui\/studio\/image\/sessions\/([^/]+)\/assets\/([^/]+)$/);
  if (method === 'GET' && assetMatch) {
    return proxyAssetStream(ctx, assetMatch[1], assetMatch[2]);
  }

  const sessionMatch = pathname.match(/^\/v0\/webui\/studio\/image\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const sessionPath = `${GO_IMAGE_STUDIO_BASE_PATH}/sessions/${encodeURIComponent(sessionMatch[1])}`;
    if (method === 'GET') {
      return proxyWebuiGo(ctx, {
        method: 'GET',
        path: sessionPath,
        useFullBody: true,
        passStatuses: STUDIO_PASS_STATUSES,
        message: 'Go Core 未就绪，无法读取生图会话'
      });
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(ctx, DEFAULT_BODY_BYTES);
      if (body === null) return true;
      return proxyWebuiGo(ctx, {
        method: 'PATCH',
        path: sessionPath,
        body,
        useFullBody: true,
        passStatuses: STUDIO_PASS_STATUSES,
        message: 'Go Core 未就绪，无法重命名生图会话'
      });
    }
    if (method === 'DELETE') {
      return proxyWebuiGo(ctx, {
        method: 'DELETE',
        path: sessionPath,
        useFullBody: true,
        passStatuses: STUDIO_PASS_STATUSES,
        message: 'Go Core 未就绪，无法删除生图会话'
      });
    }
  }

  return false;
}

module.exports = {
  handleWebUiImageStudioRoutes
};
