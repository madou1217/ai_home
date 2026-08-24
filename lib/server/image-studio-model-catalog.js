'use strict';

const { summarizeAccountAvailability } = require('./account-availability');
const { modelGeneratesImages } = require('./model-modality-index');
const { __private: { isApiKeyAccount } } = require('./image-generation-strategy-registry');
const {
  NATIVE_IMAGE_CAPABILITIES,
  getNativeImageCapabilities,
  getNativeImageQualityOptions,
  imageModelBelongsToProvider,
  listNativeImageModelSpecs
} = require('./image-generation-model-specs');

const PROVIDER_LABELS = Object.freeze({
  agy: 'Antigravity',
  codex: 'Codex',
  gemini: 'Gemini',
  grok: 'Grok'
});

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function collectDescriptorIds(account) {
  return []
    .concat(Array.isArray(account && account.codeAssistModelDescriptors) ? account.codeAssistModelDescriptors : [])
    .concat(Array.isArray(account && account.availableModelDescriptors) ? account.availableModelDescriptors : [])
    .concat(Array.isArray(account && account.modelDescriptors) ? account.modelDescriptors : [])
    .map((item) => String(item && (item.id || item.modelId) || '').trim())
    .filter(Boolean);
}

function collectCachedAccountModels(state, account) {
  const refs = [
    account && account.accountRef,
    account && account.id
  ].map((item) => String(item || '').trim()).filter(Boolean);
  const sources = [
    state && state.webUiModelsCache && state.webUiModelsCache.byAccount,
    state && state.modelsCache && state.modelsCache.byAccount
  ];
  const out = [];
  sources.forEach((source) => {
    if (!source || typeof source !== 'object') return;
    refs.forEach((ref) => {
      const models = source[ref];
      if (Array.isArray(models)) out.push(...models);
    });
  });
  return out;
}

function collectAccountModelIds(state, provider, account) {
  return Array.from(new Set([]
    .concat(Array.isArray(account && account.availableModels) ? account.availableModels : [])
    .concat(collectDescriptorIds(account))
    .concat(collectCachedAccountModels(state, account))
    .map((item) => String(item || '').trim())
    .filter(Boolean)));
}

function mergeCapabilities(target, source) {
  Object.entries(source || {}).forEach(([key, value]) => {
    if (key === 'maxInputImages') {
      target[key] = Math.max(Number(target[key]) || 0, Number(value) || 0);
      return;
    }
    target[key] = Boolean(target[key] || value);
  });
  return target;
}

function resolveAccountUnavailableReason(account, model, now = Date.now()) {
  const token = String(account && (account.apiKey || account.accessToken) || '').trim();
  if (!token) return 'credential_missing';
  const availability = summarizeAccountAvailability([account], { model, now });
  if (availability.available === 1) return '';
  return String(availability.reasons[0] && availability.reasons[0].reason || 'account_unavailable');
}

function ensureEntry(entries, provider, spec) {
  const id = String(spec && spec.id || '').trim();
  if (!provider || !id) return null;
  const key = `${provider}:${id}`;
  if (!entries.has(key)) {
    entries.set(key, {
      key,
      id,
      label: String(spec && spec.label || id).trim() || id,
      provider,
      providerLabel: PROVIDER_LABELS[provider] || provider,
      priority: Number(spec && spec.priority) || 500,
      sources: new Set(),
      capabilities: {},
      availableCapabilities: {},
      qualityOptions: new Set(),
      availableQualityOptions: new Set(),
      accountRefs: new Set(),
      availableAccountRefs: new Set(),
      accountAvailability: new Map()
    });
  }
  return entries.get(key);
}

function mergeOptions(target, values) {
  (Array.isArray(values) ? values : []).forEach((value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized) target.add(normalized);
  });
}

function addEntryAccount(entry, account, source, capabilities, qualityOptions, now) {
  if (!entry || !account) return;
  const accountRef = String(account.accountRef || account.id || '').trim();
  if (accountRef) {
    entry.accountRefs.add(accountRef);
    const unavailableReason = resolveAccountUnavailableReason(account, entry.id, now);
    entry.accountAvailability.set(accountRef, unavailableReason);
    if (!unavailableReason) {
      entry.availableAccountRefs.add(accountRef);
      mergeCapabilities(entry.availableCapabilities, capabilities);
      mergeOptions(entry.availableQualityOptions, qualityOptions);
    }
  }
  entry.sources.add(source);
  mergeCapabilities(entry.capabilities, capabilities);
  mergeOptions(entry.qualityOptions, qualityOptions);
}

