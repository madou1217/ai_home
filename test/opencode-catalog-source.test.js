'use strict';

// `aih opencode` 改道目录的来源：opencode 2.x 把目录缓存在 opencode.db 的 kv 表，1.x 的
// `~/.cache/opencode/models.json` 不再更新。两处都读、谁新用谁（2026-10-18：照抄旧文件让
// glm-5.3-flash-free 在改道后的 opencode 里「Model unavailable」）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  KV_CATALOG_KEY,
  readOpenCodeCatalog
} = require('../lib/cli/services/ai-cli/launch-profile/opencode-catalog-source');
const {
  OVERLAY_FILE_NAME,
  prepareZenGatewayOverlay
} = require('../lib/cli/services/ai-cli/launch-profile/opencode-zen-gateway-overlay');

const GATEWAY_URL = 'http://127.0.0.1:9527/v1';

function catalogWith(...modelIds) {
  const models = Object.fromEntries(modelIds.map((id) => [id, { id, name: id }]));
  return { opencode: { id: 'opencode', api: 'https://opencode.ai/inference/v1', models } };
}

function createHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-catalog-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeLegacyCache(home, catalog, mtimeMs) {
  const filePath = path.join(home, '.cache', 'opencode', 'models.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(catalog));
  const when = new Date(mtimeMs);
  fs.utimesSync(filePath, when, when);
  return filePath;
}

// 与 opencode 2.x 的表结构一致：kv(key, value, time_created, time_updated)，值为 { updatedAt, digest, body }。
function writeKvCatalogs(home, rows, dataHome = path.join(home, '.local', 'share')) {
  const dbPath = path.join(dataHome, 'opencode', 'opencode.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS kv (key text PRIMARY KEY, value text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL)');
    const insert = db.prepare('INSERT OR REPLACE INTO kv (key, value, time_created, time_updated) VALUES (?, ?, ?, ?)');
    for (const row of rows) {
      const value = typeof row.raw === 'string'
        ? row.raw
        : JSON.stringify({ updatedAt: row.updatedAt, digest: 'd', body: JSON.stringify(row.catalog) });
      insert.run(row.key || KV_CATALOG_KEY, value, row.updatedAt, row.updatedAt);
    }
  } finally {
    db.close();
  }
  return dbPath;
}

function modelIds(result) {
  return Object.keys(result.catalog.opencode.models);
}

