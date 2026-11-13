'use strict';

const { proxyWebuiGo } = require('./webui-go-proxy');

const COLLECTION_PATH = '/v0/webui/upstream-error-mappings';
const GO_BASE_PATH = '/v1/management/webui/upstream-error-mappings';
const ITEM_PATTERN = /^\/v0\/webui\/upstream-error-mappings\/([^/]+?)(?:\/(toggle))?$/;

// Go 的组接口用 DisallowUnknownFields 解码：position/version/createdAtMs 是 Go 自己
// 返回的元数据，前端编辑时可能原样带回，写体只转发组字段。
const GO_GROUP_FIELDS = Object.freeze(['id', 'name', 'description', 'provider', 'enabled', 'rules']);
const PASS_STATUSES = Object.freeze([400, 404, 405, 409]);
const GO_UNAVAILABLE_MESSAGE = 'Go Core 上游错误映射组服务不可用';

function pickGoGroupFields(payload) {
  const out = {};
  for (const key of GO_GROUP_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== undefined) {
      out[key] = payload[key];
    }
  }
  return out;
}

function positiveVersion(value) {
  const version = typeof value === 'string' ? Number(value) : value;
  return Number.isInteger(version) && version > 0 ? version : undefined;
}

function requestVersion(ctx) {
  const params = ctx && ctx.url && ctx.url.searchParams;
  return params ? positiveVersion(params.get('version')) : undefined;
}

async function parseJsonObjectBody(ctx, { allowEmpty = false } = {}) {
  const readRequestBody = ctx.readRequestBody || (ctx.deps && ctx.deps.readRequestBody);
  const writeJson = ctx.writeJson || (ctx.deps && ctx.deps.writeJson);
  if (typeof readRequestBody !== 'function') {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_mapping_group', message: 'invalid_request_body' });
    return null;
  }
  let buffer;
  try {
    buffer = await readRequestBody(ctx.req, { maxBytes: 1024 * 1024 });
  } catch (error) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: (error && error.code) || 'invalid_mapping_group',
      message: String((error && error.message) || error || 'invalid_request_body')
    });
    return null;
  }
  const raw = buffer ? buffer.toString('utf8').trim() : '';
  if (!raw && allowEmpty) return {};
  try {
    const payload = raw ? JSON.parse(raw) : null;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      writeJson(ctx.res, 400, { ok: false, error: 'invalid_mapping_group', message: 'invalid_mapping_group_payload' });
      return null;
    }
    return payload;
  } catch (error) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'invalid_mapping_group',
      message: String((error && error.message) || error || 'invalid_json')
    });
    return null;
  }
}

async function handleWebUiUpstreamErrorMappingRoutes(ctx) {
  const { method, pathname } = ctx;
  const writeJson = ctx.writeJson || (ctx.deps && ctx.deps.writeJson);
  if (pathname !== COLLECTION_PATH && !pathname.startsWith(`${COLLECTION_PATH}/`)) return false;

  if (pathname === COLLECTION_PATH) {
    if (method === 'GET') {
      return proxyWebuiGo(ctx, {
        method: 'GET',
        path: GO_BASE_PATH,
        passStatuses: PASS_STATUSES,
        message: GO_UNAVAILABLE_MESSAGE
      });
    }
    if (method === 'POST') {
      const payload = await parseJsonObjectBody(ctx);
      if (!payload) return true;
      return proxyWebuiGo(ctx, {
        method: 'POST',
        path: GO_BASE_PATH,
        body: pickGoGroupFields(payload),
        passStatuses: PASS_STATUSES,
        message: GO_UNAVAILABLE_MESSAGE
      });
    }
    writeJson(ctx.res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  const match = String(pathname || '').match(ITEM_PATTERN);
  if (!match || !match[1]) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_mapping_group_path' });
    return true;
  }
  let id = '';
  try {
    id = decodeURIComponent(match[1]).trim();
  } catch (_error) {
    id = '';
  }
  if (!id) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_mapping_group_path' });
    return true;
  }
  const isToggle = match[2] === 'toggle';
  const encodedId = encodeURIComponent(id);

  if (method === 'GET' && !isToggle) {
    return proxyWebuiGo(ctx, {
      method: 'GET',
      path: `${GO_BASE_PATH}/${encodedId}`,
      passStatuses: PASS_STATUSES,
      message: GO_UNAVAILABLE_MESSAGE
    });
  }

  if (method === 'POST' && isToggle) {
    const payload = await parseJsonObjectBody(ctx, { allowEmpty: true });
    if (!payload) return true;
    const version = positiveVersion(payload.version) || requestVersion(ctx);
    return proxyWebuiGo(ctx, {
      method: 'POST',
      path: `${GO_BASE_PATH}/${encodedId}/toggle`,
      query: version ? `version=${version}` : '',
      body: version ? { version } : {},
      passStatuses: PASS_STATUSES,
      message: GO_UNAVAILABLE_MESSAGE
    });
  }

  if (method === 'PUT' && !isToggle) {
    const payload = await parseJsonObjectBody(ctx);
    if (!payload) return true;
    const version = positiveVersion(payload.version) || requestVersion(ctx);
    return proxyWebuiGo(ctx, {
      method: 'PUT',
      path: `${GO_BASE_PATH}/${encodedId}`,
      query: version ? `version=${version}` : '',
      body: pickGoGroupFields(payload),
      passStatuses: PASS_STATUSES,
      message: GO_UNAVAILABLE_MESSAGE
    });
  }

  if (method === 'DELETE' && !isToggle) {
    const version = requestVersion(ctx);
    return proxyWebuiGo(ctx, {
      method: 'DELETE',
      path: `${GO_BASE_PATH}/${encodedId}`,
      query: version ? `version=${version}` : '',
      passStatuses: PASS_STATUSES,
      message: GO_UNAVAILABLE_MESSAGE
    });
  }

  writeJson(ctx.res, 405, { ok: false, error: 'method_not_allowed' });
  return true;
}

module.exports = { handleWebUiUpstreamErrorMappingRoutes };
