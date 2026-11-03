'use strict';

// opencode 免费模型互备：选中的免费模型在上游挂了，就换同账号下另一个免费模型接着答。
//
// 为什么需要（2026-10-18）：免费档的故障常常是**单个模型**的 —— 同一时刻 deepseek-v4.1-flash-free
// 连续 500、glm-5.3-flash-free 503「Endpoint is unavailable」，其余 8 个免费模型照常 200。
// 换出口、换端点都救不了模型本身挂掉；opencode 只会自己退避重试，用户只能干等。
// 账号的模型清单里本来就有一批免费模型，互为备份即可让请求接着跑。
//
// 边界：
//   - 只有「模型不可用」（上游 5xx，或任意状态码下的 Zen「Endpoint/Model is unavailable」）才换模型。
//     出口受限、门禁、鉴权、请求本身有问题都不是模型的问题，换模型救不了，原样抛给调用方走既有处理；
//   - 候选只来自账号自己的模型清单（不写死名单），过滤掉用户禁用的、请求带图而它看不了图的；
//   - 挂掉的模型短时间内（TTL）直接跳过、排到最后，省掉每一步都先撞一次 5xx；
//   - 全部失败时抛用户所选模型自己的错误 —— 报错如实指向用户选的模型。

const { isAccountModelEnabled } = require('./model-catalog-settings-store');
const { modelSupportsVision } = require('./model-modality-index');
const { bareOpenCodeModelId, isOpenCodeFreeModelId } = require('./opencode-free-models');

const DEFAULT_MAX_FALLBACK_MODELS = 3;
const DEFAULT_UNAVAILABLE_TTL_MS = 60 * 1000;
// 备选模型自己的请求被拒（参数不兼容等）只说明它不合适，接着试下一个；
// 这几类是账号/出口层面的，换哪个模型都一样，不能继续消耗。
const NON_CANDIDATE_CLIENT_STATUSES = new Set([401, 403, 429]);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function modelKey(model) {
  return bareOpenCodeModelId(model).toLowerCase();
}

function statusOf(error) {
  const direct = Number(error && error.statusCode);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const match = String(error && error.code || '').trim().toUpperCase().match(/^HTTP_(\d{3})$/);
  return match ? Number(match[1]) : 0;
}

// 上游 Zen 网关转发失败的标准形状：`{"error":{"type":"server_error","message":"Upstream request
// failed: Endpoint is unavailable."}}`。它说的是**模型背后的端点**挂了，状态码却不固定 ——
// 2026-10-19 13:27–15:15 glm-5.3-flash-free 一直以 429 回这个错误（254 次），只认 5xx 时
// 一次都没换模型。额度/出口受限是另一种形状（FreeUsageLimitError），不在此列。
const UPSTREAM_MODEL_UNAVAILABLE_RE = /upstream request failed:\s*(endpoint|model) is unavailable/i;

function readUpstreamError(error) {
  try {
    const body = JSON.parse(String(error && error.responseBody || ''));
    return body && typeof body.error === 'object' && body.error ? body.error : null;
  } catch (_error) {
    return null;
  }
}

function isModelUnavailableFailure(error) {
  if (statusOf(error) >= 500) return true;
  const upstream = readUpstreamError(error);
  return Boolean(upstream)
    && upstream.type === 'server_error'
    && UPSTREAM_MODEL_UNAVAILABLE_RE.test(String(upstream.message || ''));
}

function isCandidateRejection(error) {
  const status = statusOf(error);
  return status >= 400 && status < 500 && !NON_CANDIDATE_CLIENT_STATUSES.has(status);
}

/**
 * 进程内的模型可用性记忆（按上游裸模型名，与账号无关：挂的是模型本身）。
 */
function createFreeModelHealth(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_UNAVAILABLE_TTL_MS;
  const unavailableUntil = new Map();
  const lastSuccessAt = new Map();
  return {
    markUnavailable(model) {
      unavailableUntil.set(modelKey(model), now() + ttlMs);
    },
    markAvailable(model) {
      const key = modelKey(model);
      unavailableUntil.delete(key);
      lastSuccessAt.set(key, now());
    },
    isUnavailable(model) {
      const until = unavailableUntil.get(modelKey(model));
      return Boolean(until) && until > now();
    },
    lastSuccessAt(model) {
      return lastSuccessAt.get(modelKey(model)) || 0;
    }
  };
}

