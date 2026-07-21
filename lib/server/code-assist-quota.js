'use strict';

const {
  extractCodeAssistModelDescriptors
} = require('./code-assist-model-registry');
const {
  isRealProviderModelId
} = require('./model-id');
const {
  __private: httpPrivate
} = require('./http-utils');
const {
  normalizeAgyPlanType
} = require('./agy-account-usage-view');

const DEFAULT_AGY_QUOTA_BASE_URLS = Object.freeze([
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal',
  'https://daily-cloudcode-pa.googleapis.com/v1internal',
  'https://cloudcode-pa.googleapis.com/v1internal'
]);

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, numeric));
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function parseBaseUrlList(rawValue) {
  if (Array.isArray(rawValue)) {
    return rawValue.map(normalizeText).filter(Boolean);
  }
  return normalizeText(rawValue)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function dedupe(values) {
  const seen = new Set();
  const out = [];
  (Array.isArray(values) ? values : []).forEach((value) => {
    const text = normalizeText(value).replace(/\/+$/, '');
    if (!text || seen.has(text)) return;
    seen.add(text);
    out.push(text);
  });
  return out;
}

function resolveAgyQuotaBaseUrls(options = {}, account = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  const explicitList = parseBaseUrlList(options.agyQuotaBaseUrls || env.AIH_AGY_QUOTA_BASE_URLS);
  if (explicitList.length > 0) return dedupe(explicitList);

  const explicitBase = normalizeText(
    options.agyQuotaBaseUrl
    || options.agyBaseUrl
    || account.baseUrl
  );
  if (explicitBase) return dedupe([explicitBase]);
  return DEFAULT_AGY_QUOTA_BASE_URLS.slice();
}

function buildCodeAssistMethodUrl(baseUrl, method) {
  const normalized = normalizeText(baseUrl).replace(/\/+$/, '');
  if (normalized.endsWith(`:${method}`)) return normalized;
  return httpPrivate.buildGeminiCodeAssistMethodUrl(normalized, method);
}

function createAgyCodeAssistQuotaHeaders(_options, account) {
  const accessToken = normalizeText(account && account.accessToken);
  return {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': httpPrivate.buildAgyCodeAssistUserAgent()
  };
}

function createHttpError(status, text, url) {
  const error = new Error(`HTTP ${status} ${String(text || '').slice(0, 240)}`.trim());
  error.code = `HTTP_${status}`;
  error.status = status;
  error.url = url;
  error.body = String(text || '');
  return error;
}

function shouldFallbackEndpoint(error) {
  const status = Number(error && error.status);
  return status === 404 || status === 429 || (status >= 500 && status < 600);
}

async function fetchJson(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...(init || {}), signal: controller.signal });
    const text = await response.text().catch(() => '');
    const json = parseJsonObject(text) || {};
    if (!response.ok) throw createHttpError(response.status, text, url);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function postCodeAssistJson(fetchImpl, url, options, account, body, timeoutMs) {
  return fetchJson(fetchImpl, url, {
    method: 'POST',
    headers: createAgyCodeAssistQuotaHeaders(options, account),
    body: JSON.stringify(body || {})
  }, timeoutMs);
}

function pickTierName(tier) {
  if (!tier || typeof tier !== 'object') return '';
  return normalizeText(tier.name || tier.id || tier.quotaTier || tier.quota_tier);
}

function extractSubscriptionTier(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const paid = pickTierName(payload.paidTier || payload.paid_tier);
  if (paid) return paid;
  const ineligible = Array.isArray(payload.ineligibleTiers || payload.ineligible_tiers)
    && (payload.ineligibleTiers || payload.ineligible_tiers).length > 0;
  const current = !ineligible ? pickTierName(payload.currentTier || payload.current_tier) : '';
  if (current) return current;
  const allowed = payload.allowedTiers || payload.allowed_tiers;
  if (!Array.isArray(allowed)) return '';
  const defaultTier = allowed.find((tier) => tier && tier.isDefault === true)
    || allowed.find((tier) => tier && tier.is_default === true)
    || allowed[0];
  const fallback = pickTierName(defaultTier);
  return fallback && ineligible ? `${fallback} (Restricted)` : fallback;
}

