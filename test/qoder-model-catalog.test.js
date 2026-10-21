'use strict';

// Qoder 模型目录 / 模型发现的事实推导（目录驱动，不按模型名猜）。
//
// 这些用例锁住三件事：
//   1. 目录读取优先级（账号投影 → 宿主客户端）与 fail-closed 原因；
//   2. `is_reasoning` / `is_vl` / `max_input_tokens` / `model_config.key` 全部来自目录；
//   3. HTTP 模型发现走 `prepareRequest(..., 'auth')` + 明文 JSON（解密是兜底）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AUTO_MODEL_ENTRY,
  buildQoderModelConfig,
  createQoderHttpModelDiscovery,
  deriveQoderModelRequest,
  findQoderCatalogModel,
  normalizeCatalogEntry,
  readQoderModelCatalog,
  resolveQoderCatalogModel,
  __private: { buildCatalogIndex, catalogCache }
} = require('../lib/account/qoder-model-catalog');

const RUNTIME_DIR = '/rt/qoder/acct_1';
const HOST_HOME = '/host';

function createFakeFs(files) {
  return {
    readFileSync(file) {
      if (!Object.prototype.hasOwnProperty.call(files, file)) {
        const error = new Error(`ENOENT: ${file}`);
        error.code = 'ENOENT';
        throw error;
      }
      return files[file];
    },
    statSync(file) {
      if (!Object.prototype.hasOwnProperty.call(files, file)) {
        const error = new Error(`ENOENT: ${file}`);
        error.code = 'ENOENT';
        throw error;
      }
      const size = String(files[file] || '').length;
      return { isFile: () => true, mtimeMs: 1700000000000, size };
    },
    readdirSync(dir) {
      const prefix = `${dir}/`;
      const names = Object.keys(files)
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length).split('/')[0]);
      return Array.from(new Set(names));
    }
  };
}

function catalogPayload(entries) {
  return {
    assistant: entries,
    chat: [{ key: 'auto', display_name: 'Auto', is_vl: true, is_reasoning: false }]
  };
}

const GLOBAL_ENTRIES = [
  {
    key: 'auto',
    display_name: 'Auto',
    format: 'openai',
    source: 'system',
    is_vl: true,
    is_reasoning: false,
    is_default: true,
    max_input_tokens: 200000
  },
  {
    key: 'qfmodel',
    display_name: 'Qwen3.8-Flash',
    is_vl: true,
    is_reasoning: true,
    max_input_tokens: 180000,
    thinking_config: {
      enabled: { is_default: true, efforts: { medium: { is_default: true }, high: {} } },
      disabled: {}
    }
  },
  {
    key: 'kmodel_latest',
    display_name: 'Kimi-K3',
    is_vl: true,
    is_reasoning: false,
    max_input_tokens: 180000,
    thinking_config: { enabled: { efforts: { max: { is_default: true } } } }
  }
];

test.beforeEach(() => {
  catalogCache.clear();
});

test('readQoderModelCatalog reads the account projection catalog and normalizes entries', () => {
  const payload = catalogPayload(GLOBAL_ENTRIES);
  const fs = createFakeFs({
    [`${RUNTIME_DIR}/.models/default`]: JSON.stringify({
      key: 'auto',
      uid: 'uid-1',
      scene: 'assistant',
      updatedAt: 1
    }),
    [`${RUNTIME_DIR}/.models/uid-1/catalog-v7`]: 'cipher-text'
  });
  const runtime = {
    decryptModelCache(cipher, uid) {
      assert.equal(cipher, 'cipher-text');
      assert.equal(uid, 'uid-1');
      return JSON.stringify(payload);
    }
  };

  const catalog = readQoderModelCatalog({
    fs,
    path: require('node:path'),
    provider: 'qoder',
    version: '1.1.73',
    runtimeDir: RUNTIME_DIR,
    hostHomeDir: HOST_HOME,
    runtime
  });

  assert.equal(catalog.ok, true);
  assert.equal(catalog.source, 'catalog-v7');
  assert.equal(catalog.uid, 'uid-1');
  assert.equal(catalog.scene, 'assistant');
  assert.equal(catalog.models.length, 3);
  const flash = catalog.models.find((entry) => entry.key === 'qfmodel');
  assert.equal(flash.displayName, 'Qwen3.8-Flash');
  assert.equal(flash.isReasoning, true);
  assert.equal(flash.isVl, true);
  assert.equal(flash.maxInputTokens, 180000);
  // chat scene 不参与 assistant 目录。
  assert.equal(catalog.models.some((entry) => entry.key === 'auto' && entry === catalog.defaultModel), true);
});

