'use strict';

const crypto = require('node:crypto');
const { DEFAULT_SERVER_CONFIG } = require('./server-config-store');
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

function startRestartJob(ctx, job) {
  const timer = setTimeout(async () => {
    emitRestartEvent(ctx, buildRestartEvent(job, 'starting'));
    try {
      const result = await ctx.deps.restartServerWithStoredConfig();
      emitRestartEvent(ctx, buildRestartEvent(job, 'started', {
        pid: Number(result && result.pid || 0),
        appliedConfig: result && result.appliedConfig ? result.appliedConfig : {}
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
  const { fs, deps, writeJson } = ctx;
  try {
    const { getUsageConfig } = require('../usage/config-store');
    const config = getUsageConfig({ fs, aiHomeDir: deps.aiHomeDir });
    writeJson(ctx.res, 200, { ok: true, config });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'get_config_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

async function handleSetUsageConfigRequest(ctx) {
  const { fs, deps, readRequestBody, writeJson } = ctx;
  const payload = await readRequestBody(ctx.req, { maxBytes: 1024 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  if (!payload || !payload.config) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    const { setUsageConfig } = require('../usage/config-store');
    setUsageConfig({ fs, aiHomeDir: deps.aiHomeDir }, payload.config);
    writeJson(ctx.res, 200, { ok: true });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'set_config_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

async function handleGetServerConfigRequest(ctx) {
  const { deps, writeJson } = ctx;
  try {
    const config = typeof deps.readServerConfig === 'function'
      ? deps.readServerConfig()
      : { ...DEFAULT_SERVER_CONFIG };
    writeJson(ctx.res, 200, { ok: true, config });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'get_server_config_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
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
  try {
    const config = typeof deps.writeServerConfig === 'function'
      ? deps.writeServerConfig(payload.config)
      : payload.config;
    writeJson(ctx.res, 200, { ok: true, config });
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
  handleRestartServerRequest
};
