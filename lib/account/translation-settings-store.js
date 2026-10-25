'use strict';

// 「AI 翻译」页面的默认值与开关的领域持久化层。
//
// 语义：source / target / model 三项都可以各自设定默认值，页面与全局悬浮窗共用同一份
// 设置（悬浮窗是「随时唤起的翻译」，如果它不跟随页面默认值，用户每次都要重选一次语言）。
//
// 存储沿用 account:* / config:* 的命名惯例，落在 app_kv 的单条记录上：
//   webui:translation-settings {
//     source: 'auto' | 语言代码,
//     target: 语言代码,
//     model: 模型 id（空 = 未显式设置，由前端按模型目录兜底）,
//     provider: 模型所属 provider（空 = 让网关按模型 id 路由）,
//     updatedAt: 毫秒时间戳
//   }
//
// 为什么不给每个会话存历史：翻译是无状态的一次性动作，设置只需记住「上次用的那套」，
// 存历史会让「默认值」语义变模糊。

const { readJsonValue, writeJsonValue } = require('../server/app-state-store');
const {
  AUTO_LANGUAGE,
  normalizeLanguageCode,
  isSupportedLanguage
} = require('../server/translation-language');

const TRANSLATION_SETTINGS_KEY = 'webui:translation-settings';
const DEFAULT_TRANSLATION_TARGET = 'zh-Hans';
const DEFAULT_TRANSLATION_TARGET_POLICY = 'saved';
const DEFAULT_TRANSLATION_COPY_SCOPE = 'selection';
const TRANSLATION_TARGET_POLICIES = new Set(['saved', 'explicit', 'confirm', 'same-language']);
const TRANSLATION_COPY_SCOPES = new Set(['selection', 'page', 'all']);
const TRANSLATION_ROUTE_OPERATIONS = new Set(['selection', 'batch', 'page', 'replace']);
// 模型 id 的长度上限只为挡住明显的坏值（整段 JSON、路径），不猜测真实命名的形状。
const MAX_MODEL_ID_LENGTH = 200;