function addNativeEntries(entries, provider, account, now) {
  listNativeImageModelSpecs(provider).forEach((spec) => {
    const capabilities = getNativeImageCapabilities(provider, spec.id);
    if (!capabilities) return;
    addEntryAccount(
      ensureEntry(entries, provider, spec),
      account,
      'native',
      capabilities,
      getNativeImageQualityOptions(provider, spec.id),
      now
    );
  });
}

function addDiscoveredEntries(entries, state, provider, account, now) {
  collectAccountModelIds(state, provider, account).forEach((id) => {
    if (!modelGeneratesImages(id, { provider })) return;
    if (!isApiKeyAccount(account) && !imageModelBelongsToProvider(provider, id)) return;
    const capabilityProvider = isApiKeyAccount(account) ? 'passthrough' : provider;
    const capabilities = isApiKeyAccount(account)
      ? NATIVE_IMAGE_CAPABILITIES.passthrough
      : getNativeImageCapabilities(provider, id);
    if (!capabilities) return;
    addEntryAccount(
      ensureEntry(entries, provider, { id }),
      account,
      'discovered',
      capabilities,
      getNativeImageQualityOptions(capabilityProvider, id),
      now
    );
  });
}

function serializeEntry(entry) {
  const capabilities = entry.availableAccountRefs.size > 0
    ? entry.availableCapabilities
    : entry.capabilities;
  const qualityOptions = entry.availableAccountRefs.size > 0
    ? entry.availableQualityOptions
    : entry.qualityOptions;
  const unavailableReasonCounts = new Map();
  entry.accountAvailability.forEach((reason) => {
    if (!reason) return;
    unavailableReasonCounts.set(reason, (unavailableReasonCounts.get(reason) || 0) + 1);
  });
  return {
    key: entry.key,
    id: entry.id,
    label: entry.label,
    provider: entry.provider,
    providerLabel: entry.providerLabel,
    priority: entry.priority,
    source: Array.from(entry.sources).sort().join('+'),
    capabilities: {
      generation: Boolean(capabilities.generation),
      edit: Boolean(capabilities.edit),
      mask: Boolean(capabilities.mask),
      multiple: Boolean(capabilities.multiple),
      size: Boolean(capabilities.size),
      quality: Boolean(capabilities.quality),
      responseFormat: Boolean(capabilities.responseFormat),
      maxInputImages: Math.max(1, Number(capabilities.maxInputImages) || 1),
      background: Boolean(capabilities.background),
      outputFormat: Boolean(capabilities.outputFormat),
      outputCompression: Boolean(capabilities.outputCompression),
      moderation: Boolean(capabilities.moderation)
    },
    qualityOptions: Array.from(qualityOptions),
    accountCount: entry.accountRefs.size,
    availableAccountCount: entry.availableAccountRefs.size,
    unavailableReasons: Array.from(unavailableReasonCounts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
  };
}

function listImageStudioModels(state, options = {}) {
  const providerMode = normalizeProvider(options.provider || 'auto');
  const accountsByProvider = state && state.accounts && typeof state.accounts === 'object'
    ? state.accounts
    : {};
  const entries = new Map();
  const now = Number(options.now) || Date.now();

  Object.entries(accountsByProvider).forEach(([providerRaw, accounts]) => {
    const provider = normalizeProvider(providerRaw);
    if (providerMode && providerMode !== 'auto' && provider !== providerMode) return;
    (Array.isArray(accounts) ? accounts : []).forEach((account) => {
      if (!account || typeof account !== 'object') return;
      if (!isApiKeyAccount(account)) addNativeEntries(entries, provider, account, now);
      addDiscoveredEntries(entries, state, provider, account, now);
    });
  });

  return Array.from(entries.values())
    .map(serializeEntry)
    .sort((left, right) => (
      left.priority - right.priority
      || left.provider.localeCompare(right.provider)
      || left.id.localeCompare(right.id)
    ));
}

module.exports = {
  listImageStudioModels,
  __private: {
    collectAccountModelIds,
    mergeCapabilities,
    mergeOptions,
    resolveAccountUnavailableReason
  }
};