function applyProjectResponse(account, payload) {
  const project = normalizeText(payload && payload.cloudaicompanionProject);
  if (account && payload && typeof payload === 'object') {
    account.codeAssistLoadResponse = payload;
    account.codeAssistPaidTier = payload.paidTier && typeof payload.paidTier === 'object' ? payload.paidTier : null;
    account.codeAssistCurrentTier = payload.currentTier && typeof payload.currentTier === 'object' ? payload.currentTier : null;
    if (project) account.codeAssistProject = project;
  }
  return {
    project,
    subscriptionTier: extractSubscriptionTier(payload)
  };
}

async function fetchAgyCodeAssistProjectInfo(options = {}, account = {}, timeoutMs = 8000) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  if (typeof fetchImpl !== 'function') return { project: '', subscriptionTier: '' };
  const accessToken = normalizeText(account.accessToken);
  if (!accessToken) return { project: '', subscriptionTier: '' };

  const cachedProject = normalizeText(account.codeAssistProject);
  const cachedTier = extractSubscriptionTier(account.codeAssistLoadResponse || {});
  if (cachedProject && cachedTier) {
    return { project: cachedProject, subscriptionTier: cachedTier };
  }

  let lastError = null;
  const payload = {
    metadata: {
      ideType: 'ANTIGRAVITY'
    }
  };
  for (const baseUrl of resolveAgyQuotaBaseUrls(options, account)) {
    const url = buildCodeAssistMethodUrl(baseUrl, 'loadCodeAssist');
    try {
      return applyProjectResponse(
        account,
        await postCodeAssistJson(fetchImpl, url, options, { ...account, provider: 'agy' }, payload, timeoutMs)
      );
    } catch (error) {
      lastError = error;
      if (!shouldFallbackEndpoint(error)) break;
    }
  }
  return {
    project: cachedProject,
    subscriptionTier: cachedTier,
    error: lastError ? String(lastError.message || lastError) : ''
  };
}

function toNullableNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatResetInFromIso(resetTime) {
  const target = Date.parse(resetTime);
  if (!Number.isFinite(target) || target <= 0) return '';
  const diffMs = Math.max(0, target - Date.now());
  const totalMinutes = Math.ceil(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return 'soon';
}

function readQuotaInfo(modelInfo) {
  if (!modelInfo || typeof modelInfo !== 'object') return null;
  const quota = modelInfo.quotaInfo || modelInfo.quota_info;
  return quota && typeof quota === 'object' ? quota : null;
}

function normalizeQuotaModel(modelId, modelInfo) {
  const model = normalizeText(modelId || modelInfo && (modelInfo.model || modelInfo.id || modelInfo.modelId || modelInfo.model_id));
  if (!isRealProviderModelId(model)) return null;
  const quota = readQuotaInfo(modelInfo);
  if (!quota) return null;
  const remainingFraction = Number(quota.remainingFraction ?? quota.remaining_fraction);
  if (!Number.isFinite(remainingFraction)) return null;
  const resetTime = normalizeText(quota.resetTime || quota.reset_time);
  const resetAtMs = Date.parse(resetTime);
  if (!Number.isFinite(resetAtMs) || resetAtMs <= 0) return null;
  return {
    model,
    remainingPct: clampPercent(remainingFraction * 100),
    resetIn: '',
    resetAtMs,
    resetTime,
    displayName: normalizeText(modelInfo && (modelInfo.displayName || modelInfo.display_name)),
    supportsThinking: Boolean(modelInfo && (modelInfo.supportsThinking || modelInfo.supports_thinking)),
    supportsImages: Boolean(modelInfo && (modelInfo.supportsImages || modelInfo.supports_images)),
    maxTokens: toNullableNumber(modelInfo && (modelInfo.maxTokens ?? modelInfo.max_tokens)),
    maxOutputTokens: toNullableNumber(modelInfo && (modelInfo.maxOutputTokens ?? modelInfo.max_output_tokens))
  };
}

function listQuotaModels(payload) {
  const out = [];
  const models = payload && payload.models;
  if (Array.isArray(models)) {
    models.forEach((item) => {
      const descriptor = extractCodeAssistModelDescriptors('agy', item)[0] || null;
      const model = normalizeQuotaModel(descriptor && descriptor.id, item);
      if (model) out.push(model);
    });
  } else if (models && typeof models === 'object') {
    Object.entries(models).forEach(([modelId, modelInfo]) => {
      const model = normalizeQuotaModel(modelId, modelInfo);
      if (model) out.push(model);
    });
  }

  const byModel = new Map();
  out.forEach((item) => {
    const key = item.model.toLowerCase();
    const previous = byModel.get(key);
    if (!previous || item.remainingPct < previous.remainingPct) {
      byModel.set(key, item);
    }
  });
  return Array.from(byModel.values()).sort((a, b) => a.model.localeCompare(b.model));
}

function normalizeForwardingRules(payload) {
  const raw = payload && (payload.deprecatedModelIds || payload.deprecated_model_ids);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  Object.entries(raw).forEach(([source, value]) => {
    const from = normalizeText(source);
    const to = normalizeText(value && typeof value === 'object' ? (value.newModelId || value.new_model_id) : value);
    if (isRealProviderModelId(from) && isRealProviderModelId(to)) out[from] = to;
  });
  return out;
}

function parseAgyCodeAssistQuotaSnapshot(payload, options = {}) {
  const models = listQuotaModels(payload);
  if (models.length < 1) return null;
  const account = options.account && typeof options.account === 'object' ? options.account : {};
  return {
    schemaVersion: Number(options.schemaVersion) || 2,
    kind: 'agy_code_assist_quota',
    source: normalizeText(options.source) || 'agy_fetch_available_models',
    capturedAt: Number(options.capturedAt) || Date.now(),
    account: {
      email: normalizeText(account.email),
      planType: normalizeAgyPlanType(account.subscriptionTier, account.planType || 'oauth'),
      subscriptionTier: normalizeText(account.subscriptionTier),
      project: normalizeText(account.project)
    },
    models: models.map((model) => {
      return {
        model: model.model,
        remainingPct: model.remainingPct,
        resetIn: formatResetInFromIso(model.resetTime) || model.resetTime,
        resetAtMs: model.resetAtMs,
        displayName: model.displayName,
        supportsThinking: model.supportsThinking,
        supportsImages: model.supportsImages,
        maxTokens: model.maxTokens,
        maxOutputTokens: model.maxOutputTokens
      };
    }),
    modelForwardingRules: normalizeForwardingRules(payload)
  };
}

async function fetchAgyCodeAssistQuotaSnapshot(options = {}, account = {}, timeoutMs = 8000) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  if (typeof fetchImpl !== 'function') return null;
  const accessToken = normalizeText(account.accessToken);
  if (!accessToken) return null;

  const projectInfo = await fetchAgyCodeAssistProjectInfo(options, account, timeoutMs);
  const project = normalizeText(projectInfo.project);
  let lastError = null;
  for (const baseUrl of resolveAgyQuotaBaseUrls(options, account)) {
    const url = buildCodeAssistMethodUrl(baseUrl, 'fetchAvailableModels');
    const bodies = project ? [{ project }, {}] : [{}];
    for (let idx = 0; idx < bodies.length; idx += 1) {
      try {
        const payload = await postCodeAssistJson(fetchImpl, url, options, { ...account, provider: 'agy' }, bodies[idx], timeoutMs);
        const descriptors = extractCodeAssistModelDescriptors('agy', payload);
        if (account && descriptors.length > 0) {
          account.codeAssistModelDescriptors = descriptors;
          account.availableModels = descriptors.map((descriptor) => descriptor.id).filter(Boolean);
        }
        const snapshot = parseAgyCodeAssistQuotaSnapshot(payload, {
          schemaVersion: options.schemaVersion,
          source: options.source,
          account: {
            email: account.email,
            planType: normalizeAgyPlanType(projectInfo.subscriptionTier, 'oauth'),
            subscriptionTier: projectInfo.subscriptionTier,
            project
          }
        });
        if (snapshot) return snapshot;
        lastError = new Error('empty_parsed_snapshot');
      } catch (error) {
        lastError = error;
        if (Number(error && error.status) === 403 && idx === 0 && project) continue;
        break;
      }
    }
    if (!shouldFallbackEndpoint(lastError)) break;
  }
  if (lastError) throw lastError;
  return null;
}

module.exports = {
  DEFAULT_AGY_QUOTA_BASE_URLS,
  fetchAgyCodeAssistProjectInfo,
  fetchAgyCodeAssistQuotaSnapshot,
  parseAgyCodeAssistQuotaSnapshot,
  resolveAgyQuotaBaseUrls,
  __private: {
    buildCodeAssistMethodUrl,
    createAgyCodeAssistQuotaHeaders,
    listQuotaModels,
    normalizeForwardingRules,
    normalizeQuotaModel
  }
};
