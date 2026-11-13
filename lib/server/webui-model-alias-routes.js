'use strict';

const { proxyWebuiGo } = require('./webui-go-proxy');

const COLLECTION_PATH = '/v0/webui/model-aliases';
const TARGETS_PATH = '/v0/webui/model-aliases/targets';
const REPLACE_PATH = '/v0/webui/model-aliases/replace';
const ITEM_PATTERN = /^\/v0\/webui\/model-aliases\/([A-Za-z0-9_-]+)(?:\/(toggle))?$/;
const GO_BASE_PATH = '/v1/management/webui/model-aliases';
const PASS_STATUSES = Object.freeze([400, 404, 405, 409]);
const GO_UNAVAILABLE_MESSAGE = 'Go Core 模型别名服务不可用';

function createLoggedWriteJson(ctx, method, pathname) {
  const writeJson = ctx.writeJson || (ctx.deps && ctx.deps.writeJson);
  const appendLog = ctx.deps && ctx.deps.appendProxyRequestLog;
  if (typeof appendLog !== 'function') return writeJson;
  return (res, status, payload) => {
    if (Number(status) >= 400) {
      try {
        const errorField = payload && payload.error;
        appendLog({
          at: new Date().toISOString(),
          kind: 'model_alias_rejected',
          method,
          path: pathname,
          status,
          error: errorField && typeof errorField === 'object' ? errorField.code : errorField,
          detail: (payload && payload.detail) || (errorField && errorField.message),
          model: payload && payload.model,
          providers: payload && payload.providers,
          diagnostics: payload && payload.diagnostics
        });
      } catch (_error) { /* 日志出口失败不影响响应 */ }
    }
    return writeJson(res, status, payload);
  };
}

async function readJsonObjectBody(ctx) {
  const readRequestBody = ctx.readRequestBody || (ctx.deps && ctx.deps.readRequestBody);
  const writeJson = ctx.writeJson || (ctx.deps && ctx.deps.writeJson);
  if (typeof readRequestBody !== 'function') {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_request_body', detail: '请求体无效' });
    return null;
  }
  const buffer = await readRequestBody(ctx.req, { maxBytes: 1024 * 1024 }).catch(() => null);
  if (!buffer) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_request_body', detail: '读取请求体失败' });
    return null;
  }
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      writeJson(ctx.res, 400, { ok: false, error: 'invalid_alias', detail: '请求体必须是 JSON 对象' });
      return null;
    }
    return parsed;
  } catch (_error) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_json', detail: '请求体不是合法 JSON' });
    return null;
  }
}

async function handleWebUiModelAliasRoutes(ctx) {
  const { method, pathname } = ctx;
  if (pathname !== COLLECTION_PATH && !pathname.startsWith(`${COLLECTION_PATH}/`)) return false;

  const loggedCtx = { ...ctx, writeJson: createLoggedWriteJson(ctx, method, pathname) };

  if (pathname === COLLECTION_PATH) {
    if (method === 'GET') {
      return proxyWebuiGo(loggedCtx, {
        method: 'GET',
        path: GO_BASE_PATH,
        passStatuses: PASS_STATUSES,
        message: GO_UNAVAILABLE_MESSAGE
      });
    }
    if (method === 'POST') {
      const payload = await readJsonObjectBody(loggedCtx);
      if (!payload) return true;
      return proxyWebuiGo(loggedCtx, {
        method: 'POST',
        path: GO_BASE_PATH,
        body: payload,
        passStatuses: PASS_STATUSES,
        message: GO_UNAVAILABLE_MESSAGE
      });
    }
    loggedCtx.writeJson(loggedCtx.res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  if (pathname === TARGETS_PATH) {
    if (method === 'GET') {
      return proxyWebuiGo(loggedCtx, {
        method: 'GET',
        path: `${GO_BASE_PATH}/targets`,
        passStatuses: PASS_STATUSES,
        message: GO_UNAVAILABLE_MESSAGE
      });
    }
    loggedCtx.writeJson(loggedCtx.res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  if (pathname === REPLACE_PATH) {
    if (method === 'POST') {
      const payload = await readJsonObjectBody(loggedCtx);
      if (!payload) return true;
      return proxyWebuiGo(loggedCtx, {
        method: 'POST',
        path: `${GO_BASE_PATH}/replace`,
        body: payload,
        passStatuses: PASS_STATUSES,
        message: GO_UNAVAILABLE_MESSAGE
      });
    }
    loggedCtx.writeJson(loggedCtx.res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  const match = String(pathname || '').match(ITEM_PATTERN);
  if (!match) return false;
  const encodedId = encodeURIComponent(match[1]);
  const isToggle = match[2] === 'toggle';

  if (method === 'PUT' && !isToggle) {
    const payload = await readJsonObjectBody(loggedCtx);
    if (!payload) return true;
    return proxyWebuiGo(loggedCtx, {
      method: 'PUT',
      path: `${GO_BASE_PATH}/${encodedId}`,
      body: payload,
      passStatuses: PASS_STATUSES,
      message: GO_UNAVAILABLE_MESSAGE
    });
  }

  if (method === 'DELETE' && !isToggle) {
    return proxyWebuiGo(loggedCtx, {
      method: 'DELETE',
      path: `${GO_BASE_PATH}/${encodedId}`,
      passStatuses: PASS_STATUSES,
      message: GO_UNAVAILABLE_MESSAGE
    });
  }

  if (method === 'POST' && isToggle) {
    return proxyWebuiGo(loggedCtx, {
      method: 'POST',
      path: `${GO_BASE_PATH}/${encodedId}/toggle`,
      passStatuses: PASS_STATUSES,
      message: GO_UNAVAILABLE_MESSAGE
    });
  }

  loggedCtx.writeJson(loggedCtx.res, 405, { ok: false, error: 'method_not_allowed' });
  return true;
}

module.exports = { handleWebUiModelAliasRoutes };
