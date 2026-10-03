'use strict';

const nodeFs = require('node:fs');
const { spawnSync: nodeSpawnSync } = require('node:child_process');
const { executeLifecyclePlan } = require('../lifecycle-plan-executor');

const BREW_CANDIDATES = Object.freeze(['/opt/homebrew/bin/brew', '/usr/local/bin/brew', '/home/linuxbrew/.linuxbrew/bin/brew']);
const STATUS_CACHE_MS = 3000;
// brew services info 是约 1s 的同步调用；按 brew+formula 在模块级缓存，避免每次刷新清单都阻塞网关进程。
const statusCache = new Map();

function resolveBrew(options = {}) {
  const fs = options.fs || nodeFs;
  if (options.brewPath) return options.brewPath;
  return BREW_CANDIDATES.find((candidate) => {
    try { return fs.existsSync(candidate); } catch (_error) { return false; }
  }) || '';
}

function parseServiceInfo(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || ''));
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    return entry && typeof entry === 'object' ? entry : null;
  } catch (_error) {
    return null;
  }
}

/**
 * Homebrew 安装的工具交给 `brew services` 管理（macOS=launchd，Linux=systemd --user）：
 * 启停/重启走 brew，自动重启由 brew 生成的服务定义（KeepAlive / Restart=）负责，只读展示。
 * 这样不与系统服务管理器抢同一个进程，也不会出现两个实例同时连同一个 frps。
 */
function createHomebrewServicesBackend({ formula, label }, options = {}) {
  const spawnSync = options.spawnSync || nodeSpawnSync;
  const runPlan = options.runPlan || executeLifecyclePlan;
  const now = options.now || Date.now;

  function brewPath() {
    return resolveBrew(options);
  }

  function cacheKey() {
    return `${brewPath()}\0${formula}`;
  }

  function readInfo({ fresh = false } = {}) {
    const brew = brewPath();
    if (!brew) return null;
    const cache = statusCache.get(cacheKey());
    if (!fresh && cache && now() - cache.at < STATUS_CACHE_MS) return cache.info;
    let info = null;
    try {
      const result = spawnSync(brew, ['services', 'info', formula, '--json'], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
        env: { ...(options.env || process.env), HOMEBREW_NO_AUTO_UPDATE: '1' }
      });
      info = result && result.status === 0 ? parseServiceInfo(result.stdout) : null;
    } catch (_error) {
      info = null;
    }
    statusCache.set(cacheKey(), { at: now(), info });
    return info;
  }

  function describe() {
    const info = readInfo();
    if (!info) {
      return {
        backend: 'homebrew',
        backendLabel: 'Homebrew 服务',
        controllable: false,
        state: 'unknown',
        message: '无法读取 brew services 状态'
      };
    }
    const running = Boolean(info.running);
    return {
      backend: 'homebrew',
      backendLabel: 'Homebrew 服务',
      controllable: true,
      state: running ? 'running' : (info.exit_code ? 'error' : 'stopped'),
      pid: Number(info.pid) || 0,
      exitCode: info.exit_code == null ? null : Number(info.exit_code),
      autoStart: Boolean(info.registered || info.loaded),
      autoRestart: true,
      settingsEditable: false,
      settingsNote: '自动重启由 Homebrew 服务定义（KeepAlive）保证；开机自启随 brew services 注册状态变化',
      logAvailable: Boolean(info.log_path || info.error_log_path),
      canStart: !running,
      canStop: running || Boolean(info.registered),
      canRestart: running
    };
  }

  async function control(action) {
    const brew = brewPath();
    if (!brew) return { ok: false, error: 'service_backend_unavailable', message: '未找到 brew。' };
    const result = await runPlan({
      command: brew,
      args: ['services', action, formula],
      env: { HOMEBREW_NO_AUTO_UPDATE: '1' },
      timeoutMs: 60000
    }, { ...options, errorPrefix: 'service_control' });
    statusCache.delete(cacheKey());
    if (!result.ok) {
      return {
        ok: false,
        error: 'service_control_failed',
        message: (result.stderr || result.stdout || result.message || `brew services ${action} 失败`).slice(0, 500)
      };
    }
    return { ok: true, output: String(result.stdout || '').slice(0, 2000) };
  }

  function logFiles() {
    const info = readInfo();
    if (!info) return [];
    return Array.from(new Set([info.log_path, info.error_log_path].filter(Boolean)));
  }

  return {
    id: 'homebrew',
    label,
    describe,
    control,
    logFiles,
    updateSettings() {
      return { ok: false, error: 'service_settings_readonly', message: 'Homebrew 服务的自动重启与开机自启由 brew services 管理。' };
    }
  };
}

function clearHomebrewStatusCache() {
  statusCache.clear();
}

module.exports = {
  clearHomebrewStatusCache,
  createHomebrewServicesBackend,
  parseServiceInfo,
  resolveBrew
};
