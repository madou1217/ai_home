'use strict';

// 只读读取 Go 的账号级模型投影：GET /v1/management/account-models。
//
// 该模块只做「HTTP 响应 -> catalogResult 等价形状」的转换，不负责：
//   - baseUrl / Management Key / 超时 / 重试（由注入的 call 负责）；
//   - Node accountRef 与 Go accountRef 的映射（接线层负责，见 go-account-sync 的 links）；
//   - 缓存与失效（接线层负责，本模块每次 read 都调用 call）。
//
// call 的约定与 lib/account/go-bridge/go-management-client.js 的 call 一致：
//   call('GET', path) -> { ok, status, data, body, errorCode }
// 也接受直接返回的 JSON：{ data: [...], generation, updated_at_ms }。
//
// 失败语义（503、网络异常、payload 无效）返回 null，让调用方回落到 Node 探测缓存；
// data: [] 是合法的空结果，不返回 null。

const ACCOUNT_MODELS_PATH = '/v1/management/account-models';
const KNOWN_SOURCES = new Set(['remote', 'local', 'error', 'empty']);

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function toPositiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function toNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function toTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function listAccountRefs(query = {}) {
  const refs = [];
  const push = (value) => {
    if (Array.isArray(value)) {
      value.forEach(push);
      return;
    }
    const ref = normalizeText(value);
    if (ref && !refs.includes(ref)) refs.push(ref);
  };
  push(query.accountRef);
  push(query.accountRefs);
  push(query.account_ref);
  return refs;
}

// 过滤参数只做透传与去重；不在这里补默认值，Go 端点自己决定 limit 的默认值。
function buildRequestPath(query = {}) {
  const params = new URLSearchParams();
  const provider = normalizeText(query.provider || query.providerId);
  if (provider) params.set('provider', provider);
  listAccountRefs(query).forEach((accountRef) => params.append('account_ref', accountRef));
  const afterRef = normalizeText(query.afterRef || query.after_ref);
  if (afterRef) params.set('after_ref', afterRef);
  const limit = toPositiveInteger(query.limit);
  if (limit > 0) params.set('limit', String(limit));
  // 条件刷新：只要目录指纹，不拉账号/模型行（Go 对 meta_only=1 返回空 data）。
  if (query.metaOnly === true || query.meta_only === true) params.set('meta_only', '1');
  const suffix = params.toString();
  return suffix ? ACCOUNT_MODELS_PATH + '?' + suffix : ACCOUNT_MODELS_PATH;
}

function parseBody(response) {
  const body = response && response.body;
  if (body && typeof body === 'object') return body;
  if (typeof body === 'string' && body) {
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_error) {
      return null;
    }
  }
  return null;
}

function extractPayload(response) {
  const body = parseBody(response);
  const candidates = [
    response && response.data,
    body && body.data,
    response && response.data && response.data.data
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    let meta = body;
    if (!meta && response && response.data && !Array.isArray(response.data) && typeof response.data === 'object') {
      meta = response.data;
    }
    if (!meta) meta = response || null;
    return { accounts: candidate, meta };
  }
  return null;
}

function isFailure(response) {
  if (!response) return true;
  if (response.ok === false) return true;
  const status = Number(response.status);
  return Number.isFinite(status) && status >= 400;
}

function resolveAccountSource(account, modelIds) {
  const error = normalizeText(account && (account.last_error_message || account.last_error_code));
  if (error) return 'error';
  // 与 provider-model-discovery 一致：成功但目录为空标记为 empty，而不是沿用 remote。
  if (modelIds.length === 0) return 'empty';
  const declared = normalizeText(account && account.last_source).toLowerCase();
  if (KNOWN_SOURCES.has(declared)) return declared;
  return 'remote';
}

function normalizeAccount(account, options = {}) {
  const accountRef = normalizeText(account && (account.account_ref || account.accountRef));
  if (!accountRef) return null;
  const provider = normalizeText(account && (account.provider_id || account.provider));
  const rawModels = Array.isArray(account && account.models) ? account.models : [];
  const effectiveOnly = options.effectiveOnly === true;
  const modelIds = [];
  rawModels.forEach((model) => {
    // effectiveOnly 用于路由目录：force_disable 或上游不可用的行不能出现。
    // Go 端点每行都带 effective；旧端点/字符串模型没有该字段时仍按可用处理。
    if (effectiveOnly && model && typeof model === 'object' && model.effective !== true) return;
    const modelId = normalizeText(typeof model === 'string'
      ? model
      : model && (model.model_id || model.modelId || model.id));
    if (modelId && !modelIds.includes(modelId)) modelIds.push(modelId);
  });
  // Go 端点已按 model_id 排序；这里再排序一次，保证 mocked/旧端点也稳定。
  modelIds.sort();
  return {
    accountRef,
    provider,
    modelIds,
    source: resolveAccountSource(account, modelIds),
    error: normalizeText(account && (account.last_error_message || account.last_error_code)),
    probedAt: toTimestamp(account && (account.last_attempt_at_ms || account.last_attempt_at))
  };
}

function collectModelUpdatedAt(account) {
  const models = Array.isArray(account && account.models) ? account.models : [];
  let updatedAt = 0;
  models.forEach((model) => {
    const value = toTimestamp(model && (model.updated_at_ms || model.updatedAt));
    if (value > updatedAt) updatedAt = value;
  });
  return updatedAt;
}

