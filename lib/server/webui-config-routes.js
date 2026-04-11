'use strict';

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
      : { host: '127.0.0.1', port: 8317, apiKey: '', managementKey: '', openNetwork: false };
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
  try {
    const result = await deps.restartServerWithStoredConfig();
    writeJson(ctx.res, 200, {
      ok: true,
      restarting: true,
      pid: Number(result && result.pid || 0),
      appliedConfig: result && result.appliedConfig ? result.appliedConfig : {}
    });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'server_restart_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

module.exports = {
  handleGetUsageConfigRequest,
  handleSetUsageConfigRequest,
  handleGetServerConfigRequest,
  handleSetServerConfigRequest,
  handleRestartServerRequest
};
