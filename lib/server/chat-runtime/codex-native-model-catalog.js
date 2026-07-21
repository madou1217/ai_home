'use strict';

const { ChatRuntimeError } = require('./contracts');

const CATALOG_PROMISE_BY_CLIENT = new WeakMap();

class CodexNativeModelCatalog {
  constructor(options = {}) {
    this.client = requireClient(options.client);
  }

  async prewarm() {
    await this.readVerifiedCatalog();
  }

  async list() {
    return this.readVerifiedCatalog();
  }

  async resolveTurnSettings(request = {}) {
    const catalog = await this.readVerifiedCatalog();
    return selectTurnSettings(catalog, request);
  }

  async readVerifiedCatalog() {
    await this.client.ensureConnected();
    requireVerifiedExecutionCredential(this.client.getVerifiedAccountIdentity());
    return this.loadCatalog();
  }

  loadCatalog() {
    const existing = CATALOG_PROMISE_BY_CLIENT.get(this.client);
    if (existing) return existing;
    const pending = this.client.request('model/list', { includeHidden: false })
      .then(parseModelCatalog);
    CATALOG_PROMISE_BY_CLIENT.set(this.client, pending);
    pending.catch(() => {
      if (CATALOG_PROMISE_BY_CLIENT.get(this.client) === pending) {
        CATALOG_PROMISE_BY_CLIENT.delete(this.client);
      }
    });
    return pending;
  }
}

function parseModelCatalog(response) {
  const data = Array.isArray(response && response.data) ? response.data : [];
  const entries = data.map(parseModelEntry).filter(Boolean);
  if (entries.length === 0) {
    throw new ChatRuntimeError('codex_native_model_catalog_empty', 502);
  }
  return Object.freeze(entries);
}

function parseModelEntry(value) {
  const entry = value && typeof value === 'object' ? value : {};
  const model = text(entry.model);
  if (!model) return null;
  const options = Array.isArray(entry.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts
    : [];
  const supportedReasoningEfforts = Object.freeze(options
    .map((option) => normalizedEffort(option && option.reasoningEffort))
    .filter(Boolean));
  const defaultReasoningEffort = normalizedEffort(entry.defaultReasoningEffort);
  if (
    !defaultReasoningEffort
    || (
      supportedReasoningEfforts.length > 0
      && !supportedReasoningEfforts.includes(defaultReasoningEffort)
    )
  ) {
    throw new ChatRuntimeError('codex_native_model_catalog_invalid', 502, {
      model,
      field: 'defaultReasoningEffort'
    });
  }
  return Object.freeze({
    model,
    displayName: text(entry.displayName || entry.name) || model,
    isDefault: entry.isDefault === true,
    supportedReasoningEfforts,
    defaultReasoningEffort
  });
}

function selectTurnSettings(catalog, request) {
  const requestedModel = text(request.model);
  const requestedEntry = requestedModel
    ? catalog.find((candidate) => candidate.model === requestedModel)
    : null;
  if (requestedModel && !requestedEntry) {
    throw new ChatRuntimeError('codex_native_model_unavailable', 422, {
      model: requestedModel,
      availableModels: catalog.map((candidate) => candidate.model)
    });
  }
  const entry = requestedEntry
    || catalog.find((candidate) => candidate.isDefault)
    || catalog[0];
  const requestedEffort = normalizedEffort(request.reasoningEffort);
  if (
    requestedEffort
    && !entry.supportedReasoningEfforts.includes(requestedEffort)
  ) {
    throw new ChatRuntimeError('codex_native_reasoning_effort_unsupported', 422, {
      model: entry.model,
      reasoningEffort: requestedEffort,
      supportedReasoningEfforts: [...entry.supportedReasoningEfforts]
    });
  }
  const reasoningEffort = requestedEffort || entry.defaultReasoningEffort;
  return Object.freeze({ model: entry.model, reasoningEffort });
}

function requireVerifiedExecutionCredential(identity) {
  const verifiedOAuth = identity
    && identity.verified === true
    && identity.kind === 'oauth'
    && identity.assurance === 'identity';
  const verifiedApiKey = identity
    && identity.verified === true
    && identity.kind === 'api-key'
    && identity.assurance === 'execution-credential';
  if (!verifiedOAuth && !verifiedApiKey) {
    throw new ChatRuntimeError('codex_native_model_identity_not_verified', 503);
  }
}

function requireClient(client) {
  if (
    !client
    || typeof client.ensureConnected !== 'function'
    || typeof client.getVerifiedAccountIdentity !== 'function'
    || typeof client.request !== 'function'
  ) {
    throw new TypeError('Codex native model catalog requires a resident client');
  }
  return client;
}

function normalizedEffort(value) {
  return text(value).toLowerCase();
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

module.exports = { CodexNativeModelCatalog };
