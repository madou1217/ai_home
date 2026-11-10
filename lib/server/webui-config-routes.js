'use strict';

const crypto = require('node:crypto');
const { emitManagementLiveEvent } = require('./management-live');

function makeServerRestartJobId() {
  return [
    'server-restart',
    Date.now().toString(36),
    crypto.randomBytes(4).toString('hex')
  ].join('-');
}

function buildRestartEvent(job, status, extra = {}) {
  const now = Date.now();
  return {
    type: 'restart',
    jobId: job.id,
    status,
    createdAt: job.createdAt,
    updatedAt: now,
    ...extra
  };
}

function emitRestartEvent(ctx, event) {
  try {
    return emitManagementLiveEvent(ctx, event);
  } catch (_error) {
    return false;
  }
}

function toPublicServerConfig(config = {}) {
  return {
    ...config,
    apiKey: '',
    managementKey: '',
    apiKeyConfigured: Boolean(String(config.apiKey || '').trim()),
    managementKeyConfigured: Boolean(String(config.managementKey || '').trim())
  };
}

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

function startRestartJob(ctx, job) {
  const timer = setTimeout(async () => {
    emitRestartEvent(ctx, buildRestartEvent(job, 'starting'));
    try {
      const result = await ctx.deps.restartServerWithStoredConfig();
      emitRestartEvent(ctx, buildRestartEvent(job, 'started', {
        pid: Number(result && result.pid || 0),
        appliedConfig: toPublicServerConfig(
          result && result.appliedConfig ? result.appliedConfig : {}
        )
      }));
    } catch (error) {
      emitRestartEvent(ctx, buildRestartEvent(job, 'failed', {
        error: 'server_restart_failed',
        message: String((error && error.message) || error || 'unknown')
      }));
    }
  }, 0);
  if (typeof timer.unref === 'function') timer.unref();
}

async function handleGetUsageConfigRequest(ctx) {
  const { deps, writeJson } = ctx;
  // GET 固定读 Go：与自动换号运行时同一份 config:usage，Node 不再本地解析默认值。
  const goHost = deps && deps.goCoreSync;
  if (!goHost || typeof goHost.getUsageConfig !== 'function') {
    writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，用量配置不可读' });
    return true;
  }
  let response = null;
  try {
    response = await goHost.getUsageConfig();
  } catch (_error) {
    response = null;
  }
  if (response && response.ok === true && response.data) {
    writeJson(ctx.res, 200, response.data);
    return true;
  }
  writeJson(ctx.res, 503, {
    ok: false,
    error: String((response && response.data && response.data.error) || (response && response.errorCode) || 'go_core_unavailable'),
    message: 'Go Core 未就绪，用量配置不可读'
  });
  return true;
}

async function handleSetUsageConfigRequest(ctx) {
  const { deps, readRequestBody, writeJson } = ctx;
  const payload = await readRequestBody(ctx.req, { maxBytes: 1024 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  if (!payload || !payload.config) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  // POST 固定写 Go：规范化（间隔白名单/阈值/自动换号）在 Go 侧完成并整份落库。
  const goHost = deps && deps.goCoreSync;
  if (!goHost || typeof goHost.setUsageConfig !== 'function') {
    writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，用量配置不可写' });
    return true;
  }
  let response = null;
  try {
    response = await goHost.setUsageConfig(payload.config);
  } catch (_error) {
    response = null;
  }
  if (response && response.ok === true) {
    writeJson(ctx.res, 200, response.data || { ok: true });
    return true;
  }
  const status = Number(response && response.status) || 0;
  if (status === 400 && response && response.data) {
    writeJson(ctx.res, 400, response.data);
    return true;
  }
  writeJson(ctx.res, 503, {
    ok: false,
    error: String((response && response.data && response.data.error) || (response && response.errorCode) || 'go_core_unavailable'),
    message: 'Go Core 未就绪，用量配置不可写'
  });
  return true;
}

async function handleGetServerConfigRequest(ctx) {
  const { deps, writeJson } = ctx;
  // GET 固定读 Go：公开视图（密钥隐藏）由 Go 从同一份 config:server 产出。
  const goHost = deps && deps.goCoreSync;
  if (!goHost || typeof goHost.getServerConfig !== 'function') {
    writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，server 配置不可读' });
    return true;
  }
  let response = null;
  try {
    response = await goHost.getServerConfig();
  } catch (_error) {
    response = null;
  }
  if (response && response.ok === true && response.data) {
    writeJson(ctx.res, 200, response.data);
    return true;
  }
  writeJson(ctx.res, 503, {
    ok: false,
    error: String((response && response.data && response.data.error) || (response && response.errorCode) || 'go_core_unavailable'),
    message: 'Go Core 未就绪，server 配置不可读'
  });
  return true;
}

async function handleSetServerConfigRequest(ctx) {
  const { deps, readRequestBody, writeJson } = ctx;
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
  try {
    const patch = normalizeServerConfigPatch(payload.config);
    const config = typeof deps.writeServerConfig === 'function'
      ? deps.writeServerConfig(patch)
      : patch;
    writeJson(ctx.res, 200, { ok: true, config: toPublicServerConfig(config) });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'set_server_config_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

async function handleRotateManagementKeyRequest(ctx) {
  const { deps, readRequestBody, writeJson } = ctx;
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
  if (typeof deps.rotateManagementKey !== 'function') {
    writeJson(ctx.res, 503, { ok: false, error: 'management_key_rotation_unavailable' });
    return true;
  }
  try {
    const result = await Promise.resolve(deps.rotateManagementKey({
      req: ctx.req,
      managementKey: payload.managementKey
    }));
    writeJson(ctx.res, 200, {
      ok: true,
      managementKeyConfigured: result.managementKeyConfigured === true,
      rotatedAt: Number(result.rotatedAt) || Date.now()
    });
    return true;
  } catch (error) {
    writeJson(ctx.res, Number(error && error.statusCode) || 500, {
      ok: false,
      error: String(error && error.code || 'management_key_rotation_failed'),
      message: String(error && error.message || 'Management Key 轮换失败。')
    });
    return true;
  }
}

async function handleRestartServerRequest(ctx) {
  const { deps, writeJson } = ctx;
  if (typeof deps.restartServerWithStoredConfig !== 'function') {
    writeJson(ctx.res, 503, { ok: false, error: 'server_restart_unavailable' });
    return true;
  }
  const job = {
    id: makeServerRestartJobId(),
    status: 'queued',
    createdAt: Date.now()
  };
  const queued = buildRestartEvent(job, 'queued');
  emitRestartEvent(ctx, queued);
  startRestartJob(ctx, job);
  writeJson(ctx.res, 202, {
    ok: true,
    accepted: true,
    restarting: true,
    job: queued
  });
  return true;
}

module.exports = {
  handleGetUsageConfigRequest,
  handleSetUsageConfigRequest,
  handleGetServerConfigRequest,
  handleSetServerConfigRequest,
  handleRotateManagementKeyRequest,
  handleRestartServerRequest
};