const sharedFreeModelHealth = createFreeModelHealth();

function requestHasImages(requestJson) {
  const messages = Array.isArray(requestJson && requestJson.messages) ? requestJson.messages : [];
  return messages.some((message) => Array.isArray(message && message.content) && message.content.some(
    (part) => part && (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image')
  ));
}

function readModelId(entry) {
  if (typeof entry === 'string') return normalizeString(entry);
  return normalizeString(entry && (entry.id || entry.model || entry.modelId));
}

/**
 * 备选免费模型（不含用户所选的那个），按「最近成功过的优先、其余保持清单顺序」排列，
 * 当前已知挂掉的不入选。
 *
 * @param {{ requestedModel: string, accountModels: Array<string|object>, requestJson?: object,
 *           provider?: string, accountRef?: string, modelCatalogSettings?: object,
 *           health?: object, isFreeModel?: Function, supportsVision?: Function }} input
 */
function listFreeFallbackCandidates(input = {}) {
  const health = input.health || sharedFreeModelHealth;
  const isFreeModel = typeof input.isFreeModel === 'function' ? input.isFreeModel : isOpenCodeFreeModelId;
  const supportsVision = typeof input.supportsVision === 'function' ? input.supportsVision : modelSupportsVision;
  const needsVision = requestHasImages(input.requestJson);
  const provider = normalizeString(input.provider);
  const accountRef = normalizeString(input.accountRef);
  const seen = new Set([modelKey(input.requestedModel)]);
  const candidates = [];
  (Array.isArray(input.accountModels) ? input.accountModels : []).forEach((entry) => {
    const id = readModelId(entry);
    const key = modelKey(id);
    if (!key || seen.has(key)) return;
    seen.add(key);
    if (!isFreeModel(id)) return;
    if (health.isUnavailable(id)) return;
    if (needsVision && !supportsVision(id, { provider })) return;
    if (accountRef && !isAccountModelEnabled(input.modelCatalogSettings, { id, provider, accountRef })) return;
    candidates.push(id);
  });
  return candidates
    .map((id, index) => ({ id, index, okAt: health.lastSuccessAt(id) }))
    .sort((a, b) => (b.okAt - a.okAt) || (a.index - b.index))
    .map((item) => item.id);
}

/**
 * 依次用「所选模型 → 备选模型」调用 fetchForModel，直到拿到上游响应。
 * fetchForModel 只能覆盖「拿到上游响应头」这一步：此时还没向客户端写任何字节，换模型重发是安全的。
 *
 * @returns {Promise<{ result: any, model: string }>}
 */
async function fetchWithFreeModelFallback(fetchForModel, input = {}) {
  const requestedModel = normalizeString(input.requestedModel);
  const health = input.health || sharedFreeModelHealth;
  const maxFallbacks = Number.isInteger(input.maxFallbacks) && input.maxFallbacks >= 0
    ? input.maxFallbacks
    : DEFAULT_MAX_FALLBACK_MODELS;
  const fallbacks = (Array.isArray(input.candidates) ? input.candidates : []).slice(0, maxFallbacks);
  // 所选模型刚挂过：先试备选，它自己排最后（TTL 过了会重新排第一，恢复后自动用回去）。
  const order = fallbacks.length > 0 && health.isUnavailable(requestedModel)
    ? [...fallbacks, requestedModel]
    : [requestedModel, ...fallbacks];

  let requestedError = null;
  let lastError = null;
  for (const model of order) {
    try {
      const result = await fetchForModel(model);
      health.markAvailable(model);
      return { result, model };
    } catch (error) {
      if (typeof input.onModelFailed === 'function') input.onModelFailed(model, statusOf(error) || 'error');
      if (input.signal && input.signal.aborted) throw error;
      const isRequested = model === requestedModel;
      if (isModelUnavailableFailure(error)) {
        health.markUnavailable(model);
      } else if (isRequested || !isCandidateRejection(error)) {
        throw error;
      }
      if (isRequested) requestedError = error;
      lastError = error;
    }
  }
  throw requestedError || lastError;
}

module.exports = {
  DEFAULT_MAX_FALLBACK_MODELS,
  DEFAULT_UNAVAILABLE_TTL_MS,
  createFreeModelHealth,
  fetchWithFreeModelFallback,
  isModelUnavailableFailure,
  listFreeFallbackCandidates,
  sharedFreeModelHealth
};
