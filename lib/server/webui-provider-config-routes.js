'use strict';

// WebUI Provider 配置文件工作台路由：
// 全部读写、语法校验、版本历史、恢复与脱敏导出逻辑已迁移至 Go（webuitoolkitextapi + internal/runtime/providerconfigs）。
// Node 侧仅做路由匹配、请求体上限检查，并零回落代理到 /v1/management/webui/toolkit/provider-configs*。

const { readRequestBody, writeJson: sharedWriteJson } = require('./http-utils');
const { proxyWebuiGo } = require('./webui-go-proxy');

const ROUTE_PREFIX = '/v0/webui/toolkit/provider-configs';
const GO_PREFIX = '/v1/management/webui/toolkit/provider-configs';
const MAX_JSON_BODY_BYTES = 3 * 1024 * 1024;
const PROVIDER_CONFIG_PASS_STATUSES = [400, 403, 404, 405, 409, 413, 422];

function defaultWriteJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch (_error) {
    return '';
  }
}

function matchRoute(pathname) {
  const cleanPath = String(pathname || '').split('?')[0].split('#')[0];
  if (cleanPath === ROUTE_PREFIX) return { parts: [] };
  if (!cleanPath.startsWith(`${ROUTE_PREFIX}/`)) return null;
  const parts = cleanPath.slice(ROUTE_PREFIX.length + 1).split('/').filter(Boolean).map(decodeSegment);
  if (parts.some((part) => !part)) return null;
  return { parts };
}

function isBodyTooLargeError(error) {
  const code = String((error && (error.code || error.message)) || '');
  return code === 'request_body_too_large' || code === 'Body too large';
}

async function readJsonBody(req, ctx = {}) {
  const read = ctx.readRequestBody || readRequestBody;
  const buffer = await read(req, { maxBytes: MAX_JSON_BODY_BYTES });
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function sendBodyParseError(write, res, error) {
  if (isBodyTooLargeError(error)) {
    write(res, 413, { ok: false, error: 'provider_config_too_large', message: 'Body too large' });
    return;
  }
  write(res, 400, {
    ok: false,
    error: 'invalid_json_body',
    message: String((error && error.message) || error || 'Provider 配置请求失败')
  });
}

function readQueryString(req) {
  const raw = String((req && req.url) || '');
  const idx = raw.indexOf('?');
  return idx >= 0 ? raw.slice(idx + 1) : '';
}

async function handleWebUiProviderConfigRoutes(req, res, method, pathname, ctx = {}) {
  const route = matchRoute(pathname);
  if (!route) return false;
  const write = ctx.writeJson || ((targetRes, status, data) => defaultWriteJson(targetRes, status, data));
  const proxyCtx = { ...ctx, req, res, method, writeJson: write };
  const { parts } = route;

  if (parts.length === 0) {
    if (method !== 'GET') {
      write(res, 405, { ok: false, error: 'method_not_allowed', message: '仅支持 GET' });
      return true;
    }
    return proxyWebuiGo(proxyCtx, {
      method: 'GET',
      path: GO_PREFIX,
      query: readQueryString(req),
      passStatuses: PROVIDER_CONFIG_PASS_STATUSES,
      useFullBody: true,
      message: 'Go Core 未就绪，Provider 配置列表不可用'
    });
  }

  const [provider, fileId, action, entryId, action2] = parts;
  const filePath = `${GO_PREFIX}/${encodeURIComponent(provider)}/${encodeURIComponent(fileId)}`;

  if (parts.length === 2) {
    if (method === 'GET') {
      return proxyWebuiGo(proxyCtx, {
        method: 'GET',
        path: filePath,
        passStatuses: PROVIDER_CONFIG_PASS_STATUSES,
        useFullBody: true,
        message: 'Go Core 未就绪，Provider 配置读取不可用'
      });
    }
    if (method === 'PUT') {
      let body;
      try {
        body = await readJsonBody(req, ctx);
      } catch (error) {
        sendBodyParseError(write, res, error);
        return true;
      }
      return proxyWebuiGo(proxyCtx, {
        method: 'PUT',
        path: filePath,
        body,
        passStatuses: PROVIDER_CONFIG_PASS_STATUSES,
        useFullBody: true,
        message: 'Go Core 未就绪，Provider 配置保存不可用'
      });
    }
    write(res, 405, { ok: false, error: 'method_not_allowed', message: '仅支持 GET / PUT' });
    return true;
  }

  if (parts.length === 3) {
    if (action === 'history' && method === 'GET') {
      return proxyWebuiGo(proxyCtx, {
        method: 'GET',
        path: `${filePath}/history`,
        passStatuses: PROVIDER_CONFIG_PASS_STATUSES,
        useFullBody: true,
        message: 'Go Core 未就绪，Provider 配置历史不可用'
      });
    }
    if (action === 'validate' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req, ctx);
      } catch (error) {
        sendBodyParseError(write, res, error);
        return true;
      }
      return proxyWebuiGo(proxyCtx, {
        method: 'POST',
        path: `${filePath}/validate`,
        body,
        passStatuses: PROVIDER_CONFIG_PASS_STATUSES,
        useFullBody: true,
        message: 'Go Core 未就绪，Provider 配置校验不可用'
      });
    }
    if (action === 'export' && method === 'GET') {
      const requestUrl = new URL(req.url || pathname, 'http://localhost');
      const mode = requestUrl.searchParams.get('mode') || 'redacted';
      return proxyWebuiGo(proxyCtx, {
        method: 'GET',
        path: `${filePath}/export`,
        query: new URLSearchParams({ mode }).toString(),
        passStatuses: PROVIDER_CONFIG_PASS_STATUSES,
        useFullBody: true,
        message: 'Go Core 未就绪，Provider 配置导出不可用'
      });
    }
    write(res, 404, { ok: false, error: 'provider_config_route_not_found', message: '未知的配置操作' });
    return true;
  }

  if (parts.length === 4 && action === 'history' && method === 'GET') {
    return proxyWebuiGo(proxyCtx, {
      method: 'GET',
      path: `${filePath}/history/${encodeURIComponent(entryId)}`,
      passStatuses: PROVIDER_CONFIG_PASS_STATUSES,
      useFullBody: true,
      message: 'Go Core 未就绪，Provider 历史版本读取不可用'
    });
  }

  if (parts.length === 5 && action === 'history' && action2 === 'restore' && method === 'POST') {
    return proxyWebuiGo(proxyCtx, {
      method: 'POST',
      path: `${filePath}/history/${encodeURIComponent(entryId)}/restore`,
      body: {},
      passStatuses: PROVIDER_CONFIG_PASS_STATUSES,
      useFullBody: true,
      message: 'Go Core 未就绪，Provider 历史版本恢复不可用'
    });
  }

  write(res, 404, { ok: false, error: 'provider_config_route_not_found', message: '未知的配置操作' });
  return true;
}

module.exports = {
  ROUTE_PREFIX,
  handleWebUiProviderConfigRoutes,
  matchRoute
};
