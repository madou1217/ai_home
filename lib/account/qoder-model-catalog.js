'use strict';

// Qoder / Qoder CN 的**模型目录**（服务端下发、客户端缓存）读取与派生。
//
// 为什么需要这个模块（2026-10-21 取证结论，见 docs/providers/qoder-client-protocol.md）：
//   * `is_reasoning` / `is_vl` / `max_input_tokens` / `model_config.key` 的唯一事实源是
//     服务端模型目录，不是模型名。官方客户端（qodercli 1.1.73）的 `Dvt()` 按
//     key → 小写 key → display_name 查目录，随后
//     `is_reasoning = 条目.is_reasoning ?? false`、`is_vl = 条目.is_vl ?? false`、
//     `max_input_tokens = 条目.max_input_tokens ?? 200000`、`format = 条目.format ?? "openai"`。
//   * 同一个展示名在两个站点/账号上取值可以不同（Auto：global=false / CN=true；
//     DeepSeek-Flash：global=true / CN=false），所以静态表或名字正则都不可能正确。
//   * 客户端只会在请求级把 `true` 改 `false`（`reasoning_effort="none"`、
//     `enable_thinking=false`、`thinkingBudget=0`），从不用名字反向置 true。
//
// 磁盘布局（布局表 `QODER_MODEL_CATALOG` 是唯一事实源）：
//   <clientHome>/.models/default            → {key, uid, scene, updatedAt}
//   <clientHome>/.models/<uid>/catalog-v7   → wasm `model_cache_encrypt/decrypt(text, uid)` 密文
//
// fail-closed：目录缺失 / 解密失败一律返回 `{ok:false, reason}`，由调用方决定
// 回落 CLI，**绝不**用模型名猜一个默认值继续发 HTTP。

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const {
  QODER_MODEL_CATALOG,
  QODER_MODEL_LIST,
  resolveQoderClientLayout
} = require('../runtime/qoder-client-layouts');
const { createQoderAuthRuntime } = require('./qoder-auth-wasm');
const {
  instantiateQoderAuthWasm,
  readQoderAuthWasm
} = require('./qoder-credential-decrypt').__private;
const { qoderClientDir, resolveQoderHttpEndpoint } = require('./qoder-endpoint');

// 与客户端一致：目录没有 max_input_tokens 时的兜底窗口。
const DEFAULT_MODEL_MAX_INPUT_TOKENS = 200000;
// 目录文件按 mtime+size 缓存；文件一被客户端重写（后台每 2 分钟同步）就重新解密。
const MAX_CATALOG_CACHE = 16;
const catalogCache = new Map();
const wasmRuntimeCache = new Map();
const MAX_WASM_RUNTIME_CACHE = 4;

const AUTO_MODEL_ENTRY = Object.freeze({
  key: 'auto',
  displayName: 'Auto',
  format: 'openai',
  source: 'system',
  isVl: true,
  isReasoning: false,
  maxInputTokens: DEFAULT_MODEL_MAX_INPUT_TOKENS,
  isDefault: true,
  thinkingConfig: null
});

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function readPositiveInteger(value) {
  const numeric = readFiniteNumber(value);
  return numeric !== null && numeric > 0 ? Math.floor(numeric) : 0;
}

function hasOwn(target, key) {
  return Boolean(target) && Object.prototype.hasOwnProperty.call(target, key);
}

