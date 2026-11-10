'use strict';

const {
  inferControlEndpoint
} = require('./control-plane-endpoint-hints');
const { listControlPlaneProfiles } = require('./control-plane-profile-store');
const { isLoopbackHostName } = require('./webui-auth-gate');

async function readJsonPayload(ctx) {
  const body = await ctx.readRequestBody(ctx.req, { maxBytes: 1024 * 1024 }).catch(() => null);
  if (!body) return {};
  try {
    return body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
  } catch (_error) {
    return null;
  }
}

function profileDeps(ctx) {
  return {
    fs: ctx.fs,
    aiHomeDir: ctx.aiHomeDir
  };
}

async function handleListEndpointHints(ctx) {
  const goHost = ctx.deps && ctx.deps.goCoreSync;
  if (!goHost || typeof goHost.getControlPlaneEndpoints !== 'function') {
    ctx.writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，端点提示不可读' });
    return true;
  }
  let response = null;
  try {
    response = await goHost.getControlPlaneEndpoints({
      endpoint: inferControlEndpoint(ctx),
      host: ctx.options && ctx.options.host,
      port: ctx.options && ctx.options.port
    });
  } catch (_error) {
    response = null;
  }
  if (response && response.ok === true && response.data) {
    ctx.writeJson(ctx.res, 200, response.data);
    return true;
  }
  writeProxyFailure(ctx, response, 'Go Core 未就绪，端点提示不可读');
  return true;
}

function writeProxyFailure(ctx, response, message) {
  const status = Number(response && response.status) || 0;
  if ((status === 400 || status === 404) && response && response.data) {
    ctx.writeJson(ctx.res, status, response.data);
    return;
  }
  ctx.writeJson(ctx.res, 503, {
    ok: false,
    error: String((response && response.data && response.data.error) || (response && response.errorCode) || 'go_core_unavailable'),
    message
  });
}

async function callProfiles(ctx, method, args, message) {
  const goHost = ctx.deps && ctx.deps.goCoreSync;
  if (!goHost || typeof goHost[method] !== 'function') {
    ctx.writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message });
    return true;
  }
  let response = null;
  try {
    response = await goHost[method](...args);
  } catch (_error) {
    response = null;
  }
  if (response && response.ok === true && response.data) {
    ctx.writeJson(ctx.res, 200, response.data);
    return true;
  }
  writeProxyFailure(ctx, response, message);
  return true;
}

async function handleListProfiles(ctx) {
  return callProfiles(ctx, 'getControlPlaneProfiles', [], 'Go Core 未就绪，控制面 profiles 不可读');
}

// 本机页面引导：只对 loopback 页面开放（鉴权门已做窄口校验），
// 把本机 profile 连同当前 Management Key 交回给浏览器，修复「localStorage 被清空后
// 永远停在未连接」的死锁——客户端没有 Key 就读不到共享 profile，而共享 profile 需要 Key。
// 返回的是服务端当前真相：endpoint 用浏览器地址栏的 loopback Host（端口映射时也能对上），
// Key 取当前生效值。
async function handleBootstrapLocalProfile(ctx) {
  const managementKey = String(ctx.requiredManagementKey || '').trim();
  if (!managementKey) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: 'management_key_not_configured' });
    return true;
  }
  const requestHost = String(ctx.req && ctx.req.headers && ctx.req.headers.host || '').trim();
  const port = Number(ctx.options && ctx.options.port) || 9527;
  const endpoint = isLoopbackHostName(requestHost)
    ? `http://${requestHost}`
    : `http://127.0.0.1:${port}`;
  const store = listControlPlaneProfiles(profileDeps(ctx));
  const existing = store.profiles.find((profile) => profile.endpoint === endpoint) || null;
  const profile = {
    ...(existing || {}),
    id: (existing && existing.id) || 'local',
    name: (existing && existing.name) || 'local',
    endpoint,
    state: 'ready',
    managementKey
  };
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    profile,
    activeProfileId: store.activeProfileId || profile.id
  });
  return true;
}

async function handleSaveProfile(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  return callProfiles(ctx, 'saveControlPlaneProfile', [payload], 'Go Core 未就绪，控制面 profile 不可写');
}

async function handleSetActiveProfile(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  return callProfiles(ctx, 'setActiveControlPlaneProfile', [payload.profileId], 'Go Core 未就绪，控制面 profile 不可切换');
}

async function handleRemoveProfile(ctx, profileId) {
  return callProfiles(ctx, 'removeControlPlaneProfile', [profileId], 'Go Core 未就绪，控制面 profile 不可删除');
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
