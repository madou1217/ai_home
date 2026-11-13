'use strict';

// AI 翻译页面的 Node 薄代理边界（零 Node 业务逻辑与零回落）。
//
// 全部设置存储、Provider 配置与路由、语种目录/检测、模型目录与流式对冲翻译
// 均由 Go Core（/v1/management/webui/translation/*）承担；
// 仅 /system 与 /focus 继续委托本地 ctx.state.systemTranslation 桌面取词服务。

const { proxyWebuiGo, resolveGoHost } = require('./webui-go-proxy');
const { isLoopbackPeer } = require('./management-key-auth');

const TRANSLATION_BASE_PATH = '/v0/webui/translation';
const GO_TRANSLATION_BASE_PATH = '/v1/management/webui/translation';
const MAX_TRANSLATION_INPUT_CHARS = 40000;
const TRANSLATION_BODY_BYTES = 256 * 1024;
const TRANSLATION_PASS_STATUSES = Object.freeze([400, 401, 403, 404, 409, 413, 415, 422, 429, 502, 503]);

function translationCorsHeaders(ctx) {
  const origin = String(ctx && ctx.req && ctx.req.headers && ctx.req.headers.origin || '').trim();
  if (!origin.startsWith('chrome-extension://') && !origin.startsWith('moz-extension://')) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-AIH-Server-Id',
    Vary: 'Origin'
  };
}

function applyTranslationCorsHeaders(ctx) {
  const res = ctx && ctx.res;
  if (!res || typeof res.setHeader !== 'function') return;
  const headers = translationCorsHeaders(ctx);
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
}

function readQueryString(ctx) {
  if (ctx && ctx.url && ctx.url.searchParams) {
    return ctx.url.searchParams.toString();
  }
  const rawUrl = String((ctx && ctx.req && ctx.req.url) || '');
  const qIndex = rawUrl.indexOf('?');
  return qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '';
}

function writeTranslationError(ctx, statusCode, code, detail) {
  applyTranslationCorsHeaders(ctx);
  ctx.writeJson(ctx.res, Number(statusCode) || 500, {
    ok: false,
    error: String(code || 'translation_error'),
    detail: String(detail || 'translation request failed')
  });
}

async function readJsonBody(ctx, maxBytes = TRANSLATION_BODY_BYTES) {
  const result = await ctx.readRequestBody(ctx.req, { maxBytes }).catch((error) => ({ __error: error }));
  if (!result || result.__error) {
    const error = result && result.__error;
    if (error && error.code === 'request_body_too_large') {
      writeTranslationError(ctx, 413, 'request_body_too_large', '请求内容过大');
      return null;
    }
    writeTranslationError(ctx, 400, 'invalid_request_body', '无法读取请求内容');
    return null;
  }
  try {
    return result.length > 0 ? JSON.parse(result.toString('utf8')) : {};
  } catch (_error) {
    writeTranslationError(ctx, 400, 'invalid_json', '请求内容必须是合法 JSON');
    return null;
  }
}

async function handleSystemTranslationRoutes(ctx, subPath) {
  const service = ctx.state && ctx.state.systemTranslation;
  if (!service) {
    ctx.writeJson(ctx.res, 503, { ok: false, detail: '桌面取词服务尚未就绪' });
    return true;
  }
  if (ctx.method === 'POST') {
    const body = await readJsonBody(ctx, 2048);
    if (body === null) return true;
    if (subPath === '/focus') {
      if (isLoopbackPeer(ctx.req) && !ctx.req.headers['x-aih-server-id']) service.updateFocus(body);
    } else if (body.action === 'request-permission') {
      service.requestPermission();
    } else if (body.serverTarget && typeof service.setServerTarget === 'function') {
      if (body.serverTargets && typeof service.setServerTargets === 'function') service.setServerTargets(body.serverTargets);
      service.setServerTarget(body.serverTarget);
    } else if (body.executionTarget && typeof service.setExecutionTarget === 'function') {
      service.setExecutionTarget(body.executionTarget);
    } else if (typeof body.enabled === 'boolean') {
      await service.setEnabled(body.enabled);
    } else {
      writeTranslationError(ctx, 400, 'invalid_system_translation_action', '请指定系统取词开关');
      return true;
    }
  } else if (ctx.method !== 'GET' || subPath !== '/system') {
    writeTranslationError(ctx, 405, 'method_not_allowed', '请求方法不受支持');
    return true;
  }
  ctx.writeJson(ctx.res, 200, { ok: true, system: service.getStatus() });
  return true;
}

