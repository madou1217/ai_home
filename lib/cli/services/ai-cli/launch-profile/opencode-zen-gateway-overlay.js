'use strict';

// `aih opencode`：把 opencode 内置的 `opencode`（Zen）provider 的网络改道到 aih 网关。
//
// 为什么需要（2026-10-18）：用户在 opencode 里选的 `opencode/deepseek-v4.1-flash-free`
// 走的是内置 Zen provider，它自己直连 opencode.ai —— aih 网关的端点回退
// （/inference/v1 → /zen/v1）、出口池、账号与用量记账全都用不上，一限流就只能干等。
//
// 实测（opencode 2.0.x，抓包确认）能改道的唯一入口是**模型目录**：
//   - `OPENCODE_CONFIG_CONTENT` 里的 `provider.opencode.options.baseURL` / `api` 都不生效；
//   - 目录（models.dev 格式，`OPENCODE_MODELS_PATH`）里 provider 级 `api` 与模型级
//     `provider.api` 生效；模型级 `headers` 不生效；
//   - provider 级 `options.apiKey` / `options.headers` 生效（`Authorization` 不能用 headers
//     覆盖，SDK 会写回 `Bearer public`），所以网关凭据走 apiKey。
// 于是：每次启动从 opencode 自己缓存的目录（来源见 opencode-catalog-source）派生一份
// 改写版（只改地址，模型清单原样 —— 不写死任何模型），把 Zen provider 的全部流量指向网关；
// 网关凭据与 provider 声明只在改写成功时才注入，保证 aih 的 key 绝不会随请求发到 opencode.ai。

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { MODEL_NAMESPACE_HEADER } = require('../../../../server/model-namespace-header');
const { readOpenCodeCatalog } = require('./opencode-catalog-source');

// opencode 内置 Zen provider 在目录里的 id，也是 aih 目录里 Zen 模型的命名空间。
const ZEN_PROVIDER_ID = 'opencode';
// 单一固定文件，每次启动原子覆盖（不留按次生成的残骸）。
const OVERLAY_FILE_NAME = 'opencode-gateway-models.json';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 把目录里 Zen provider 的地址改成网关；其余字段与其它 provider 原样保留。
 * 目录里没有 Zen provider 时返回 null（不改道）。
 */
function rewriteZenProviderEndpoint(catalog, gatewayBaseUrl) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return null;
  const zen = catalog[ZEN_PROVIDER_ID];
  if (!zen || typeof zen !== 'object') return null;
  const models = zen.models && typeof zen.models === 'object' ? zen.models : {};
  const rewrittenModels = {};
  for (const [id, model] of Object.entries(models)) {
    const override = model && typeof model.provider === 'object' && model.provider ? model.provider : null;
    // 模型级 `provider.api` 会盖过 provider 级地址；有就一并改，否则该模型会绕开网关直连。
    rewrittenModels[id] = override && override.api
      ? { ...model, provider: { ...override, api: gatewayBaseUrl } }
      : model;
  }
  return {
    ...catalog,
    [ZEN_PROVIDER_ID]: { ...zen, api: gatewayBaseUrl, models: rewrittenModels }
  };
}

function writeFileAtomic(fs, path, filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    // 失败时不留按次生成的临时文件（只允许一个固定文件存在）。
    try { fs.rmSync(tempPath, { force: true }); } catch (_cleanupError) { /* best effort */ }
    throw error;
  }
}

/**
 * 生成改道目录并返回启动所需的注入物；任何一步拿不到（无缓存目录、目录损坏、
 * 缺网关地址/凭据、写盘失败）都返回 null —— 内置 provider 维持原样直连，不降级其它功能。
 *
 * @returns {{ modelsPath: string, providerOptions: object }|null}
 */
function prepareZenGatewayOverlay(input = {}) {
  const fs = input.fs || nodeFs;
  const path = input.path || nodePath;
  const gatewayBaseUrl = normalizeString(input.gatewayBaseUrl);
  const gatewayApiKey = normalizeString(input.gatewayApiKey);
  const aiHomeDir = normalizeString(input.aiHomeDir);
  if (!gatewayBaseUrl || !gatewayApiKey || !aiHomeDir) return null;

  const modelsPath = path.join(aiHomeDir, 'run', OVERLAY_FILE_NAME);
  const source = readOpenCodeCatalog({
    fs,
    path,
    hostHomeDir: normalizeString(input.hostHomeDir),
    baseEnv: input.baseEnv,
    excludePath: modelsPath,
    DatabaseSync: input.DatabaseSync
  });
  const rewritten = source ? rewriteZenProviderEndpoint(source.catalog, gatewayBaseUrl) : null;
  if (!rewritten) return null;

  try {
    writeFileAtomic(fs, path, modelsPath, JSON.stringify(rewritten));
  } catch (_error) {
    return null;
  }

  return {
    modelsPath,
    providerOptions: {
      // 只在改道成功时注入：此时 Zen provider 的每个请求都发往网关，key 不会外泄。
      apiKey: gatewayApiKey,
      headers: {
        // 内置 provider 发裸模型名：显式声明 provider 与命名空间，网关据此补成
        // `opencode/<model>`，与 aih 目录里的 Zen 模型 id 对齐（见 model-namespace-header）。
        'x-provider': ZEN_PROVIDER_ID,
        [MODEL_NAMESPACE_HEADER]: ZEN_PROVIDER_ID
      }
    }
  };
}

/** 把改道注入物合并进网关 overlay 配置（保留已有的 provider 定义）。 */
function applyZenGatewayOverlay(config, overlay) {
  if (!overlay || !config || typeof config !== 'object') return config;
  const providers = config.provider && typeof config.provider === 'object' ? config.provider : {};
  const zen = providers[ZEN_PROVIDER_ID] && typeof providers[ZEN_PROVIDER_ID] === 'object'
    ? providers[ZEN_PROVIDER_ID]
    : {};
  const zenOptions = zen.options && typeof zen.options === 'object' ? zen.options : {};
  return {
    ...config,
    provider: {
      ...providers,
      [ZEN_PROVIDER_ID]: {
        ...zen,
        options: {
          ...zenOptions,
          ...overlay.providerOptions,
          headers: { ...(zenOptions.headers || {}), ...overlay.providerOptions.headers }
        }
      }
    }
  };
}

module.exports = {
  OVERLAY_FILE_NAME,
  ZEN_PROVIDER_ID,
  applyZenGatewayOverlay,
  prepareZenGatewayOverlay,
  rewriteZenProviderEndpoint
};
