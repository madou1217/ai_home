const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_AI_HOME_DIR,
  DEFAULTS,
  USAGE_CONFIG_KEY,
  normalizeConfig,
  readConfig,
  writeConfig,
  updateConfig,
  getUsageConfig,
  setUsageConfig
} = require('../lib/usage/config-store');
const {
  openAppStateDatabase,
  readJsonValue,
  writeJsonValue
} = require('../lib/server/app-state-store');

function createUsageConfigSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-usage-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    options: { fs, aiHomeDir: root }
  };
}

test('usage config store exports stable defaults and DB key', () => {
  assert.equal(DEFAULT_AI_HOME_DIR.endsWith('.ai_home'), true);
  assert.equal(USAGE_CONFIG_KEY, 'config:usage');
  assert.deepEqual(DEFAULTS, {
    active_refresh_interval: '1m',
    background_refresh_interval: '1h',
    threshold_pct: 95
  });
});

test('usage config normalizeConfig returns defaults for empty input', () => {
  assert.deepEqual(normalizeConfig(), DEFAULTS);
  assert.deepEqual(normalizeConfig({}), DEFAULTS);
});

test('usage config normalizeConfig accepts snake_case and camelCase keys', () => {
  assert.deepEqual(normalizeConfig({
    active_refresh_interval: '3m',
    background_refresh_interval: 'hourly',
    threshold_pct: 87.4
  }), {
    active_refresh_interval: '3m',
    background_refresh_interval: '1h',
    threshold_pct: 87
  });

  assert.deepEqual(normalizeConfig({
    activeRefreshInterval: ' 3M ',
    backgroundRefreshInterval: ' 1H ',
    thresholdPct: 87.6
  }), {
    active_refresh_interval: '3m',
    background_refresh_interval: '1h',
    threshold_pct: 88
  });
});

test('usage config normalizeConfig normalizes intervals defensively', () => {
  assert.deepEqual(normalizeConfig({
    active_refresh_interval: ' 3M ',
    background_refresh_interval: ' HOURLY '
  }), {
    active_refresh_interval: '3m',
    background_refresh_interval: '1h',
    threshold_pct: 95
  });

  assert.deepEqual(normalizeConfig({
    active_refresh_interval: '5m',
    background_refresh_interval: 'daily'
  }), DEFAULTS);
});

test('usage config normalizeConfig clamps and rounds threshold values', () => {
  assert.equal(normalizeConfig({ threshold_pct: 150 }).threshold_pct, 100);
  assert.equal(normalizeConfig({ threshold_pct: -5 }).threshold_pct, 1);
  assert.equal(normalizeConfig({ threshold_pct: 12.6 }).threshold_pct, 13);
  assert.equal(normalizeConfig({ threshold_pct: 'not-a-number' }).threshold_pct, 95);
  assert.equal(normalizeConfig({ threshold_pct: 0, thresholdPct: 50 }).threshold_pct, 1);
});

test('usage config readConfig returns an isolated defaults copy when DB key is missing', (t) => {
  const { options } = createUsageConfigSandbox(t);

  const firstRead = readConfig(options);
  firstRead.threshold_pct = 1;

  assert.deepEqual(readConfig(options), DEFAULTS);
});

test('usage config readConfig reads and normalizes its DB value', (t) => {
  const { root, options } = createUsageConfigSandbox(t);
  writeJsonValue(fs, root, USAGE_CONFIG_KEY, {
    activeRefreshInterval: '3M',
    background_refresh_interval: 'hourly',
    threshold_pct: '33.6'
  });

  assert.deepEqual(readConfig(options), {
    active_refresh_interval: '3m',
    background_refresh_interval: '1h',
    threshold_pct: 34
  });
});

test('usage config readConfig falls back to defaults for a damaged DB value', (t) => {
  const { root, options } = createUsageConfigSandbox(t);
  const db = openAppStateDatabase(fs, root);
  db.prepare('INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)')
    .run(USAGE_CONFIG_KEY, '{bad json', Date.now());
  db.close();

  assert.deepEqual(readConfig(options), DEFAULTS);
});

test('usage config writeConfig persists normalized data only in app-state.db', (t) => {
  const { root, options } = createUsageConfigSandbox(t);
  const expected = {
    active_refresh_interval: '3m',
    background_refresh_interval: '1h',
    threshold_pct: 1
  };

  const saved = writeConfig({
    activeRefreshInterval: '3M',
    backgroundRefreshInterval: 'hourly',
    thresholdPct: 0
  }, options);

  assert.deepEqual(saved, expected);
  assert.deepEqual(readJsonValue(fs, root, USAGE_CONFIG_KEY), expected);
  assert.equal(fs.existsSync(path.join(root, 'usage-config.json')), false);
});

test('usage config updateConfig merges partial updates over existing persisted config', (t) => {
  const { root, options } = createUsageConfigSandbox(t);
  const expected = {
    active_refresh_interval: '3m',
    background_refresh_interval: '1h',
    threshold_pct: 63
  };

  writeConfig({
    active_refresh_interval: '3m',
    background_refresh_interval: 'hourly',
    threshold_pct: 44
  }, options);

  assert.deepEqual(updateConfig({ threshold_pct: 63 }, options), expected);
  assert.deepEqual(readJsonValue(fs, root, USAGE_CONFIG_KEY), expected);
});

test('usage config getUsageConfig and setUsageConfig use injected aiHomeDir', (t) => {
  const { root } = createUsageConfigSandbox(t);
  const expected = {
    active_refresh_interval: '3m',
    background_refresh_interval: '1h',
    threshold_pct: 100
  };

  assert.deepEqual(setUsageConfig({ fs, aiHomeDir: root }, {
    activeRefreshInterval: '3m',
    backgroundRefreshInterval: 'hourly',
    thresholdPct: 150
  }), expected);

  assert.deepEqual(readJsonValue(fs, root, USAGE_CONFIG_KEY), expected);
  assert.deepEqual(getUsageConfig({ fs, aiHomeDir: root }), expected);
});
