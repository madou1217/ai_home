const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.ai_home', 'usage-config.json');

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
  const filePath = options.filePath || DEFAULT_CONFIG_PATH;
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULTS };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return normalizeConfig(parsed);
  } catch (_error) {
    return { ...DEFAULTS };
  }
}

function writeConfig(nextConfig = {}, options = {}) {
  const filePath = options.filePath || DEFAULT_CONFIG_PATH;
  const normalized = normalizeConfig(nextConfig);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function updateConfig(partial = {}, options = {}) {
  const current = readConfig(options);
  return writeConfig({ ...current, ...partial }, options);
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  DEFAULTS,
  normalizeConfig,
  readConfig,
  writeConfig,
  updateConfig
};