test('readQoderModelCatalog falls back to the host client only when the projection has no catalog', () => {
  const payload = catalogPayload(GLOBAL_ENTRIES);
  const fs = createFakeFs({
    [`${HOST_HOME}/.qoder/.models/default`]: JSON.stringify({ uid: 'host-uid', scene: 'assistant' }),
    [`${HOST_HOME}/.qoder/.models/host-uid/catalog-v7`]: 'cipher'
  });
  const runtime = { decryptModelCache: () => JSON.stringify(payload) };
  const catalog = readQoderModelCatalog({
    fs,
    path: require('node:path'),
    provider: 'qoder',
    version: '1.1.73',
    runtimeDir: RUNTIME_DIR,
    hostHomeDir: HOST_HOME,
    runtime
  });
  assert.equal(catalog.ok, true);
  assert.equal(catalog.uid, 'host-uid');
});

test('readQoderModelCatalog fails closed with a reason (no guessing)', () => {
  const path = require('node:path');
  const missingWasm = readQoderModelCatalog({
    fs: createFakeFs({}),
    path,
    provider: 'qoder',
    version: '1.1.73',
    runtimeDir: RUNTIME_DIR,
    hostHomeDir: HOST_HOME
  });
  assert.equal(missingWasm.ok, false);
  assert.equal(missingWasm.reason, 'model_catalog_wasm_missing');

  const missingCatalog = readQoderModelCatalog({
    fs: createFakeFs({
      [`${RUNTIME_DIR}/.models/default`]: JSON.stringify({ uid: 'uid-1', scene: 'assistant' })
    }),
    path,
    provider: 'qoder',
    version: '1.1.73',
    runtimeDir: RUNTIME_DIR,
    hostHomeDir: HOST_HOME,
    runtime: { decryptModelCache: () => '{}' }
  });
  assert.equal(missingCatalog.ok, false);
  assert.equal(missingCatalog.reason, 'model_catalog_missing');

  const decryptFailed = readQoderModelCatalog({
    fs: createFakeFs({
      [`${RUNTIME_DIR}/.models/default`]: JSON.stringify({ uid: 'uid-1', scene: 'assistant' }),
      [`${RUNTIME_DIR}/.models/uid-1/catalog-v7`]: 'broken'
    }),
    path,
    provider: 'qoder',
    version: '1.1.73',
    runtimeDir: RUNTIME_DIR,
    hostHomeDir: HOST_HOME,
    runtime: {
      decryptModelCache() {
        throw new Error('wasm trap');
      }
    }
  });
  assert.equal(decryptFailed.ok, false);
  assert.equal(decryptFailed.reason, 'model_catalog_decrypt_failed');
});

test('resolveQoderCatalogModel maps auto/display name/key and rejects unknown models', () => {
  const models = GLOBAL_ENTRIES.map(normalizeCatalogEntry);
  const { byKey, byDisplayName } = buildCatalogIndex(models);
  const catalog = { ok: true, source: 'catalog-v7', models, byKey, byDisplayName };

  assert.equal(resolveQoderCatalogModel(catalog, '', 'qoder').entry, AUTO_MODEL_ENTRY);
  assert.equal(resolveQoderCatalogModel(catalog, 'auto', 'qoder').entry.key, 'auto');
  assert.equal(resolveQoderCatalogModel(catalog, 'qoder', 'qoder').entry.key, 'auto');
  // 展示名与 key 都命中同一条目。
  assert.equal(resolveQoderCatalogModel(catalog, 'Qwen3.8-Flash', 'qoder').entry.key, 'qfmodel');
  assert.equal(resolveQoderCatalogModel(catalog, 'qfmodel', 'qoder').entry.key, 'qfmodel');
  assert.equal(resolveQoderCatalogModel(catalog, 'qoder/Qwen3.8-Flash', 'qoder').entry.key, 'qfmodel');
  assert.equal(findQoderCatalogModel(catalog, 'kimi-k3').key, 'kmodel_latest');

  const unknown = resolveQoderCatalogModel(catalog, 'Qwen3.8-Thinking', 'qoder');
  assert.equal(unknown.entry, null);
  assert.equal(unknown.reason, 'model_not_in_catalog');
});

