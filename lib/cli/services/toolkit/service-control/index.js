'use strict';

const nodeFs = require('node:fs');
const { createAihSupervisorBackend } = require('./aih-supervisor-backend');
const { createHomebrewServicesBackend, resolveBrew } = require('./homebrew-services-backend');

const SERVICE_ACTIONS = Object.freeze(['start', 'stop', 'restart']);
const MAX_LOG_LINES = 400;
const MAX_LOG_READ_BYTES = 256 * 1024;

/**
 * 服务控制后端选择（策略模式）：
 * - Homebrew 安装且 brew 可用 → brew services（交给 launchd / systemd --user）
 * - 其余（AIH 自管、外部安装、Windows）→ AIH detached 守护
 */
function resolveServiceBackend(plugin, tool, options = {}) {
  const spec = plugin && plugin.service;
  if (!spec) return null;
  if (tool && tool.managedBy === 'homebrew' && spec.homebrewFormula && resolveBrew(options)) {
    return createHomebrewServicesBackend({ formula: spec.homebrewFormula, label: spec.name }, options);
  }
  return createAihSupervisorBackend({ ...spec, id: plugin.id, name: plugin.name }, options);
}

function describeToolService(plugin, tool, options = {}) {
  const backend = resolveServiceBackend(plugin, tool, options);
  if (!backend) return null;
  try {
    return backend.describe(tool);
  } catch (error) {
    return { backend: backend.id, controllable: false, state: 'unknown', message: String(error && error.message || error) };
  }
}

async function controlToolService(plugin, tool, action, options = {}) {
  const normalized = String(action || '').trim().toLowerCase();
  if (!SERVICE_ACTIONS.includes(normalized)) {
    return { ok: false, error: 'unsupported_service_action', message: '仅支持启动、停止和重启。' };
  }
  const backend = resolveServiceBackend(plugin, tool, options);
  if (!backend) return { ok: false, error: 'service_unsupported', message: '该工具不提供服务管理。' };
  const result = await backend.control(normalized, tool);
  return { ...result, service: backend.describe(tool) };
}

function updateToolServiceSettings(plugin, tool, patch = {}, options = {}) {
  const backend = resolveServiceBackend(plugin, tool, options);
  if (!backend) return { ok: false, error: 'service_unsupported', message: '该工具不提供服务管理。' };
  const result = backend.updateSettings(patch);
  return { ...result, service: backend.describe(tool) };
}

function createToolServiceConfig(plugin, tool, options = {}) {
  const backend = resolveServiceBackend(plugin, tool, options);
  if (!backend || typeof backend.createConfig !== 'function') {
    return { ok: false, error: 'service_config_create_unsupported', message: '当前服务后端不支持新建配置。' };
  }
  return backend.createConfig(tool);
}

function tailFile(fs, filePath, maxLines) {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - MAX_LOG_READ_BYTES);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split(/\r?\n/);
      if (start > 0) lines.shift();
      return lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()).filter(Boolean).slice(-maxLines);
    } finally {
      fs.closeSync(fd);
    }
  } catch (_error) {
    return [];
  }
}

function readToolServiceLogs(plugin, tool, options = {}) {
  const backend = resolveServiceBackend(plugin, tool, options);
  if (!backend) return { ok: false, error: 'service_unsupported', message: '该工具不提供服务管理。' };
  const fs = options.fs || nodeFs;
  const limit = Math.min(Math.max(Number(options.lines) || 200, 1), MAX_LOG_LINES);
  const files = backend.logFiles();
  const lines = files.flatMap((file) => tailFile(fs, file, limit)).slice(-limit);
  return { ok: true, backend: backend.id, lines };
}

/** AIH 服务端启动时调用：接管/恢复由 AIH 守护的服务进程。 */
function restoreToolServices(plugins, options = {}) {
  const results = [];
  for (const plugin of plugins) {
    if (!plugin.service) continue;
    const backend = createAihSupervisorBackend({ ...plugin.service, id: plugin.id, name: plugin.name }, options);
    try {
      results.push({ id: plugin.id, ...backend.adopt() });
    } catch (error) {
      results.push({ id: plugin.id, ok: false, error: String(error && error.message || error) });
    }
  }
  return results;
}

module.exports = {
  SERVICE_ACTIONS,
  controlToolService,
  createToolServiceConfig,
  describeToolService,
  readToolServiceLogs,
  resolveServiceBackend,
  restoreToolServices,
  updateToolServiceSettings
};
