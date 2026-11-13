'use strict';

// WebUI 配置、Management Key 轮换与 Server 重启薄代理。
// 业务逻辑、持久化与独立重启进程拉起全部在 Go；Node 仅做请求体边界校验与透传。

const { parseBearerCredential } = require('./management-key-auth');
const { callGoHost, proxyGo, proxyWebuiGo, writeGoFailure } = require('./webui-go-proxy');

function normalizeServerConfigPatch(config = {}) {
  const patch = config && typeof config === 'object' ? { ...config } : {};
  for (const key of ['apiKey', 'managementKey']) {
    if (String(patch[key] || '').trim()) continue;
    delete patch[key];
  }
  return patch;
}

function containsManagementKeyChange(config = {}) {
  return Boolean(
    config
    && typeof config === 'object'
    && Object.prototype.hasOwnProperty.call(config, 'managementKey')
    && String(config.managementKey || '').trim()
  );
}

async function handleGetUsageConfigRequest(ctx) {
  return proxyGo(ctx, {
    method: 'getUsageConfig',
    message: 'Go Core 未就绪，用量配置不可读'
  });
}

async function handleSetUsageConfigRequest(ctx) {
  const { readRequestBody, writeJson } = ctx;
  const payload = await readRequestBody(ctx.req, { maxBytes: 1024 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  if (!payload || !payload.config) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  return proxyGo(ctx, {
    method: 'setUsageConfig',
    args: [payload.config],
    message: 'Go Core 未就绪，用量配置不可写'
  });
}

async function handleGetServerConfigRequest(ctx) {
  return proxyGo(ctx, {
    method: 'getServerConfig',
    message: 'Go Core 未就绪，server 配置不可读'
  });
}

async function handleSetServerConfigRequest(ctx) {
  const { readRequestBody, writeJson } = ctx;
  const payload = await readRequestBody(ctx.req, { maxBytes: 1024 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  if (!payload || !payload.config) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  if (containsManagementKeyChange(payload.config)) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'management_key_rotation_required',
      message: '请使用专用 Management Key 轮换操作。'
    });
    return true;
  }
  return proxyGo(ctx, {
    method: 'setServerConfig',
    args: [normalizeServerConfigPatch(payload.config)],
    message: 'Go Core 未就绪，server 配置不可写'
  });
}

async function handleRotateManagementKeyRequest(ctx) {
  const { deps = {}, readRequestBody, writeJson } = ctx;
  if (ctx.res && typeof ctx.res.setHeader === 'function') {
    ctx.res.setHeader('cache-control', 'no-store');
    ctx.res.setHeader('pragma', 'no-cache');
    ctx.res.setHeader('referrer-policy', 'no-referrer');
    ctx.res.setHeader('x-content-type-options', 'nosniff');
  }
  const payload = await readRequestBody(ctx.req, { maxBytes: 16 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  if (!payload || typeof payload !== 'object' || !String(payload.managementKey || '').trim()) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }

  const currentManagementKey = parseBearerCredential(ctx.req);
  const { available, response } = await callGoHost(ctx, 'webuiRequest', [{
    method: 'POST',
    path: '/v1/management/webui/server-config/management-key/rotate',
    body: {
      managementKey: String(payload.managementKey).trim(),
      ...(currentManagementKey ? { currentManagementKey } : {})
    }
  }]);
  if (!available) {
    writeJson(ctx.res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 未就绪，Management Key 轮换不可用'
    });
    return true;
  }
  if (response && response.ok === true && response.data) {
    if (typeof deps.applyRotatedManagementKey === 'function') {
      await Promise.resolve(deps.applyRotatedManagementKey(response.data.managementKey || payload.managementKey));
    }
    writeJson(ctx.res, Number(response.status) || 200, {
      ok: true,
      managementKeyConfigured: response.data.managementKeyConfigured === true,
      rotatedAt: Number(response.data.rotatedAt) || Date.now()
    });
    return true;
  }
  return writeGoFailure(ctx, response, {
    passStatuses: [400, 401, 403, 404, 409, 500, 503],
    fallbackStatus: 503,
    fallbackCode: 'management_key_rotation_unavailable',
    message: 'Management Key 轮换失败。'
  });
}

async function handleRestartServerRequest(ctx) {
  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: '/v1/management/webui/server/restart',
    status: 202,
    passStatuses: [400, 404, 409, 503],
    message: 'Go Core 未就绪，server 重启不可用'
  });
}

module.exports = {
  handleGetUsageConfigRequest,
  handleSetUsageConfigRequest,
  handleGetServerConfigRequest,
  handleSetServerConfigRequest,
  handleRotateManagementKeyRequest,
  handleRestartServerRequest
};