async function handleStreamProxy(ctx) {
  const { req, res } = ctx;
  const body = await readJsonBody(ctx, TRANSLATION_BODY_BYTES);
  if (body === null) return true;

  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.openWebuiStream !== 'function') {
    writeTranslationError(ctx, 503, 'go_core_unavailable', 'Go Core 未就绪，翻译服务不可用');
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
  req.on('aborted', abort);
  res.on('close', abort);
  res.on('error', abort);

  const origin = String(req && req.headers && req.headers.origin || '').trim();
  const extraHeaders = { 'content-type': 'application/json' };
  if (origin) extraHeaders.origin = origin;

  let upstream = null;
  try {
    upstream = await goHost.openWebuiStream({
      method: 'POST',
      path: `${GO_TRANSLATION_BASE_PATH}/stream`,
      body,
      accept: 'text/event-stream',
      headers: extraHeaders
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
    writeTranslationError(ctx, 503, 'go_core_unavailable', 'Go Core 未就绪，翻译服务不可用');
    return true;
  }

  if (!upstream.ok || !upstream.body) {
    const text = typeof upstream.text === 'function' ? await upstream.text().catch(() => '') : '';
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_error) { payload = null; }
    applyTranslationCorsHeaders(ctx);
    ctx.writeJson(res, Number(upstream.status) || 502, payload || {
      ok: false,
      error: 'translation_stream_failed',
      detail: '翻译服务请求失败'
    });
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...translationCorsHeaders(ctx)
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

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
    req.off('aborted', abort);
    res.off('close', abort);
    res.off('error', abort);
    if (!res.destroyed && !res.writableEnded) {
      try { res.end(); } catch (_error) {}
    }
  }
  return true;
}

/**
 * @returns {Promise<boolean>} 是否已处理该请求
 */
async function handleWebUiTranslationRoutes(ctx) {
  const { method, pathname } = ctx;
  if (!String(pathname || '').startsWith(TRANSLATION_BASE_PATH)) return false;
  const subPath = pathname.slice(TRANSLATION_BASE_PATH.length) || '/';

  if (method === 'OPTIONS') {
    ctx.res.writeHead(204, translationCorsHeaders(ctx));
    ctx.res.end();
    return true;
  }

  applyTranslationCorsHeaders(ctx);

  if (subPath === '/system' || subPath === '/focus') {
    return handleSystemTranslationRoutes(ctx, subPath);
  }
  if (method === 'GET' && subPath === '/settings') {
    return proxyWebuiGo(ctx, {
      method: 'GET',
      path: `${GO_TRANSLATION_BASE_PATH}/settings`,
      useFullBody: true,
      passStatuses: TRANSLATION_PASS_STATUSES,
      message: 'Go Core 未就绪，翻译设置不可用'
    });
  }
  if (method === 'POST' && subPath === '/settings') {
    const body = await readJsonBody(ctx, 64 * 1024);
    if (body === null) return true;
    return proxyWebuiGo(ctx, {
      method: 'POST',
      path: `${GO_TRANSLATION_BASE_PATH}/settings`,
      body,
      useFullBody: true,
      passStatuses: TRANSLATION_PASS_STATUSES,
      message: 'Go Core 未就绪，无法保存翻译设置',
      transform: (payload) => {
        if (ctx.state && ctx.state.systemTranslation && typeof ctx.state.systemTranslation.configure === 'function') {
          ctx.state.systemTranslation.configure();
        }
        return payload;
      }
    });
  }
  if ((method === 'GET' || method === 'POST') && subPath === '/providers') {
    let body;
    if (method === 'POST') {
      body = await readJsonBody(ctx, 16 * 1024);
      if (body === null) return true;
    }
    return proxyWebuiGo(ctx, {
      method,
      path: `${GO_TRANSLATION_BASE_PATH}/providers`,
      body,
      useFullBody: true,
      passStatuses: TRANSLATION_PASS_STATUSES,
      message: 'Go Core 未就绪，翻译引擎配置不可用'
    });
  }
  if (method === 'GET' && subPath === '/languages') {
    return proxyWebuiGo(ctx, {
      method: 'GET',
      path: `${GO_TRANSLATION_BASE_PATH}/languages`,
      useFullBody: true,
      passStatuses: TRANSLATION_PASS_STATUSES,
      message: 'Go Core 未就绪，语言目录不可用'
    });
  }
  if (method === 'POST' && subPath === '/detect') {
    const body = await readJsonBody(ctx, 64 * 1024);
    if (body === null) return true;
    return proxyWebuiGo(ctx, {
      method: 'POST',
      path: `${GO_TRANSLATION_BASE_PATH}/detect`,
      body,
      useFullBody: true,
      passStatuses: TRANSLATION_PASS_STATUSES,
      message: 'Go Core 未就绪，语言检测不可用'
    });
  }
  if (method === 'GET' && subPath === '/models') {
    return proxyWebuiGo(ctx, {
      method: 'GET',
      path: `${GO_TRANSLATION_BASE_PATH}/models`,
      query: readQueryString(ctx),
      useFullBody: true,
      passStatuses: TRANSLATION_PASS_STATUSES,
      message: 'Go Core 未就绪，翻译模型目录不可用'
    });
  }
  if (method === 'POST' && subPath === '/stream') {
    return handleStreamProxy(ctx);
  }

  writeTranslationError(ctx, 404, 'translation_route_not_found', 'translation route not found');
  return true;
}

function warmTranslationGateway(ctx) {
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.webuiRequest !== 'function') return;
  void goHost.webuiRequest({
    method: 'GET',
    path: `${GO_TRANSLATION_BASE_PATH}/settings`
  }).catch(() => null);
}

function warmTranslationModelCatalog(ctx) {
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.webuiRequest !== 'function') return null;
  return goHost.webuiRequest({
    method: 'GET',
    path: `${GO_TRANSLATION_BASE_PATH}/models`
  }).catch(() => null);
}

module.exports = {
  TRANSLATION_BASE_PATH,
  MAX_TRANSLATION_INPUT_CHARS,
  handleWebUiTranslationRoutes,
  warmTranslationGateway,
  warmTranslationModelCatalog
};