test('the opencode.db catalog wins when it was refreshed after the 1.x cache file', (t) => {
  const home = createHome(t);
  writeLegacyCache(home, catalogWith('old-free'), Date.parse('2026-10-15T14:45:00Z'));
  writeKvCatalogs(home, [{ catalog: catalogWith('old-free', 'new-free'), updatedAt: Date.parse('2026-10-18T07:33:00Z') }]);
  const result = readOpenCodeCatalog({ hostHomeDir: home, baseEnv: {} });
  assert.deepEqual(modelIds(result), ['old-free', 'new-free']);
  assert.match(result.source, /opencode\.db#kv:/);
});

test('a newer 1.x cache file still wins over an older opencode.db catalog', (t) => {
  const home = createHome(t);
  writeKvCatalogs(home, [{ catalog: catalogWith('from-db'), updatedAt: Date.parse('2026-10-01T00:00:00Z') }]);
  const filePath = writeLegacyCache(home, catalogWith('from-file'), Date.parse('2026-10-18T00:00:00Z'));
  const result = readOpenCodeCatalog({ hostHomeDir: home, baseEnv: {} });
  assert.deepEqual(modelIds(result), ['from-file']);
  assert.equal(result.source, filePath);
});

test('without opencode.db the 1.x cache file is used; with neither there is no catalog', (t) => {
  const home = createHome(t);
  assert.equal(readOpenCodeCatalog({ hostHomeDir: home, baseEnv: {} }), null);
  writeLegacyCache(home, catalogWith('only-file'), Date.now());
  assert.deepEqual(modelIds(readOpenCodeCatalog({ hostHomeDir: home, baseEnv: {} })), ['only-file']);
});

test('a custom OPENCODE_MODELS_URL row refreshed last is the one opencode is using', (t) => {
  const home = createHome(t);
  writeKvCatalogs(home, [
    { catalog: catalogWith('default-url'), updatedAt: Date.parse('2026-10-17T00:00:00Z') },
    { key: `${KV_CATALOG_KEY}:abc123`, catalog: catalogWith('custom-url'), updatedAt: Date.parse('2026-10-18T00:00:00Z') }
  ]);
  assert.deepEqual(modelIds(readOpenCodeCatalog({ hostHomeDir: home, baseEnv: {} })), ['custom-url']);
});

test('a corrupt kv value falls back to the cache file instead of failing the launch', (t) => {
  const home = createHome(t);
  writeKvCatalogs(home, [{ raw: '{not json', updatedAt: Date.now() }]);
  writeLegacyCache(home, catalogWith('fallback'), Date.parse('2026-10-15T00:00:00Z'));
  assert.deepEqual(modelIds(readOpenCodeCatalog({ hostHomeDir: home, baseEnv: {} })), ['fallback']);
});

test('XDG_DATA_HOME / XDG_CACHE_HOME are honoured like opencode does', (t) => {
  const home = createHome(t);
  const xdgData = path.join(home, 'xdg-data');
  writeKvCatalogs(home, [{ catalog: catalogWith('default-location'), updatedAt: Date.now() }]);
  writeKvCatalogs(home, [{ catalog: catalogWith('xdg-location'), updatedAt: Date.now() }], xdgData);
  const result = readOpenCodeCatalog({ hostHomeDir: home, baseEnv: { XDG_DATA_HOME: xdgData, XDG_CACHE_HOME: path.join(home, 'xdg-cache') } });
  assert.deepEqual(modelIds(result), ['xdg-location']);
});

test('a user-set OPENCODE_MODELS_PATH is the only source, except aih\'s own overlay inherited by a nested launch', (t) => {
  const home = createHome(t);
  writeKvCatalogs(home, [{ catalog: catalogWith('from-db'), updatedAt: Date.now() }]);
  const userFile = path.join(home, 'my-models.json');
  fs.writeFileSync(userFile, JSON.stringify(catalogWith('user-picked')));
  assert.deepEqual(
    modelIds(readOpenCodeCatalog({ hostHomeDir: home, baseEnv: { OPENCODE_MODELS_PATH: userFile } })),
    ['user-picked']
  );
  // 嵌套启动继承的是 aih 自己的改道文件：不能把它当用户目录，否则永远停在旧的那份。
  assert.deepEqual(
    modelIds(readOpenCodeCatalog({ hostHomeDir: home, baseEnv: { OPENCODE_MODELS_PATH: userFile }, excludePath: userFile })),
    ['from-db']
  );
});

test('the gateway overlay is derived from the fresh opencode.db catalog', (t) => {
  const home = createHome(t);
  const aiHomeDir = path.join(home, '.ai_home');
  writeLegacyCache(home, catalogWith('deepseek-v4.1-flash-free'), Date.parse('2026-10-15T14:45:00Z'));
  writeKvCatalogs(home, [{
    catalog: catalogWith('deepseek-v4.1-flash-free', 'glm-5.3-flash-free'),
    updatedAt: Date.parse('2026-10-18T07:33:00Z')
  }]);
  const overlay = prepareZenGatewayOverlay({
    hostHomeDir: home,
    aiHomeDir,
    baseEnv: {},
    gatewayBaseUrl: GATEWAY_URL,
    gatewayApiKey: 'gw-test-key'
  });
  assert.equal(overlay.modelsPath, path.join(aiHomeDir, 'run', OVERLAY_FILE_NAME));
  const written = JSON.parse(fs.readFileSync(overlay.modelsPath, 'utf8'));
  assert.equal(written.opencode.api, GATEWAY_URL);
  assert.deepEqual(Object.keys(written.opencode.models), ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free']);
});