// updatedAtMs 只来自 Go 的 updated_at_ms（或行内最大 updated_at_ms），绝不回落到
// 本地 now()：否则同一份数据每次读取都会得到新的时间戳，条件缓存永远命中不了。
function buildCatalogResult(payload, options = {}) {
  const byAccount = {};
  // accountRef → provider：Go 独有账号（Node 运行池没有）也要能判定 provider，
  // 否则 chat/composer 目录会把它们整块丢掉，与账号页不一致。
  const providerByAccount = {};
  const accountSource = {};
  const errorsByAccount = {};
  const accountProbedAt = {};
  const modelsByProvider = new Map();
  let firstError = '';
  let scannedAccounts = 0;
  let maxModelUpdatedAt = 0;
  let hasRemote = false;
  let hasLocal = false;

  (Array.isArray(payload.accounts) ? payload.accounts : []).forEach((account) => {
    const normalized = normalizeAccount(account, options);
    if (!normalized) return;
    const { accountRef } = normalized;
    byAccount[accountRef] = normalized.modelIds;
    if (normalized.provider) providerByAccount[accountRef] = normalized.provider;
    accountSource[accountRef] = normalized.source;
    if (normalized.error) {
      errorsByAccount[accountRef] = normalized.error;
      if (!firstError) firstError = normalized.error;
    }
    if (normalized.probedAt > 0 || normalized.modelIds.length > 0) {
      scannedAccounts += 1;
    }
    if (normalized.probedAt > 0) {
      accountProbedAt[accountRef] = normalized.probedAt;
    }
    if (normalized.source === 'remote') hasRemote = true;
    if (normalized.source === 'local') hasLocal = true;
    if (normalized.provider && normalized.modelIds.length > 0) {
      if (!modelsByProvider.has(normalized.provider)) modelsByProvider.set(normalized.provider, new Set());
      const providerModels = modelsByProvider.get(normalized.provider);
      normalized.modelIds.forEach((modelId) => providerModels.add(modelId));
    }
    const modelUpdatedAt = collectModelUpdatedAt(account);
    if (modelUpdatedAt > maxModelUpdatedAt) maxModelUpdatedAt = modelUpdatedAt;
  });

  const models = {};
  Array.from(modelsByProvider.keys()).sort().forEach((provider) => {
    models[provider] = Array.from(modelsByProvider.get(provider)).sort();
  });

  const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
  const updatedAtMs = toTimestamp(meta.updated_at_ms || meta.updatedAt) || maxModelUpdatedAt;
  const hasModels = Object.keys(models).length > 0;
  // 与 webui-model-cache 的 selectScopedCacheSource 同口径：
  // remote > local > error/empty（有模型时仍算 local，没有模型才是 error/empty）。
  let source = 'empty';
  if (hasRemote) source = 'remote';
  else if (hasLocal) source = 'local';
  else if (firstError) source = hasModels ? 'local' : 'error';
  else if (hasModels) source = 'local';

  return {
    cached: true,
    // updatedAt 保留给既有调用方（webui-model-catalog-source 的合并）；新调用方用
    // updatedAtMs。两者同值，0 表示 Go 没有提供可用的时间戳。
    updatedAt: updatedAtMs,
    updatedAtMs,
    source,
    sourceCount: Object.keys(models).length,
    scannedAccounts,
    firstError,
    models,
    byAccount,
    providerByAccount,
    accountSource,
    errorsByAccount,
    accountProbedAt,
    labels: {},
    generation: toNonNegativeInteger(meta.generation),
    generationKnown: meta.generation !== undefined && meta.generation !== null
  };
}

function createGoModelCatalogReader(options = {}) {
  const call = options.call;
  // effectiveOnly：只保留 Go 判定为 effective 的模型（harness 路由目录用）。
  // 默认 false，WebUI 展示仍拿完整关系快照（停用/人工行要能看见）。
  const effectiveOnly = options.effectiveOnly === true;
  if (typeof call !== 'function') {
    throw new TypeError('createGoModelCatalogReader: 需要注入 call(method, path)');
  }

  async function read(query = {}) {
    const path = buildRequestPath(query);
    let response;
    try {
      response = await call('GET', path);
    } catch (_error) {
      return null;
    }
    if (isFailure(response)) return null;
    const payload = extractPayload(response);
    if (!payload) return null;
    return buildCatalogResult(payload, { effectiveOnly });
  }

  // 目录指纹：只读 generation / updated_at_ms，不拉账号与模型行。
  //
  // 条件刷新用：指纹没变就跳过整份拉取。generation 缺失视为失败（旧端点/异常响应
  // 不能当成「目录没变」）；generation === 0 是合法值，表示 Go 侧目录为空/尚未恢复。
  async function readMeta() {
    let response;
    try {
      response = await call('GET', buildRequestPath({ metaOnly: true }));
    } catch (_error) {
      return null;
    }
    if (isFailure(response)) return null;
    const payload = parseBody(response);
    if (!payload || typeof payload !== 'object') return null;
    if (payload.generation === undefined || payload.generation === null) return null;
    return {
      generation: toNonNegativeInteger(payload.generation),
      updatedAtMs: toTimestamp(payload.updated_at_ms || payload.updatedAt)
    };
  }

  return { read, readMeta };
}

module.exports = {
  createGoModelCatalogReader,
  __private: {
    buildRequestPath,
    buildCatalogResult
  }
};
