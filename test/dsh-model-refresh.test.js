'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const YAML = require('yaml');

const {
  MODEL_REFRESH_ENTRY,
  MODEL_REFRESH_FILE,
  ensureDshProfile
} = require('../lib/harness/dsh');
const { ensureDshTuiProfile } = require('../lib/harness/dsh-tui');

const PLUGIN_PATH = path.join(__dirname, '..', 'lib', 'harness', MODEL_REFRESH_FILE);

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function descriptor(providers, revision = 3) {
  return [{ ns: 'llm-pi-ai', revision, value: { providers } }];
}

function gatewayPayload(ids, modalities = {}) {
  return {
    object: 'list',
    data: ids.map((id) => ({
      id,
      object: 'model',
      aih_modalities: modalities[id] || { input: ['text'] }
    }))
  };
}

async function loadPlugin() {
  return import(pathToFileURL(PLUGIN_PATH).href);
}

test('dsh model refresh merges the gateway catalogue and keeps known metadata', async () => {
  const { buildRefreshedModels } = await loadPlugin();
  const current = [
    { id: 'gpt-test', name: 'GPT Test', contextWindow: 128000, maxTokens: 8192, input: ['text'] },
    { id: 'claude-old', name: 'Claude Old', input: ['text'] }
  ];
  const next = buildRefreshedModels(current, gatewayPayload(
    ['gpt-test', 'claude-new'],
    { 'claude-new': { input: ['text', 'image'] } }
  ).data);
  assert.deepEqual(next, [
    { id: 'gpt-test', name: 'GPT Test', contextWindow: 128000, maxTokens: 8192, input: ['text'] },
    { id: 'claude-new', name: 'claude-new', input: ['text', 'image'] }
  ]);
});

test('dsh model refresh rewrites the volatile models field through settings', async () => {
  const { createModelRefresher } = await loadPlugin();
  let providers = {
    aih: {
      apiKeyEnv: 'OPENAI_API_KEY',
      baseURL: 'http://127.0.0.1:9527/v1/',
      models: [{ id: 'gpt-test', name: 'GPT Test', contextWindow: 128000, input: ['text'] }]
    }
  };
  const mutations = [];
  const settings = {
    describe: () => descriptor(providers, 7),
    mutate: async (ns, ops, revision) => {
      mutations.push({ ns, ops, revision });
      const [op] = ops;
      assert.equal(op.op, 'set');
      assert.deepEqual(op.path, ['providers', 'aih', 'models']);
      providers = {
        ...providers,
        aih: { ...providers.aih, models: op.value }
      };
    }
  };
  const urls = [];
  const refresher = createModelRefresher({
    settings,
    env: { OPENAI_API_KEY: 'key-test' },
    fetchImpl: async (url) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => gatewayPayload(
          ['gpt-test', 'gemini-new'],
          { 'gemini-new': { input: ['text', 'image'] } }
        )
      };
    }
  });

  const first = await refresher.refresh();
  assert.equal(first.changed, true);
  assert.equal(first.count, 2);
  assert.deepEqual(urls, ['http://127.0.0.1:9527/v1/models']);
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].ns, 'llm-pi-ai');
  assert.equal(mutations[0].revision, 7);
  assert.deepEqual(
    mutations[0].ops[0].value.map((model) => model.id),
    ['gpt-test', 'gemini-new']
  );

  // 目录没变就不再写：避免定时刷新与设置页互相触发。
  const second = await refresher.refresh();
  assert.equal(second.changed, false);
  assert.equal(second.reason, 'unchanged');
  assert.equal(mutations.length, 1);
});

