'use strict';

const { callGoHost, proxyGo, writeGoFailure } = require('./webui-go-proxy');

async function readJsonPayload(ctx) {
  const body = await ctx.readRequestBody(ctx.req, { maxBytes: 1024 * 1024 }).catch(() => null);
  if (!body) return {};
  try {
    return body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
  } catch (_error) {
    return null;
  }
}

function firstHeaderValue(headers, name) {
  const key = String(name || '').toLowerCase();
  const value = headers && (headers[key] || headers[name]);
  return String(Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();
}

function inferControlEndpoint(ctx) {
  const headers = ctx.req && ctx.req.headers ? ctx.req.headers : {};
  const host = firstHeaderValue(headers, 'x-forwarded-host') || firstHeaderValue(headers, 'host');
  if (!host) return '';
  const proto = firstHeaderValue(headers, 'x-forwarded-proto').toLowerCase().replace(/:$/, '');
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

async function handleListEndpointHints(ctx) {
  return proxyGo(ctx, {
    method: 'getControlPlaneEndpoints',
    args: [{
      endpoint: inferControlEndpoint(ctx),
      host: ctx.options && ctx.options.host,
      port: ctx.options && ctx.options.port
    }],
    message: 'Go Core 未就绪，端点提示不可读'
  });
}

// 本机页面引导：只对 loopback 页面开放（鉴权门已做窄口校验），
// 由 Go 读取 app-state.db 的控制面 profile 并推导当前 endpoint / 端点提示；
// Node 不再本地读 SQLite 或推导 endpoint，只补齐外层 WebUI 鉴权门当前生效的 Management Key。
async function handleBootstrapLocalProfile(ctx) {
  const params = new URLSearchParams();
  const requestHost = String(ctx.req && ctx.req.headers && ctx.req.headers.host || '').trim();
  const port = Number(ctx.options && ctx.options.port) || 0;
  params.set('host', requestHost);
  if (port > 0) params.set('port', String(port));
  const { available, response } = await callGoHost(ctx, 'webuiRequest', [{
    method: 'GET',
    path: `/v1/management/webui/control-plane/bootstrap?${params.toString()}`
  }]);
  if (!available) {
    ctx.writeJson(ctx.res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 未就绪，控制面引导不可用'
    });
    return true;
  }
  if (!response || response.ok !== true || !response.data) {
    return writeGoFailure(ctx, response, {
      message: 'Go Core 未就绪，控制面引导不可用'
    });
  }
  const managementKey = String(ctx.requiredManagementKey || '').trim();
  if (!managementKey) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: 'management_key_not_configured' });
    return true;
  }
  const data = response.data;
  const profile = {
    ...(data.profile && typeof data.profile === 'object' ? data.profile : {}),
    managementKey
  };
  ctx.writeJson(ctx.res, 200, {
    ...data,
    ok: true,
    profile
  });
  return true;
}

async function handleListProfiles(ctx) {
  return proxyGo(ctx, {
    method: 'getControlPlaneProfiles',
    message: 'Go Core 未就绪，控制面 profiles 不可读'
  });
}

async function handleSaveProfile(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  return proxyGo(ctx, {
    method: 'saveControlPlaneProfile',
    args: [payload],
    message: 'Go Core 未就绪，控制面 profile 不可写'
  });
}

async function handleSetActiveProfile(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  return proxyGo(ctx, {
    method: 'setActiveControlPlaneProfile',
    args: [payload.profileId],
    message: 'Go Core 未就绪，控制面 profile 不可切换'
  });
}

async function handleRemoveProfile(ctx, profileId) {
  return proxyGo(ctx, {
    method: 'removeControlPlaneProfile',
    args: [profileId],
    message: 'Go Core 未就绪，控制面 profile 不可删除'
  });
}

async function handleWebUiControlPlaneRoutes(ctx) {
  const { method, pathname } = ctx;

  if (method === 'GET' && pathname === '/v0/webui/control-plane/endpoints') {
    return handleListEndpointHints(ctx);
  }
  if (method === 'GET' && pathname === '/v0/webui/control-plane/bootstrap') {
    return handleBootstrapLocalProfile(ctx);
  }
  if (method === 'GET' && pathname === '/v0/webui/control-plane/profiles') {
    return handleListProfiles(ctx);
  }
  if (method === 'POST' && pathname === '/v0/webui/control-plane/profiles') {
    return handleSaveProfile(ctx);
  }
  if (method === 'POST' && pathname === '/v0/webui/control-plane/profiles/active') {
    return handleSetActiveProfile(ctx);
  }
  const removeMatch = pathname.match(/^\/v0\/webui\/control-plane\/profiles\/([^/]+)$/);
  if (method === 'DELETE' && removeMatch) {
    return handleRemoveProfile(ctx, decodeURIComponent(removeMatch[1]));
  }

  return false;
}

module.exports = {
  handleWebUiControlPlaneRoutes
};