function normalizeModelId(value) {
  const model = String(value || '').trim();
  return model.length > MAX_MODEL_ID_LENGTH ? model.slice(0, MAX_MODEL_ID_LENGTH) : model;
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

function normalizeSystemServerTarget(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const origin = String(input.origin || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//.test(origin)) return null;
  return { kind: 'aih-server', label: String(input.label || origin).trim().slice(0, 120), origin, serverId: String(input.serverId || '').trim().slice(0, 200) };
}

function normalizeSystemServerTargets(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  return list.map(normalizeSystemServerTarget).filter((item) => {
    if (!item || seen.has(item.serverId || item.origin)) return false;
    seen.add(item.serverId || item.origin);
    return true;
  }).slice(0, 32);
}

function normalizeTranslationRoutes(routes, legacySettings = {}) {
  // A missing field means this is an older settings record: migrate the
  // single model/provider pair once. An explicit empty array is meaningful and
  // clears all route preferences, so it must stay empty.
  if (routes === undefined) {
    const accountProvider = normalizeProvider(legacySettings.provider);
    const model = normalizeModelId(legacySettings.model);
    return accountProvider && model ? [{ id: `aih-gateway:${model}:${accountProvider}`, provider: 'aih-gateway', model, modelProvider: accountProvider, enabled: true, priority: 0, operations: ['selection'] }] : [];
  }
  if (!Array.isArray(routes)) return [];
  const seenIds = new Set();
  const normalized = [];
  routes.forEach((route) => {
    const input = route && typeof route === 'object' && !Array.isArray(route) ? route : {};
    const provider = normalizeProvider(input.provider);
    const model = normalizeModelId(input.model);
    if (!provider || !model) return;
    const operations = Array.isArray(input.operations) ? Array.from(new Set(input.operations.map((item) => String(item || '').trim().toLowerCase()).filter((item) => TRANSLATION_ROUTE_OPERATIONS.has(item)))) : [];
    const fallbackId = `route:${provider}:${model}`;
    const id = String(input.id || fallbackId).trim().slice(0, 200) || fallbackId;
    if (seenIds.has(id)) return;
    seenIds.add(id);
    const modelProvider = normalizeProvider(input.modelProvider);
    normalized.push({ id, provider, model, ...(modelProvider ? { modelProvider } : {}), enabled: input.enabled !== false, priority: normalized.length, operations: operations.length ? operations : ['selection'] });
  });
  return normalized;
}

/**
 * Settings written before ordered routes were introduced are represented as a
 * single `aih-gateway:<model>:<provider>` route.  That route is a migration
 * projection, not an explicit fallback chain.  When its model disappears or
 * has no available account, let the caller resolve the current catalog
 * default instead of replaying a stale route on every request.
 */
function resolveTranslationRoutesForRequest(routes, input = {}) {
  const list = Array.isArray(routes) ? routes : [];
  if (!list.length) return [];
  const legacyRoutes = list.filter((route) => (
    route && route.provider === 'aih-gateway'
      && String(route.id || '').startsWith('aih-gateway:')
  ));
  // Any non-migration route is an explicit user choice and must retain its
  // ordered fallback semantics, including a mixed chain.
  if (legacyRoutes.length !== list.length) return list;
  const configuredModel = normalizeModelId(input.configuredModel);
  const configuredProvider = normalizeProvider(input.configuredProvider);
  if (!configuredModel || !configuredProvider) return [];
  const settingsMatch = legacyRoutes.every((route) => (
    normalizeModelId(route.model) === configuredModel
      && normalizeProvider(route.modelProvider) === configuredProvider
  ));
  if (!settingsMatch) return [];
  const models = Array.isArray(input.catalog && input.catalog.models)
    ? input.catalog.models
    : [];
  const catalogEntry = models.find((model) => (
    normalizeModelId(model && model.id) === configuredModel
      && (!configuredProvider || normalizeProvider(model && model.provider) === configuredProvider)
  ));
  const savedRouteUsable = models.length === 0 || Boolean(catalogEntry && (
    catalogEntry.availableAccountCount === undefined
      || Number(catalogEntry.availableAccountCount) > 0
  ));
  const requestedOperation = String(input.operation || 'selection').trim().toLowerCase();
  const operation = TRANSLATION_ROUTE_OPERATIONS.has(requestedOperation) ? requestedOperation : 'selection';
  const projected = list.map((route) => ({
    ...route,
    operations: Array.from(new Set([...(Array.isArray(route.operations) ? route.operations : []), operation]))
  }));
  const fallbackModel = normalizeModelId(input.catalog && input.catalog.defaultModel);
  const fallbackProvider = normalizeProvider(input.catalog && input.catalog.defaultProvider);
  if (!fallbackModel || !fallbackProvider) return savedRouteUsable ? projected : [];
  if (projected.some((route) => (
    route.provider === 'aih-gateway'
      && route.model === fallbackModel
      && normalizeProvider(route.modelProvider) === fallbackProvider
  ))) return projected;
  const fallbackEntry = models.find((model) => (
    normalizeModelId(model && model.id) === fallbackModel
      && normalizeProvider(model && model.provider) === fallbackProvider
  ));
  if (models.length > 0 && (!fallbackEntry || (fallbackEntry.availableAccountCount !== undefined
    && Number(fallbackEntry.availableAccountCount) <= 0))) return savedRouteUsable ? projected : [];
  return [...projected, {
    id: `catalog-fallback:${fallbackModel}:${fallbackProvider}`,
    provider: 'aih-gateway',
    model: fallbackModel,
    modelProvider: fallbackProvider,
    enabled: true,
    priority: projected.length,
    operations: [operation]
  }];
}

/**
 * 归一化一份设置。非法值一律回落默认，不抛错：设置是「偏好」，
 * 一条坏记录不该让翻译页直接不可用（与 server config 的严格校验不同）。
 */
function normalizeTranslationSettings(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const sourceCode = normalizeLanguageCode(input.source);
  const targetCode = normalizeLanguageCode(input.target);
  const updatedAt = Number(input.updatedAt);
  const targetPolicy = String(input.targetPolicy || '').trim().toLowerCase();
  const copyScope = String(input.copyScope || '').trim().toLowerCase();
  const executionTarget = String(input.executionTarget || '').trim().toLowerCase();
  return {
    source: sourceCode === AUTO_LANGUAGE || isSupportedLanguage(sourceCode)
      ? sourceCode
      : AUTO_LANGUAGE,
    target: isSupportedLanguage(targetCode) ? targetCode : DEFAULT_TRANSLATION_TARGET,
    model: normalizeModelId(input.model),
    provider: normalizeProvider(input.provider),
    systemEnabled: input.systemEnabled === true,
    systemServerTarget: normalizeSystemServerTarget(input.systemServerTarget),
    systemServerTargets: normalizeSystemServerTargets(input.systemServerTargets),
    targetPolicy: TRANSLATION_TARGET_POLICIES.has(targetPolicy) ? targetPolicy : DEFAULT_TRANSLATION_TARGET_POLICY,
    autoCopy: input.autoCopy === true,
    copyScope: TRANSLATION_COPY_SCOPES.has(copyScope) ? copyScope : DEFAULT_TRANSLATION_COPY_SCOPE,
    executionTarget: executionTarget === 'direct-provider' ? 'direct-provider' : 'aih-server',
    routes: normalizeTranslationRoutes(input.routes, input),
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.floor(updatedAt) : 0
  };
}

function defaultTranslationSettings() {
  return normalizeTranslationSettings(null);
}

function readTranslationSettings(fs, aiHomeDir, deps = {}) {
  const stored = readJsonValue(fs, aiHomeDir, TRANSLATION_SETTINGS_KEY, { strict: true, ...deps });
  if (stored === null) return null;
  return normalizeTranslationSettings(stored);
}

function writeTranslationSettings(fs, aiHomeDir, patch = {}, deps = {}) {
  const current = readTranslationSettings(fs, aiHomeDir, deps);
  const next = normalizeTranslationSettings({
    ...(current || defaultTranslationSettings()),
    ...patch,
    updatedAt: Date.now()
  });
  const written = writeJsonValue(fs, aiHomeDir, TRANSLATION_SETTINGS_KEY, next, deps);
  if (!written) throw new Error('translation_settings_write_failed');
  return next;
}

module.exports = {
  TRANSLATION_SETTINGS_KEY,
  DEFAULT_TRANSLATION_TARGET,
  DEFAULT_TRANSLATION_TARGET_POLICY,
  DEFAULT_TRANSLATION_COPY_SCOPE,
  MAX_MODEL_ID_LENGTH,
  normalizeTranslationRoutes,
  resolveTranslationRoutesForRequest,
  defaultTranslationSettings,
  normalizeTranslationSettings,
  normalizeSystemServerTarget,
  normalizeSystemServerTargets,
  readTranslationSettings,
  writeTranslationSettings
};
