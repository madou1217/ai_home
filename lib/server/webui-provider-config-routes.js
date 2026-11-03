'use strict';

// WebUI：Provider 配置文件工作台路由。
//
// 路径全部落在 /v0/webui/toolkit/provider-configs 下；provider/file 由声明式注册表
// （lib/providers/config-files.js）校验，用户无法传入任意路径。
//
//   GET    /v0/webui/toolkit/provider-configs
//   GET    /v0/webui/toolkit/provider-configs/:provider/:fileId
//   PUT    /v0/webui/toolkit/provider-configs/:provider/:fileId
//   POST   /v0/webui/toolkit/provider-configs/:provider/:fileId/validate
//   GET    /v0/webui/toolkit/provider-configs/:provider/:fileId/history
//   GET    /v0/webui/toolkit/provider-configs/:provider/:fileId/history/:entryId
//   POST   /v0/webui/toolkit/provider-configs/:provider/:fileId/history/:entryId/restore
//   GET    /v0/webui/toolkit/provider-configs/:provider/:fileId/export?mode=redacted|raw

const {
  ProviderConfigError,
  exportConfigFile,
  listConfigHistory,
  listConfigProviders,
  readConfigFile,
  readConfigHistoryEntry,
  restoreConfigHistoryEntry,
  saveConfigFile,
  validateConfigFile
} = require('../cli/services/toolkit/provider-config-manager');

const ROUTE_PREFIX = '/v0/webui/toolkit/provider-configs';

function jsonResponse(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req, maxBytes = 3 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function buildOptions(ctx = {}) {
  const deps = ctx.deps || {};
  return {
    ...deps,
    ...ctx,
    fs: ctx.fs || deps.fs,
    path: ctx.path || deps.path,
    os: ctx.os || deps.os,
    processObj: ctx.processObj || deps.processObj,
    spawnSync: ctx.spawnSync || deps.spawnSync,
    hostHomeDir: ctx.hostHomeDir || deps.hostHomeDir,
    aiHomeDir: ctx.aiHomeDir || deps.aiHomeDir,
    env: ctx.env || deps.env
  };
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

function sendError(res, error) {
  const code = error instanceof ProviderConfigError
    ? error.code
    : String(error && error.code || '').trim();
  const message = String(error && error.message || error || 'Provider 配置请求失败');
  const statusByCode = {
    provider_config_unknown_file: 404,
    provider_config_not_found: 404,
    provider_config_history_entry_not_found: 404,
    provider_config_conflict: 409,
    provider_config_validation_failed: 422,
    provider_config_too_large: 413,
    provider_config_not_writable: 403,
    provider_config_read_failed: 500,
    provider_config_save_failed: 500,
    provider_config_export_failed: 500
  };
  const status = statusByCode[code]
    || (message === 'Body too large' ? 413 : error instanceof SyntaxError ? 400 : 500);
  jsonResponse(res, status, {
    ok: false,
    error: code || 'provider_config_request_failed',
    message,
    ...(error && error.validation ? { validation: error.validation } : {})
  });
}

async function handleWebUiProviderConfigRoutes(req, res, method, pathname, ctx = {}) {
  const route = matchRoute(pathname);
  if (!route) return false;
  const options = buildOptions(ctx);
  const { parts } = route;

  try {
    if (parts.length === 0) {
      if (method !== 'GET') {
        jsonResponse(res, 405, { ok: false, error: 'method_not_allowed', message: '仅支持 GET' });
        return true;
      }
      jsonResponse(res, 200, listConfigProviders(options));
      return true;
    }

    const [provider, fileId, action, entryId, action2] = parts;

    if (parts.length === 2) {
      if (method === 'GET') {
        jsonResponse(res, 200, readConfigFile(provider, fileId, options));
        return true;
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req);
        if (typeof body.content !== 'string') {
          jsonResponse(res, 400, { ok: false, error: 'content_required', message: '必须提供配置文本内容' });
          return true;
        }
        jsonResponse(res, 200, saveConfigFile(provider, fileId, body.content, {
          ...options,
          expectedRevision: body.revision,
          note: body.note
        }));
        return true;
      }
      jsonResponse(res, 405, { ok: false, error: 'method_not_allowed', message: '仅支持 GET / PUT' });
      return true;
    }

    if (parts.length === 3) {
      if (action === 'history' && method === 'GET') {
        jsonResponse(res, 200, listConfigHistory(provider, fileId, options));
        return true;
      }
      if (action === 'validate' && method === 'POST') {
        const body = await parseJsonBody(req);
        if (typeof body.content !== 'string') {
          jsonResponse(res, 400, { ok: false, error: 'content_required', message: '必须提供配置文本内容' });
          return true;
        }
        jsonResponse(res, 200, validateConfigFile(provider, fileId, body.content, options));
        return true;
      }
      if (action === 'export' && method === 'GET') {
        const requestUrl = new URL(req.url || pathname, 'http://localhost');
        jsonResponse(res, 200, exportConfigFile(
          provider,
          fileId,
          requestUrl.searchParams.get('mode') || 'redacted',
          options
        ));
        return true;
      }
      jsonResponse(res, 404, { ok: false, error: 'provider_config_route_not_found', message: '未知的配置操作' });
      return true;
    }

    if (parts.length === 4 && action === 'history' && method === 'GET') {
      jsonResponse(res, 200, readConfigHistoryEntry(provider, fileId, entryId, options));
      return true;
    }

    if (parts.length === 5 && action === 'history' && action2 === 'restore' && method === 'POST') {
      jsonResponse(res, 200, restoreConfigHistoryEntry(provider, fileId, entryId, options));
      return true;
    }

    jsonResponse(res, 404, { ok: false, error: 'provider_config_route_not_found', message: '未知的配置操作' });
    return true;
  } catch (error) {
    sendError(res, error);
    return true;
  }
}

module.exports = {
  ROUTE_PREFIX,
  handleWebUiProviderConfigRoutes,
  matchRoute
};
