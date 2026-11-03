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
  threshold_pct: 95,
  // 原生模式自动换号：额度见底 / 429 限流时自动切到下一个账号。
  // 默认关闭——用户明确要求「一种模式开启后」才生效。
  auto_switch: false,
  // 剩余百分比低于等于这个值就换号。null = 跟随 threshold_pct（剩余 ≤ 5%），
  // 与选号门禁 resolveMinimumRemainingPct 同一换算；显式给 0 = 只在真的用完时换。
  auto_switch_remaining_pct: null
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

// 开关只认明确的「开」：缺省 / 垃圾值一律关——自动换号是会动账号的动作，
// 误开比误关贵得多（用户必须自己打开这个模式）。
function normalizeAutoSwitch(value) {
  if (value === true || value === 1) return true;
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'on' || text === 'yes';
}

// null 是「跟随 threshold_pct」，必须与 0（真的用完才换）区分开。
function normalizeAutoSwitchRemainingPct(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, Math.round(num)));
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
  const autoSwitchCandidate = input.auto_switch ?? input.autoSwitch;
  const autoSwitchRemainingCandidate = input.auto_switch_remaining_pct ?? input.autoSwitchRemainingPct;
  return {
    active_refresh_interval: normalizeInterval(activeCandidate, ACTIVE_ALLOWED, DEFAULTS.active_refresh_interval),
    background_refresh_interval: normalizeInterval(backgroundCandidate, BACKGROUND_ALLOWED, DEFAULTS.background_refresh_interval),
    threshold_pct: normalizeThreshold(thresholdCandidate),
    auto_switch: normalizeAutoSwitch(autoSwitchCandidate),
    auto_switch_remaining_pct: normalizeAutoSwitchRemainingPct(autoSwitchRemainingCandidate)
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

function readUsageThresholdPct(deps = {}) {
  if (!deps.aiHomeDir) return DEFAULTS.threshold_pct;
  return normalizeThreshold(getUsageConfig(deps).threshold_pct);
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
  readUsageThresholdPct,
  setUsageConfig
};
