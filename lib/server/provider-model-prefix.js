'use strict';

// 模型命名空间前缀解析 —— provider 能力 `providerModelPrefix` 的唯一消费方。
//
// 背景（2026-10-25 真机）：模型目录里登记的是**裸** id（zcode 的 `glm-5.3`），
// 而客户端发的是带 provider 前缀的写法（`zcode/glm-5.3`）。前缀写法在选号器里既匹配
// 不上账号目录、也匹配不上倒排索引，于是被当成「目录已知且不含该模型」
// 的强否定证据（见 model-pool-narrowing 的 excludeAccountsWithoutModel），
// 整个账号池被排空 → 503 no_available_account。
//
// 为什么不全局剥离前缀：裸 id 常常被多个 provider 同时持有（实测 `glm-5.3` 同
// 时挂在 zcode / codebuddy / workbuddy / workbuddycn 名下），全局剥离等于把「钉住哪个
// provider」这层语义丢掉，请求会漂移到别家的池子。因此这里只认**描述符显式
// 声明**的前缀，且解析结果同时把 provider 钉死。未声明的 provider 行为
// 逐字节不变（包括 opencode 在 opencode-server-client 里的 `opencode/` /
// `opencode-go/` / `zen/` / `go/` 传输层特例——那些剥前缀是为了拼上游
// `providerID/modelID` 对，与本模块无关）。
//
// 命名空间形状的判定只看「哪个 provider 声明了这个前缀」（反向查
// 注册表副本），不维护 provider 名单。多个 provider 声明同一个别名时
// 判为歧义并放弃解析（fail-safe：不猜，保持原行为）。

// 已存在的完整 id 永远优先：目录里真的有 `zcode/xxx` 这样的 id 时不剥前缀。
// 与 webui-translation-routes 的 resolveRequestModel、model-namespace-header 同一条议事规则。
function listProviderCatalogIds(state, provider) {
  const sources = [
    state && state.webUiModelsCache && state.webUiModelsCache.byProvider,
    state && state.modelsCache && state.modelsCache.byProvider
  ];
  const ids = new Set();
  for (const source of sources) {
    const models = source && source[provider];
    if (!Array.isArray(models)) continue;
    for (const id of models) {
      const text = String(id || '').trim();
      if (text) ids.add(text.toLowerCase());
    }
  }
  return ids;
}

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function normalizeProvider(value) {
  return normalizeText(value).toLowerCase();
}

// 前缀→provider 反向映射：provider id 本身总是接受，另加描述符声明的 aliases。
// 注册表按需加载（描述符会拉起各 provider 的探针模块），避免模块初始化时形成环。
function listDeclaredModelPrefixes(options = {}) {
  const map = new Map();
  const ambiguous = new Set();
  let providers = [];
  let getCapability = null;
  try {
    const facade = require('../providers');
    providers = facade.listProviders('providerModelPrefix', options);
    getCapability = facade.getProviderCapability;
  } catch (_error) {
    return { map, ambiguous };
  }
  for (const provider of providers) {
    const id = normalizeProvider(provider);
    if (!id) continue;
    const capability = getCapability(id, 'providerModelPrefix', options);
    if (!capability || capability.supported !== true) continue;
    const aliases = Array.isArray(capability.aliases) ? capability.aliases : [];
    for (const prefix of [id, ...aliases]) {
      const key = normalizeProvider(prefix);
      if (!key) continue;
      const existing = map.get(key);
      if (existing && existing !== id) {
        // 同一个前缀被两个 provider 声明：谁都不能认，不猜。
        ambiguous.add(key);
        continue;
      }
      map.set(key, id);
    }
  }
  for (const key of ambiguous) map.delete(key);
  return { map, ambiguous };
}

// 请求里已经显式选了 provider（头 / 请求体）时它优先：与前缀矛盾就什么都不做，
// 让请求按原样子报错，而不是替客户端改主意。
function readExplicitProvider(input = {}) {
  const headers = input.headers || {};
  const headerProvider = normalizeProvider(headers['x-provider'] || headers['X-Provider']);
  if (headerProvider) return headerProvider;
  const requestJson = input.requestJson || {};
  const bodyProvider = normalizeProvider(requestJson.provider);
  if (bodyProvider) return bodyProvider;
  const options = input.options || {};
  const configured = normalizeProvider(options.provider);
  return configured === 'auto' ? '' : configured;
}

/**
 * 解析 `provider/model` 形式的模型 id。
 *
 * 只在以下全部成立时返回解析结果（否则返回 null，调用方原样转发）：
 *   * 模型 id 含 `/` 且前缀非空、剩余部分非空；
 *   * 前缀对应的 provider **显式声明**了 `providerModelPrefix`；
 *   * 请求未显式指定其他 provider，或指定的正是该 provider；
 *   * 完整 id 不在该 provider 的目录里（已存在的完整 id 永远优先）。
 *
 * @returns {{model: string, provider: string, prefix: string} | null}
 */
function resolveProviderModelPrefix(input = {}) {
  const raw = normalizeText(input.model);
  if (!raw) return null;
  const separator = raw.indexOf('/');
  if (separator <= 0 || separator >= raw.length - 1) return null;
  const prefix = normalizeProvider(raw.slice(0, separator));
  const rest = raw.slice(separator + 1).trim();
  if (!prefix || !rest) return null;

  const { map } = listDeclaredModelPrefixes(input.options || {});
  const provider = map.get(prefix);
  if (!provider) return null;

  const explicit = readExplicitProvider(input);
  if (explicit && explicit !== provider) return null;

  // 已存在的完整 id 优先：目录里真有这个带前缀的 id 时不动它。
  const catalogIds = input.catalogIds instanceof Set
    ? input.catalogIds
    : listProviderCatalogIds(input.state, provider);
  if (catalogIds.has(raw.toLowerCase())) return null;

  return { model: rest, provider, prefix };
}

/**
 * 入口改写：把 `provider/model` 还原成裸 id。无需改写时返回 null。
 * 与 model-namespace-header 同一形态（入口补全 / 解析，下游只看裸 id）。
 */
function applyProviderModelPrefix(input = {}) {
  const requestJson = input.requestJson;
  if (!requestJson || typeof requestJson !== 'object' || Array.isArray(requestJson)) return null;
  const resolved = resolveProviderModelPrefix({
    model: requestJson.model,
    headers: input.headers,
    options: input.options,
    state: input.state
  });
  if (!resolved) return null;
  return {
    requestJson: { ...requestJson, model: resolved.model },
    provider: resolved.provider,
    prefix: resolved.prefix,
    model: resolved.model
  };
}

module.exports = {
  applyProviderModelPrefix,
  resolveProviderModelPrefix,
  __private: { listDeclaredModelPrefixes, listProviderCatalogIds, readExplicitProvider }
};