test('deriveQoderModelRequest only degrades true -> false and never guesses from names', () => {
  const flash = normalizeCatalogEntry(GLOBAL_ENTRIES[1]);
  const kimi = normalizeCatalogEntry(GLOBAL_ENTRIES[2]);

  const base = deriveQoderModelRequest(flash, {});
  assert.equal(base.isReasoning, true);
  assert.equal(base.reasoningEffort, '');
  assert.equal(base.defaultEffort, 'medium');

  assert.equal(deriveQoderModelRequest(flash, { reasoning_effort: 'none' }).isReasoning, false);
  assert.equal(deriveQoderModelRequest(flash, { enable_thinking: false }).isReasoning, false);
  assert.equal(deriveQoderModelRequest(flash, { thinking_budget: 0 }).isReasoning, false);
  assert.equal(deriveQoderModelRequest(flash, { reasoning: { enabled: false } }).isReasoning, false);
  assert.equal(deriveQoderModelRequest(flash, { reasoning_effort: 'high' }).isReasoning, true);

  // 目录说不是 reasoning 的模型，即使请求里写了 effort 也不会变 true。
  const kimiBase = deriveQoderModelRequest(kimi, { reasoning_effort: 'high' });
  assert.equal(kimiBase.isReasoning, false);
  assert.equal(kimiBase.reasoningEffort, 'high');

  const config = buildQoderModelConfig(flash, base);
  assert.deepEqual(config, {
    key: 'qfmodel',
    display_name: 'Qwen3.8-Flash',
    model: '',
    format: 'openai',
    is_vl: true,
    is_reasoning: true,
    api_key: '',
    url: '',
    source: 'system',
    max_input_tokens: 180000
  });
});

test('createQoderHttpModelDiscovery signs a GET and parses the plain JSON catalog', async () => {
  const payload = catalogPayload(GLOBAL_ENTRIES);
  const fs = createFakeFs({
    [`${RUNTIME_DIR}/.auth/user`]: 'encrypted-user',
    [`${RUNTIME_DIR}/.auth/machine_id`]: 'machine-1',
    [`${RUNTIME_DIR}/.models/default`]: JSON.stringify({ uid: 'uid-1', scene: 'assistant' })
  });
  const preparedCalls = [];
  const fetched = [];
  const runtime = {
    decrypt: (blob) => {
      assert.equal(blob, 'encrypted-user');
      return JSON.stringify({ uid: 'uid-1', security_oauth_token: 'token' });
    },
    newContext: () => 42,
    prepareRequest: (context, input) => {
      preparedCalls.push({ context, ...input });
      return {
        url: `${input.endpoint}${input.path}`,
        headers: new Map([['Authorization', 'Bearer signed']]),
        body: ''
      };
    },
    decryptServerResponse: () => {
      throw new Error('should not decrypt a plain response');
    },
    freeContext: () => {}
  };
  const discovery = createQoderHttpModelDiscovery({
    fs,
    path: require('node:path'),
    aiHomeDir: '/aih',
    hostHomeDir: HOST_HOME,
    resolveAccountRuntimeDir: () => RUNTIME_DIR,
    materializeProviderAuth: () => ({}),
    resolveProviderCliPath: () => '/bin/qodercli-1.1.73',
    wasmBundle: { runtime, decryptor: { decrypt: runtime.decrypt } },
    fetchWithTimeout: async (url, init) => {
      fetched.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload)
      };
    }
  });

  const result = await discovery.discover({ provider: 'qoder', accountRef: 'acct_1' }, 5000);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.models, ['Auto', 'Qwen3.8-Flash', 'Kimi-K3']);
  assert.equal(result.defaultModel, 'Auto');
  assert.equal(preparedCalls.length, 1);
  assert.equal(preparedCalls[0].method, 'GET');
  assert.equal(preparedCalls[0].mode, 'auth');
  assert.equal(preparedCalls[0].path, '/api/v2/model/list?Encode=1');
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].init.headers.Authorization, 'Bearer signed');
});

test('createQoderHttpModelDiscovery reports decode failures instead of returning a partial catalog', async () => {
  const fs = createFakeFs({
    [`${RUNTIME_DIR}/.auth/user`]: 'encrypted-user',
    [`${RUNTIME_DIR}/.auth/machine_id`]: 'machine-1'
  });
  const runtime = {
    decrypt: () => JSON.stringify({ uid: 'uid-1' }),
    newContext: () => 1,
    prepareRequest: () => ({ url: 'https://api3.qoder.sh/api/v2/model/list?Encode=1', headers: {}, body: '' }),
    decryptServerResponse: () => {
      throw new Error('corrupt');
    },
    freeContext: () => {}
  };
  const discovery = createQoderHttpModelDiscovery({
    fs,
    path: require('node:path'),
    aiHomeDir: '/aih',
    hostHomeDir: HOST_HOME,
    resolveAccountRuntimeDir: () => RUNTIME_DIR,
    materializeProviderAuth: () => ({}),
    resolveProviderCliPath: () => '/bin/qodercli-1.1.73',
    wasmBundle: { runtime, decryptor: { decrypt: runtime.decrypt } },
    fetchWithTimeout: async () => ({ ok: true, status: 200, text: async () => 'not-json' })
  });

  const result = await discovery.discover({ provider: 'qoder', accountRef: 'acct_1' }, 5000);
  assert.equal(result.error, 'qoder_model_discovery_decode_failed');
  assert.equal(result.models, undefined);
});
