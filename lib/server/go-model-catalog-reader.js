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

function normalizeAccount(account) {
  const accountRef = normalizeText(account && (account.account_ref || account.accountRef));
  if (!accountRef) return null;
  const provider = normalizeText(account && (account.provider_id || account.provider));
  const rawModels = Array.isArray(account && account.models) ? account.models : [];
  const modelIds = [];
  rawModels.forEach((model) => {
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

function buildCatalogResult(payload, now) {
  const byAccount = {};
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
    const normalized = normalizeAccount(account);
    if (!normalized) return;
    const { accountRef } = normalized;
    byAccount[accountRef] = normalized.modelIds;
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
  const updatedAt = toTimestamp(meta.updated_at_ms || meta.updatedAt)
    || maxModelUpdatedAt
    || toTimestamp(now());
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
    updatedAt,
    source,
    sourceCount: Object.keys(models).length,
    scannedAccounts,
    firstError,
    models,
    byAccount,
    accountSource,
    errorsByAccount,
    accountProbedAt,
    labels: {},
    generation: toNonNegativeInteger(meta.generation)
  };
}

function createGoModelCatalogReader(options = {}) {
  const call = options.call;
  const now = typeof options.now === 'function' ? options.now : Date.now;
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
    return buildCatalogResult(payload, now);
  }

  return { read };
}

module.exports = {
  createGoModelCatalogReader,
  __private: {
    buildRequestPath,
    buildCatalogResult
  }
};
