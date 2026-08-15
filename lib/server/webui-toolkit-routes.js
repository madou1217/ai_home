'use strict';

const {
  listManagedApps,
  installApp,
  installAppHooks
} = require('../cli/services/toolkit/app-manager');
const {
  getEnvironmentsSummary
} = require('../cli/services/toolkit/env-manager');
const {
  getMirrorsStatus,
  setNpmRegistry,
  setPipIndexUrl,
  testEndpointLatency
} = require('../cli/services/toolkit/mirror-manager');
const {
  getProxyStatus,
  setGitProxy,
  setNpmProxy,
  testConnectivity
} = require('../cli/services/toolkit/proxy-manager');
const {
  ToolkitConfigError,
  readManagedAppConfig,
  saveManagedAppConfig
} = require('../cli/services/toolkit/config-editor');
const {
  listManagedTools,
  readManagedToolConfig,
  saveManagedToolConfig
} = require('../cli/services/toolkit/tool-manager');
const {
  handleWebUiProxyPoolRoutes
} = require('./webui-proxy-pool-routes');

function jsonResponse(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req, maxBytes = 1e6) {
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
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function buildToolkitOptions(ctx = {}) {
  const deps = ctx.deps || {};
  return {
    ...ctx,
    ...deps,
    fs: ctx.fs || deps.fs,
    path: ctx.path || deps.path,
    os: ctx.os || deps.os,
    processObj: ctx.processObj || deps.processObj,
    spawnSync: ctx.spawnSync || deps.spawnSync,
    hostHomeDir: ctx.hostHomeDir || deps.hostHomeDir,
    aiHomeDir: ctx.aiHomeDir || deps.aiHomeDir
  };
}

function sendToolkitError(res, error) {
  const code = error instanceof ToolkitConfigError
    ? error.code
    : String(error && error.code || '').trim();
  const message = String(error && error.message || error || 'Toolkit 请求失败');
  const statusByCode = {
    config_conflict: 409,
    config_too_large: 413,
    unsupported_app: 400,
    unsupported_tool: 400,
    tool_config_unsupported: 400,
    config_target_unavailable: 400,
    privilege_unavailable: 403,
    privilege_denied: 403
  };
  const status = statusByCode[code]
    || (message === 'Body too large' ? 413 : error instanceof SyntaxError ? 400 : 500);
  jsonResponse(res, status, {
    ok: false,
    error: code || 'toolkit_request_failed',
    message
  });
}

function resolveConfigAppId(pathname) {
  const prefix = '/v0/webui/toolkit/apps/';
  const suffix = '/config';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return '';
  const encoded = pathname.slice(prefix.length, -suffix.length);
  if (!encoded) return '';
  try {
    return decodeURIComponent(encoded);
  } catch (_error) {
    return '';
  }
}

function resolveConfigToolId(pathname) {
  const prefix = '/v0/webui/toolkit/tools/';
  const suffix = '/config';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return '';
  const encoded = pathname.slice(prefix.length, -suffix.length);
  if (!encoded) return '';
  try {
    return decodeURIComponent(encoded);
  } catch (_error) {
    return '';
  }
}

/**
 * Routes handler for /v0/webui/toolkit/*
 */
async function handleWebUiToolkitRoutes(req, res, method, pathname, ctx = {}) {
  // Proxy pool sub-routes: /v0/webui/toolkit/proxy-pool/*
  if (pathname.startsWith('/v0/webui/toolkit/proxy-pool')) {
    const handled = await handleWebUiProxyPoolRoutes(req, res, method, pathname, ctx);
    if (handled) return true;
  }

  const configAppId = resolveConfigAppId(pathname);
  if (configAppId && method === 'GET') {
    try {
      const data = readManagedAppConfig(configAppId, buildToolkitOptions(ctx));
      jsonResponse(res, 200, data);
    } catch (error) {
      sendToolkitError(res, error);
    }
    return true;
  }

  if (configAppId && method === 'PUT') {
    try {
      const body = await parseJsonBody(req, 3 * 1024 * 1024);
      if (!body || typeof body.content !== 'string') {
        jsonResponse(res, 400, {
          ok: false,
          error: 'content_required',
          message: '必须提供配置文本内容'
        });
        return true;
      }
      const data = saveManagedAppConfig(configAppId, body.content, {
        ...buildToolkitOptions(ctx),
        expectedRevision: body.revision
      });
      jsonResponse(res, 200, data);
    } catch (error) {
      sendToolkitError(res, error);
    }
    return true;
  }

  const configToolId = resolveConfigToolId(pathname);
  if (configToolId && method === 'GET') {
    try {
      const data = readManagedToolConfig(configToolId, buildToolkitOptions(ctx));
      jsonResponse(res, 200, data);
    } catch (error) {
      sendToolkitError(res, error);
    }
    return true;
  }

  if (configToolId && method === 'PUT') {
    try {
      const body = await parseJsonBody(req, 3 * 1024 * 1024);
      if (!body || typeof body.content !== 'string') {
        jsonResponse(res, 400, {
          ok: false,
          error: 'content_required',
          message: '必须提供配置文本内容'
        });
        return true;
      }
      const data = saveManagedToolConfig(configToolId, body.content, {
        ...buildToolkitOptions(ctx),
        expectedRevision: body.revision
      });
      jsonResponse(res, 200, data);
    } catch (error) {
      sendToolkitError(res, error);
    }
    return true;
  }

  if (method === 'GET' && pathname === '/v0/webui/toolkit/tools') {
    try {
      const data = listManagedTools(buildToolkitOptions(ctx));
      jsonResponse(res, 200, data);
    } catch (error) {
      sendToolkitError(res, error);
    }
    return true;
  }

  // 1. GET /v0/webui/toolkit/apps - list all apps/CLIs
  if (method === 'GET' && pathname === '/v0/webui/toolkit/apps') {
    try {
      const data = await listManagedApps(ctx);
      jsonResponse(res, 200, data);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 2. POST /v0/webui/toolkit/apps/install - install or update an app
  if (method === 'POST' && pathname === '/v0/webui/toolkit/apps/install') {
    try {
      const body = await parseJsonBody(req);
      const provider = body.provider || body.providerId;
      if (!provider) {
        jsonResponse(res, 400, { ok: false, error: 'provider_required' });
        return true;
      }
      const result = await installApp(provider, ctx);
      jsonResponse(res, 200, { ok: true, result });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 3. POST /v0/webui/toolkit/apps/hooks - install official hooks
  if (method === 'POST' && pathname === '/v0/webui/toolkit/apps/hooks') {
    try {
      const body = await parseJsonBody(req);
      const providers = body.providers || (body.provider ? [body.provider] : []);
      if (!providers.length) {
        jsonResponse(res, 400, { ok: false, error: 'providers_required' });
        return true;
      }
      const result = await installAppHooks(providers, ctx);
      jsonResponse(res, 200, result);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 4. GET /v0/webui/toolkit/environments - get Node / Python environment status
  if (method === 'GET' && pathname === '/v0/webui/toolkit/environments') {
    try {
      const data = getEnvironmentsSummary(ctx);
      jsonResponse(res, 200, data);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 5. GET /v0/webui/toolkit/mirrors - get npm / pip mirror registries
  if (method === 'GET' && pathname === '/v0/webui/toolkit/mirrors') {
    try {
      const data = await getMirrorsStatus();
      jsonResponse(res, 200, data);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 6. POST /v0/webui/toolkit/mirrors/set - set npm or pip registry
  if (method === 'POST' && pathname === '/v0/webui/toolkit/mirrors/set') {
    try {
      const body = await parseJsonBody(req);
      const { type, url } = body;
      if (type === 'npm') {
        const result = setNpmRegistry(url);
        jsonResponse(res, 200, result);
        return true;
      }
      if (type === 'pip') {
        const result = setPipIndexUrl(url);
        jsonResponse(res, 200, result);
        return true;
      }
      jsonResponse(res, 400, { ok: false, error: 'invalid_type_expected_npm_or_pip' });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 7. POST /v0/webui/toolkit/mirrors/ping - ping a mirror URL
  if (method === 'POST' && pathname === '/v0/webui/toolkit/mirrors/ping') {
    try {
      const body = await parseJsonBody(req);
      const url = body.url;
      if (!url) {
        jsonResponse(res, 400, { ok: false, error: 'url_required' });
        return true;
      }
      const ping = await testEndpointLatency(url);
      jsonResponse(res, 200, ping);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 8. GET /v0/webui/toolkit/proxy - get proxy status
  if (method === 'GET' && pathname === '/v0/webui/toolkit/proxy') {
    try {
      const data = getProxyStatus();
      jsonResponse(res, 200, data);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 9. POST /v0/webui/toolkit/proxy/set - set git / npm proxy
  if (method === 'POST' && pathname === '/v0/webui/toolkit/proxy/set') {
    try {
      const body = await parseJsonBody(req);
      const { target, proxyUrl } = body;
      if (target === 'git') {
        const result = setGitProxy(proxyUrl);
        jsonResponse(res, 200, result);
        return true;
      }
      if (target === 'npm') {
        const result = setNpmProxy(proxyUrl);
        jsonResponse(res, 200, result);
        return true;
      }
      jsonResponse(res, 400, { ok: false, error: 'invalid_target_expected_git_or_npm' });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 10. GET /v0/webui/toolkit/connectivity - test upstream AI connectivity
  if (method === 'GET' && pathname === '/v0/webui/toolkit/connectivity') {
    try {
      const data = await testConnectivity();
      jsonResponse(res, 200, data);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  return false;
}

module.exports = {
  handleWebUiToolkitRoutes
};