test('dsh model refresh leaves state untouched when the gateway is unavailable', async () => {
  const { createModelRefresher } = await loadPlugin();
  const mutations = [];
  const providers = {
    aih: {
      apiKeyEnv: 'OPENAI_API_KEY',
      baseURL: 'http://127.0.0.1:9527/v1',
      models: [{ id: 'gpt-test', input: ['text'] }]
    }
  };
  const settings = {
    describe: () => descriptor(providers),
    mutate: async () => { mutations.push(true); }
  };

  const failing = createModelRefresher({
    settings,
    env: { OPENAI_API_KEY: 'key-test' },
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) })
  });
  assert.equal((await failing.refresh()).reason, 'http_error');
  assert.equal(mutations.length, 0);

  const missingKey = createModelRefresher({
    settings,
    env: {},
    fetchImpl: async () => { throw new Error('must not be called'); }
  });
  assert.equal((await missingKey.refresh()).reason, 'api_key_missing');

  const missingProvider = createModelRefresher({
    settings: { describe: () => descriptor({}), mutate: async () => { mutations.push(true); } },
    env: { OPENAI_API_KEY: 'key-test' },
    fetchImpl: async () => { throw new Error('must not be called'); }
  });
  assert.equal((await missingProvider.refresh()).reason, 'provider_missing');
  assert.equal(mutations.length, 0);
});

function findRefreshEntry(entries) {
  const inserted = entries
    .filter((row) => row && Array.isArray(row.insert))
    .flatMap((row) => row.insert)
    .find((entry) => entry && entry.id === MODEL_REFRESH_ENTRY);
  if (inserted) return inserted;
  return entries.find((entry) => entry && entry.id === MODEL_REFRESH_ENTRY) || null;
}

test('dsh profiles ship the local refresh plugin and patch row', (t) => {
  const dshHome = tempDir(t, 'aih-dsh-refresh-');
  const profile = ensureDshProfile({
    fs,
    path,
    dshHome,
    baseUrl: 'http://127.0.0.1:9527/v1',
    accountRef: 'acct_dsh_refresh',
    models: [{ id: 'gpt-test', name: 'GPT Test', input: ['text'] }],
    model: 'gpt-test'
  });

  const pluginPath = path.join(profile.profileDir, MODEL_REFRESH_FILE);
  assert.equal(fs.existsSync(pluginPath), true);
  assert.match(fs.readFileSync(pluginPath, 'utf8'), /export const inject = \['settings'\]/);
  assert.equal(fs.statSync(pluginPath).mode & 0o777, 0o600);

  const entries = YAML.parse(fs.readFileSync(profile.patchPath, 'utf8'));
  const refresh = findRefreshEntry(entries);
  assert.ok(refresh);
  assert.equal(refresh.name, `./${MODEL_REFRESH_FILE}`);
  assert.equal(refresh.config.settingsNamespace, 'llm-pi-ai');
  assert.equal(refresh.config.provider, 'aih');
  assert.equal(refresh.config.intervalMs, 5 * 60 * 1000);

  // 二次启动保持幂等：不重复插入、不丢用户行。
  const again = ensureDshProfile({
    fs,
    path,
    dshHome,
    baseUrl: 'http://127.0.0.1:9527/v1',
    accountRef: 'acct_dsh_refresh',
    models: [{ id: 'gpt-test', name: 'GPT Test', input: ['text'] }],
    model: 'gpt-test'
  });
  const againEntries = YAML.parse(fs.readFileSync(again.patchPath, 'utf8'));
  assert.equal(
    againEntries
      .filter((row) => row && Array.isArray(row.insert))
      .flatMap((row) => row.insert)
      .filter((entry) => entry && entry.id === MODEL_REFRESH_ENTRY).length,
    1
  );
});

test('dsh-tui profiles ship the same refresh plugin', (t) => {
  const dshHome = tempDir(t, 'aih-dsh-tui-refresh-');
  const profile = ensureDshTuiProfile({
    fs,
    path,
    dshHome,
    baseUrl: 'http://127.0.0.1:9527/v1',
    accountRef: 'acct_dsh_tui_refresh',
    models: [{ id: 'gpt-test', name: 'GPT Test', input: ['text'] }],
    model: 'gpt-test'
  });

  assert.equal(fs.existsSync(path.join(profile.profileDir, MODEL_REFRESH_FILE)), true);
  const entries = YAML.parse(fs.readFileSync(profile.patchPath, 'utf8'));
  const refresh = findRefreshEntry(entries);
  assert.ok(refresh);
  assert.equal(refresh.name, `./${MODEL_REFRESH_FILE}`);
});
