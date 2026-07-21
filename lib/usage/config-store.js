'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readJsonValue,
  writeJsonValue
} = require('../server/app-state-store');

const USAGE_CONFIG_KEY = 'config:usage';
const DEFAULT_AI_HOME_DIR = path.join(os.homedir(), '.ai_home');

const DEFAULTS = {
  active_refresh_interval: '1m',
  background_refresh_interval: '1h',
  threshold_pct: 95
};

const ACTIVE_ALLOWED = new Set(['1m', '3m']);
const BACKGROUND_ALLOWED = new Set(['1h', 'hourly']);

function normalizeThreshold(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULTS.threshold_pct;
  if (num < 1) return 1;
  if (num > 100) return 100;
  return Math.round(num);
}

function normalizeInterval(value, allowed, fallback) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return fallback;
  if (allowed.has(v)) return v === 'hourly' ? '1h' : v;
  return fallback;
}

function normalizeConfig(input = {}) {
  const activeCandidate = input.active_refresh_interval || input.activeRefreshInterval;
  const backgroundCandidate = input.background_refresh_interval || input.backgroundRefreshInterval;
  const thresholdCandidate = input.threshold_pct ?? input.thresholdPct;
  return {
    active_refresh_interval: normalizeInterval(activeCandidate, ACTIVE_ALLOWED, DEFAULTS.active_refresh_interval),
    background_refresh_interval: normalizeInterval(backgroundCandidate, BACKGROUND_ALLOWED, DEFAULTS.background_refresh_interval),
    threshold_pct: normalizeThreshold(thresholdCandidate)
  };
}

function readConfig(options = {}) {
  const fsImpl = options.fs || fs;
  const aiHomeDir = String(options.aiHomeDir || DEFAULT_AI_HOME_DIR).trim();
  const stored = readJsonValue(fsImpl, aiHomeDir, USAGE_CONFIG_KEY);
  return stored && typeof stored === 'object'
    ? normalizeConfig(stored)
    : { ...DEFAULTS };
}

function writeConfig(nextConfig = {}, options = {}) {
  const fsImpl = options.fs || fs;
  const aiHomeDir = String(options.aiHomeDir || DEFAULT_AI_HOME_DIR).trim();
  const normalized = normalizeConfig(nextConfig);
  if (!writeJsonValue(fsImpl, aiHomeDir, USAGE_CONFIG_KEY, normalized)) {
    throw new Error('usage_config_write_failed');
  }
  return normalized;
}

function updateConfig(partial = {}, options = {}) {
  const current = readConfig(options);
  return writeConfig({ ...current, ...partial }, options);
}

/**
 * Web UI 兼容的获取配置函数
 * @param {object} deps - 依赖项 { fs, aiHomeDir }
 * @returns {object} 配置对象
 */
function getUsageConfig(deps = {}) {
  return readConfig(deps);
}

/**
 * Web UI 兼容的设置配置函数
 * @param {object} deps - 依赖项 { fs, aiHomeDir }
 * @param {object} config - 新配置
 * @returns {object} 标准化后的配置
 */
function setUsageConfig(deps = {}, config = {}) {
  return writeConfig(config, deps);
}

module.exports = {
  DEFAULT_AI_HOME_DIR,
  DEFAULTS,
  USAGE_CONFIG_KEY,
  normalizeConfig,
  readConfig,
  writeConfig,
  updateConfig,
  getUsageConfig,
  setUsageConfig
};