function readJsonFile(fs, filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function readTextFile(fs, filePath) {
  try {
    return String(fs.readFileSync(filePath, 'utf8') || '');
  } catch (_error) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 目录条目规范化
// ---------------------------------------------------------------------------

function normalizeCatalogEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const key = normalizeString(raw.key);
  if (!key) return null;
  return {
    key,
    displayName: normalizeString(raw.display_name) || key,
    format: normalizeString(raw.format) || 'openai',
    source: normalizeString(raw.source) || 'system',
    // 客户端默认值：`?? !1`（缺省 false），不是 true。
    isVl: raw.is_vl === true,
    isReasoning: raw.is_reasoning === true,
    maxInputTokens: readPositiveInteger(raw.max_input_tokens) || DEFAULT_MODEL_MAX_INPUT_TOKENS,
    isDefault: raw.is_default === true,
    thinkingConfig: raw.thinking_config && typeof raw.thinking_config === 'object'
      ? raw.thinking_config
      : null
  };
}

function buildCatalogIndex(entries) {
  const byKey = new Map();
  const byDisplayName = new Map();
  for (const entry of entries) {
    if (!byKey.has(entry.key.toLowerCase())) byKey.set(entry.key.toLowerCase(), entry);
    const display = entry.displayName.toLowerCase();
    if (display && !byDisplayName.has(display)) byDisplayName.set(display, entry);
  }
  return { byKey, byDisplayName };
}

/**
 * 按官方客户端的解析顺序查目录：精确 key → 小写 key → display_name（大小写不敏感）。
 * @returns {object|null}
 */
function findQoderCatalogModel(catalog, modelName) {
  if (!catalog || catalog.ok !== true) return null;
  const raw = normalizeString(modelName);
  if (!raw) return null;
  const exact = catalog.models.find((entry) => entry.key === raw);
  if (exact) return exact;
  const lower = raw.toLowerCase();
  return catalog.byKey.get(lower) || catalog.byDisplayName.get(lower) || null;
}

/**
 * 解析请求模型名到目录条目。
 *
 * `auto` / `default` / provider 名 / 空前缀一律解析成 Auto（与旧行为一致，也是
 * 唯一不依赖目录就能安全直连的模型）。其余名字必须命中目录，否则返回
 * `{entry:null, reason:'model_not_in_catalog'}`，由调用方 fail-closed。
 *
 * @returns {{entry:object|null, source:'auto'|'catalog'|'missing', reason:string}}
 */
function resolveQoderCatalogModel(catalog, modelName, provider) {
  const raw = normalizeString(modelName);
  const providerId = normalizeString(provider).toLowerCase();
  let key = raw;
  if (key.includes('/')) key = key.slice(key.indexOf('/') + 1).trim();
  const lower = key.toLowerCase();
  if (!key || lower === 'auto' || lower === 'default' || lower === providerId) {
    return { entry: AUTO_MODEL_ENTRY, source: 'auto', reason: '' };
  }
  const entry = findQoderCatalogModel(catalog, key);
  if (!entry) return { entry: null, source: 'missing', reason: 'model_not_in_catalog' };
  return { entry, source: 'catalog', reason: '' };
}

// ---------------------------------------------------------------------------
// 请求级字段派生（只允许 true → false）
// ---------------------------------------------------------------------------

function readExplicitEffort(requestJson) {
  const value = normalizeString(
    requestJson && (
      requestJson.reasoning_effort
      ?? (requestJson.reasoning && requestJson.reasoning.effort)
      ?? (requestJson.thinking && requestJson.thinking.effort)
    )
  );
  return value.toLowerCase();
}

function readExplicitThinkingFlag(requestJson) {
  if (!requestJson || typeof requestJson !== 'object') return undefined;
  if (hasOwn(requestJson, 'enable_thinking')) return requestJson.enable_thinking === true;
  if (hasOwn(requestJson, 'thinking') && typeof requestJson.thinking === 'boolean') {
    return requestJson.thinking === true;
  }
  if (requestJson.thinking && typeof requestJson.thinking === 'object'
    && hasOwn(requestJson.thinking, 'enabled')) {
    return requestJson.thinking.enabled === true;
  }
  if (requestJson.reasoning && typeof requestJson.reasoning === 'object'
    && hasOwn(requestJson.reasoning, 'enabled')) {
    return requestJson.reasoning.enabled === true;
  }
  return undefined;
}

function readExplicitThinkingBudget(requestJson) {
  if (!requestJson || typeof requestJson !== 'object') return null;
  const value = requestJson.thinking_budget
    ?? requestJson.thinkingBudget
    ?? (requestJson.thinking && requestJson.thinking.budget_tokens);
  const numeric = readFiniteNumber(value);
  return numeric === null ? null : numeric;
}

/**
 * 客户端 `Dvt()` 的请求级覆盖（取证结论：只把 true 改 false）。
 *
 * @returns {{isReasoning:boolean, reasoningEffort:string, enableThinking:boolean|undefined,
 *   disabled:boolean, supportsThinking:boolean, defaultEffort:string}}
 */
function deriveQoderModelRequest(entry, requestJson) {
  const model = entry || AUTO_MODEL_ENTRY;
  const effort = readExplicitEffort(requestJson);
  const thinkingFlag = readExplicitThinkingFlag(requestJson);
  const budget = readExplicitThinkingBudget(requestJson);
  const disabled = effort === 'none'
    || thinkingFlag === false
    || (budget !== null && budget <= 0);
  const thinkingConfig = model.thinkingConfig || null;
  const enabled = thinkingConfig && thinkingConfig.enabled && typeof thinkingConfig.enabled === 'object'
    ? thinkingConfig.enabled
    : null;
  const efforts = enabled && enabled.efforts && typeof enabled.efforts === 'object'
    ? enabled.efforts
    : null;
  let defaultEffort = '';
  if (efforts) {
    for (const [name, value] of Object.entries(efforts)) {
      if (value && typeof value === 'object' && value.is_default === true) {
        defaultEffort = name;
        break;
      }
    }
  }
  return {
    isReasoning: model.isReasoning === true && !disabled,
    reasoningEffort: effort,
    enableThinking: thinkingFlag,
    disabled,
    supportsThinking: Boolean(thinkingConfig),
    defaultEffort
  };
}

/**
 * 生成 body.model_config（字段与官方客户端 `Dvt()` 的输出同形）。
 * 注意 `api_key` 恒为空串：账号凭据由 WASM 签名放进 Authorization，不写进 body。
 */
function buildQoderModelConfig(entry, derived) {
  const model = entry || AUTO_MODEL_ENTRY;
  return {
    key: model.key,
    display_name: model.displayName,
    model: '',
    format: model.format || 'openai',
    is_vl: model.isVl === true,
    is_reasoning: derived ? derived.isReasoning === true : model.isReasoning === true,
    api_key: '',
    url: '',
    source: model.source || 'system',
    max_input_tokens: model.maxInputTokens || DEFAULT_MODEL_MAX_INPUT_TOKENS
  };
}

// ---------------------------------------------------------------------------
// 磁盘目录读取
// ---------------------------------------------------------------------------

function resolveClientHome({ hostHomeDir, provider, version, path }) {
  const clientDir = qoderClientDir(provider, version);
  if (!hostHomeDir || !clientDir) return '';
  return path.join(hostHomeDir, clientDir);
}

function listCatalogFiles(fs, path, modelsDir) {
  let names = [];
  try {
    names = fs.readdirSync(modelsDir);
  } catch (_error) {
    return [];
  }
  const prefix = QODER_MODEL_CATALOG.filePrefix;
  return names
    .map((name) => {
      const match = String(name).match(new RegExp(`^${prefix}(\\d+)$`));
      return match ? { name, version: Number(match[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.version - a.version)
    .map((item) => path.join(modelsDir, item.name));
}

function getCatalogWasmRuntime({ fs, cliPath }) {
  if (!cliPath) return null;
  const bundle = getCatalogWasmBundle({ fs, cliPath });
  return bundle ? bundle.runtime : null;
}

/**
 * 同一份 wasm 字节要两种宿主：
 *   * 完整运行时（prepareRequest / newContext / model_cache_decrypt）；
 *   * 简化 glue（credential_storage_decrypt）——**解密登录态必须用它**：
 *     完整运行时的 decrypt 会污染 Rust 侧状态，随后 newContext 直接 wasm trap
 *     （2026-10-21 实测）。transport 的签名器也是这么分工的。
 */
function getCatalogWasmBundle({ fs, cliPath }) {
  if (!cliPath) return null;
  let stat = null;
  try {
    stat = fs.statSync(cliPath);
  } catch (_error) {
    return null;
  }
  const cacheKey = `${cliPath}:${stat.mtimeMs}:${stat.size}`;
  if (wasmRuntimeCache.has(cacheKey)) return wasmRuntimeCache.get(cacheKey);
  try {
    const bytes = readQoderAuthWasm(fs, cliPath);
    if (!bytes) return null;
    const bundle = {
      runtime: createQoderAuthRuntime(bytes),
      decryptor: instantiateQoderAuthWasm(bytes)
    };
    if (wasmRuntimeCache.size >= MAX_WASM_RUNTIME_CACHE) {
      for (const [key, value] of wasmRuntimeCache) {
        wasmRuntimeCache.delete(key);
        try { value.runtime && value.runtime.dispose && value.runtime.dispose(); } catch (_error) { /* best effort */ }
        break;
      }
    }
    wasmRuntimeCache.set(cacheKey, bundle);
    return bundle;
  } catch (_error) {
    return null;
  }
}

function readCatalogSnapshot({ fs, path, modelsRoot, uid, scene, runtime }) {
  const modelsDir = path.join(modelsRoot, uid);
  const files = listCatalogFiles(fs, path, modelsDir);
  if (files.length === 0) return { ok: false, reason: 'model_catalog_missing' };
  const filePath = files[0];
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch (_error) {
    return { ok: false, reason: 'model_catalog_missing' };
  }
  const cacheKey = `${filePath}:${stat.mtimeMs}:${stat.size}:${scene}`;
  if (catalogCache.has(cacheKey)) return catalogCache.get(cacheKey);

  const cipher = readTextFile(fs, filePath).trim();
  if (!cipher) return { ok: false, reason: 'model_catalog_invalid' };
  let plaintext = '';
  try {
    plaintext = runtime.decryptModelCache(cipher, uid);
  } catch (_error) {
    return { ok: false, reason: 'model_catalog_decrypt_failed' };
  }
  let data = null;
  try {
    data = JSON.parse(plaintext);
  } catch (_error) {
    return { ok: false, reason: 'model_catalog_invalid' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'model_catalog_invalid' };
  }
  // 目录是「scene → 条目数组」；scene 默认 assistant，缺失时按 assistant 兜底。
  const rawEntries = Array.isArray(data[scene])
    ? data[scene]
    : (Array.isArray(data[QODER_MODEL_CATALOG.defaultScene]) ? data[QODER_MODEL_CATALOG.defaultScene] : []);
  const models = rawEntries.map(normalizeCatalogEntry).filter(Boolean);
  if (models.length === 0) return { ok: false, reason: 'model_catalog_empty' };
  const { byKey, byDisplayName } = buildCatalogIndex(models);
  const snapshot = {
    ok: true,
    source: `${QODER_MODEL_CATALOG.filePrefix}${QODER_MODEL_CATALOG.version}`,
    path: filePath,
    clientHome: modelsRoot,
    uid,
    scene,
    updatedAt: stat.mtimeMs,
    models,
    byKey,
    byDisplayName,
    defaultModel: models.find((entry) => entry.isDefault) || models[0]
  };
  if (catalogCache.size >= MAX_CATALOG_CACHE) catalogCache.clear();
  catalogCache.set(cacheKey, snapshot);
  return snapshot;
}

/**
 * 读取账号可用的模型目录。
 *
 * 查找顺序：账号投影 `<runtimeDir>/.models` → 宿主客户端 `<homeDir>/.models`。
 * 两者都是客户端写下的同一份格式；投影存在时优先（账号隔离）。
 *
 * @returns {{ok:true, ...}|{ok:false, reason:string}}
 */
function readQoderModelCatalog(input = {}) {
  const fs = input.fs || nodeFs;
  const path = input.path || nodePath;
  const provider = normalizeString(input.provider).toLowerCase();
  const version = normalizeString(input.version);
  if (!provider) return { ok: false, reason: 'model_catalog_unsupported_provider' };
  const runtime = input.runtime || getCatalogWasmRuntime({ fs, cliPath: input.cliPath });
  if (!runtime) return { ok: false, reason: 'model_catalog_wasm_missing' };

  const candidates = [];
  if (input.runtimeDir) candidates.push(path.join(input.runtimeDir, QODER_MODEL_CATALOG.dir));
  const clientHome = resolveClientHome({
    hostHomeDir: input.hostHomeDir,
    provider,
    version,
    path
  });
  if (clientHome) candidates.push(path.join(clientHome, QODER_MODEL_CATALOG.dir));

  let lastReason = 'model_catalog_missing';
  for (const modelsRoot of candidates) {
    const defaultPath = path.join(modelsRoot, QODER_MODEL_CATALOG.defaultFile);
    const def = readJsonFile(fs, defaultPath);
    let uid = normalizeString(def && def.uid);
    let scene = normalizeString(def && def.scene) || QODER_MODEL_CATALOG.defaultScene;
    if (!uid) {
      // default 文件缺失时，目录名就是 uid（客户端就是这么放的）。
      try {
        const dirs = fs.readdirSync(modelsRoot).filter((name) => name !== QODER_MODEL_CATALOG.defaultFile);
        if (dirs.length === 1) uid = dirs[0];
      } catch (_error) { /* 目录不存在 */ }
    }
    if (!uid) {
      lastReason = 'model_catalog_default_missing';
      continue;
    }
    const snapshot = readCatalogSnapshot({ fs, path, modelsRoot, uid, scene, runtime });
    if (snapshot.ok) return snapshot;
    lastReason = snapshot.reason || lastReason;
    // 账号投影里没有目录时继续看宿主；投影里有但解密失败则直接 fail-closed，
    // 避免把宿主目录当成这个账号的目录（账号隔离优先）。
    break;
  }
  return { ok: false, reason: lastReason };
}

// ---------------------------------------------------------------------------
// 模型发现（HTTP，不依赖本机客户端运行）
// ---------------------------------------------------------------------------

function readAuthContext({ fs, path, runtimeDir, runtime, decryptor, version }) {
  const blob = normalizeString(readTextFile(fs, path.join(runtimeDir, '.auth', 'user')));
  const machineId = normalizeString(readTextFile(fs, path.join(runtimeDir, '.auth', 'machine_id')));
  if (!blob || !machineId) return null;
  let plaintext = '';
  try {
    // 解密必须走简化 glue：完整运行时的 decrypt 会污染 Rust 状态，随后
    // newContext 直接 wasm trap（2026-10-21 实测）。
    plaintext = decryptor.decrypt(blob, machineId.slice(0, 16));
  } catch (_error) {
    return null;
  }
  return runtime.newContext(machineId, version, plaintext);
}

function normalizeDiscoveredModels(payload, scene) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const entries = Array.isArray(payload[scene])
    ? payload[scene]
    : (Array.isArray(payload[QODER_MODEL_CATALOG.defaultScene]) ? payload[QODER_MODEL_CATALOG.defaultScene] : []);
  return entries.map(normalizeCatalogEntry).filter(Boolean);
}

/**
 * 模型发现策略（描述符 `models.strategies` 的 HTTP 实现）。
 *
 * 纯 API：用账号投影里的登录态创建 WASM 上下文，`prepareRequest(..., 'auth')`
 * 签出 GET 请求，响应体再用 `decrypt_server_response` 解（不是明文 JSON）。
 * 不 spawn 任何 CLI；本地 CLI 仍作为描述符里的兜底策略。
 */
function createQoderHttpModelDiscovery(options = {}) {
  const fs = options.fs || nodeFs;
  const path = options.path || nodePath;
  const requireLazy = (id) => {
    // 延迟 require：这些模块里有 CLI/provider 注册链，放顶层会扩大循环依赖面。
    // eslint-disable-next-line global-require
    return require(id);
  };
  const resolveAccountRuntimeDir = options.resolveAccountRuntimeDir
    || ((...args) => requireLazy('../runtime/aih-storage-layout').resolveAccountRuntimeDir(...args));
  const materializeProviderAuth = options.materializeProviderAuth
    || ((...args) => requireLazy('./native-auth-projection').materializeProviderAuth(...args));
  const resolveProviderCliPath = options.resolveProviderCliPath
    || ((...args) => requireLazy('../cli/services/ai-cli/ensure-native-cli').resolveProviderCliPath(...args));
  const resolveClientVersion = options.resolveQoderClientVersion;

  async function discover(account = {}, timeoutMs = 15000) {
    const provider = normalizeString(account.provider).toLowerCase();
    const accountRef = normalizeString(account.accountRef);
    if (!accountRef) return { error: 'qoder_model_discovery_missing_account_ref' };
    const aiHomeDir = normalizeString(options.aiHomeDir);
    if (!aiHomeDir) return { error: 'qoder_model_discovery_missing_ai_home' };
    const hostHomeDir = normalizeString(options.hostHomeDir) || path.dirname(aiHomeDir);
    const runtimeDir = resolveAccountRuntimeDir(aiHomeDir, provider, accountRef);
    try {
      const materialized = materializeProviderAuth(fs, runtimeDir, provider, {
        path,
        aiHomeDir,
        accountRef
      });
      if (materialized && materialized.missing) {
        return { error: 'qoder_model_discovery_missing_auth' };
      }
    } catch (_error) {
      return { error: 'qoder_model_discovery_missing_auth' };
    }
    const cliPath = normalizeString(resolveProviderCliPath(provider));
    if (!cliPath) return { error: 'qoder_model_discovery_cli_not_found' };
    const version = normalizeString(
      resolveClientVersion ? resolveClientVersion(cliPath, provider) : ''
    ) || (resolveQoderClientLayout({ provider }) || {}).cliVersion || '';
    const bundle = options.wasmBundle || getCatalogWasmBundle({ fs, cliPath });
    if (!bundle) return { error: 'qoder_model_discovery_wasm_missing' };
    const { runtime, decryptor } = bundle;

    let context = 0;
    try {
      context = readAuthContext({ fs, path, runtimeDir, runtime, decryptor, version });
      if (!context) return { error: 'qoder_model_discovery_auth_decrypt_failed' };
      const endpointInfo = resolveQoderHttpEndpoint({
        fs,
        path,
        provider,
        version,
        runtimeDir,
        hostHomeDir
      });
      const queryPath = `${QODER_MODEL_LIST.path}?${QODER_MODEL_LIST.query}`;
      const prepared = runtime.prepareRequest(context, {
        endpoint: endpointInfo.endpoint,
        path: queryPath,
        method: QODER_MODEL_LIST.method,
        mode: 'auth'
      });
      const headers = {};
      if (prepared.headers instanceof Map) {
        for (const [name, value] of prepared.headers.entries()) headers[name] = value;
      } else if (prepared.headers && typeof prepared.headers === 'object') {
        Object.assign(headers, prepared.headers);
      }
      headers.Accept = headers.Accept || 'application/json';
      const request = options.fetchWithTimeout || (async (url, init, budget) => fetch(url, {
        ...init,
        signal: AbortSignal.timeout(Math.max(1000, Number(budget) || 15000))
      }));
      const response = await request(prepared.url, { method: QODER_MODEL_LIST.method, headers }, timeoutMs);
      if (!response || !response.ok) {
        return { error: `qoder_model_discovery_http_${response ? response.status : 'unknown'}` };
      }
      const text = await response.text();
      // 取证（2026-10-21 真机）：`GET /api/v2/model/list` 返回的是**明文 JSON**
      // （content-type application/json，约 66KB 全量目录）；客户端 bundle 里的
      // `decrypt_server_response` 只在响应确实被编码时才用。因此先按明文解析，
      // 解析失败再尝试解密——两条路径都失败才判解码失败，不猜。
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch (_error) {
        try {
          payload = JSON.parse(runtime.decryptServerResponse(text));
        } catch (_decodeError) {
          return { error: 'qoder_model_discovery_decode_failed' };
        }
      }
      // scene 以客户端默认文件为准；没有就按 assistant。
      const defaultFile = readJsonFile(fs, path.join(runtimeDir, QODER_MODEL_CATALOG.dir, QODER_MODEL_CATALOG.defaultFile));
      const scene = normalizeString(defaultFile && defaultFile.scene) || QODER_MODEL_CATALOG.defaultScene;
      const models = normalizeDiscoveredModels(payload, scene);
      if (models.length === 0) return { error: 'qoder_model_discovery_empty_catalog' };
      const defaultEntry = models.find((entry) => entry.isDefault) || models[0];
      return {
        models: models.map((entry) => entry.displayName),
        defaultModel: defaultEntry.displayName,
        modelKeys: models.map((entry) => entry.key)
      };
    } catch (error) {
      return { error: error && error.code ? String(error.code) : 'qoder_model_discovery_failed' };
    } finally {
      if (context) {
        try { runtime.freeContext(context); } catch (_error) { /* best effort */ }
      }
    }
  }

  return { discover };
}

module.exports = {
  AUTO_MODEL_ENTRY,
  DEFAULT_MODEL_MAX_INPUT_TOKENS,
  buildQoderModelConfig,
  createQoderHttpModelDiscovery,
  deriveQoderModelRequest,
  findQoderCatalogModel,
  normalizeCatalogEntry,
  readQoderModelCatalog,
  resolveQoderCatalogModel,
  __private: {
    buildCatalogIndex,
    catalogCache,
    getCatalogWasmBundle,
    getCatalogWasmRuntime,
    normalizeDiscoveredModels
  }
};
