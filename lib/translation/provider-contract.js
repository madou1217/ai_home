'use strict';

// Translation providers have a smaller contract than inference providers.  A
// descriptor declares the surfaces a route may use; it does not contain an
// HTTP client or a provider-name switch.  The facade resolves the optional
// adapter reference at the composition root.

const TRANSLATION_PROVIDER_CONTRACT_VERSION = 1;
const TRANSLATION_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const TRANSLATION_OPERATION_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const TRANSLATION_FIELD_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const TRANSLATION_OPERATIONS = Object.freeze(['selection', 'batch', 'page', 'replace']);
const TRANSLATION_AUTH_MODES = Object.freeze(['managed', 'api-key', 'oauth', 'none']);

class TranslationProviderDescriptorError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'TranslationProviderDescriptorError';
    this.code = code;
    this.detail = String(detail || '');
  }
}

function descriptorError(code, detail) {
  return new TranslationProviderDescriptorError(code, detail);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function normalizeId(value) {
  return normalizeText(value).toLowerCase();
}

function freezeArray(values) {
  return Object.freeze(values.slice());
}

function normalizeStringList(value, field, id, options = {}) {
  if (value === undefined) return freezeArray([]);
  if (!Array.isArray(value)) throw descriptorError(`translation_descriptor_${field}_invalid`, id);
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const text = normalizeText(item);
    const normalized = options.lowercase === false ? text : text.toLowerCase();
    if (!normalized) continue;
    if (options.pattern && !options.pattern.test(normalized)) {
      throw descriptorError(`translation_descriptor_${field}_invalid`, `${id}:${normalized}`);
    }
    if (options.allowed && !options.allowed.includes(normalized)) {
      throw descriptorError(`translation_descriptor_${field}_unknown`, `${id}:${normalized}`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return freezeArray(result);
}

function normalizeOperations(input, id) {
  const capabilities = isPlainObject(input.capabilities) ? input.capabilities : {};
  const raw = input.operations !== undefined ? input.operations : capabilities.operations;
  const operations = normalizeStringList(raw, 'operations', id, {
    pattern: TRANSLATION_OPERATION_ID_PATTERN,
    allowed: TRANSLATION_OPERATIONS
  });
  if (operations.length === 0) {
    throw descriptorError('translation_descriptor_operations_missing', id);
  }
  return operations;
}

function normalizeCapabilities(input, id, operations) {
  const raw = isPlainObject(input.capabilities) ? input.capabilities : {};
  const normalized = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'operations') continue;
    if (key === 'streaming' || key === 'detection' || key === 'sourceAuto' || key === 'glossary' || key === 'formality') {
      if (typeof value !== 'boolean') {
        throw descriptorError('translation_descriptor_capability_invalid', `${id}:${key}`);
      }
      normalized[key] = value;
      continue;
    }
    // Capability extensions remain data.  They are copied so an adapter may
    // inspect them, while unknown names do not create dispatch branches.
    if (value !== null && typeof value === 'object') normalized[key] = Array.isArray(value) ? freezeArray(value.slice()) : Object.freeze({ ...value });
    else normalized[key] = value;
  }
  normalized.operations = operations;
  return Object.freeze(normalized);
}

function normalizeAuth(input, id) {
  const raw = input.auth === undefined ? {} : input.auth;
  if (!isPlainObject(raw)) throw descriptorError('translation_descriptor_auth_invalid', id);
  const modes = normalizeStringList(raw.modes, 'auth_modes', id, { allowed: TRANSLATION_AUTH_MODES });
  const fields = normalizeStringList(raw.fields, 'auth_fields', id, { pattern: TRANSLATION_FIELD_ID_PATTERN, lowercase: false });
  const normalized = { ...raw, modes, fields };
  if (raw.required !== undefined && typeof raw.required !== 'boolean') {
    throw descriptorError('translation_descriptor_auth_required_invalid', id);
  }
  normalized.required = raw.required === true;
  return Object.freeze(normalized);
}

function normalizeConfig(input, id) {
  const raw = input.config === undefined ? {} : input.config;
  if (!isPlainObject(raw)) throw descriptorError('translation_descriptor_config_invalid', id);
  const fields = normalizeStringList(raw.fields, 'config_fields', id, { pattern: TRANSLATION_FIELD_ID_PATTERN, lowercase: false });
  return Object.freeze({ ...raw, fields });
}

function normalizeClientFree(input, id) {
  const reason = normalizeText(input.clientFreeReason);
  const adapter = normalizeText(input.clientFreeAdapter);
  if (!reason && !adapter) {
    throw descriptorError('translation_descriptor_client_free_missing', id);
  }
  if (reason && adapter) {
    throw descriptorError('translation_descriptor_client_free_ambiguous', id);
  }
  if (adapter && !TRANSLATION_PROVIDER_ID_PATTERN.test(adapter)) {
    throw descriptorError('translation_descriptor_client_free_adapter_invalid', `${id}:${adapter}`);
  }
  return { clientFreeReason: reason, clientFreeAdapter: adapter };
}

/** Validate and freeze a translation provider descriptor. */
function validateTranslationProviderDescriptor(input) {
  if (!isPlainObject(input)) throw descriptorError('translation_descriptor_invalid');
  if (Number(input.contractVersion) !== TRANSLATION_PROVIDER_CONTRACT_VERSION) {
    throw descriptorError('translation_descriptor_contract_version_unsupported', String(input.contractVersion));
  }
  const id = normalizeId(input.id);
  if (!TRANSLATION_PROVIDER_ID_PATTERN.test(id)) throw descriptorError('translation_descriptor_id_invalid', id);
  const label = normalizeText(input.label);
  if (!label) throw descriptorError('translation_descriptor_label_missing', id);
  const operations = normalizeOperations(input, id);
  const clientFree = normalizeClientFree(input, id);
  const adapter = normalizeText(input.adapter);
  if (adapter && !TRANSLATION_PROVIDER_ID_PATTERN.test(adapter)) {
    throw descriptorError('translation_descriptor_adapter_invalid', `${id}:${adapter}`);
  }
  if (adapter && clientFree.clientFreeAdapter) {
    throw descriptorError('translation_descriptor_adapter_ambiguous', id);
  }
  return Object.freeze({
    contractVersion: TRANSLATION_PROVIDER_CONTRACT_VERSION,
    id,
    label,
    capabilities: normalizeCapabilities(input, id, operations),
    operations,
    auth: normalizeAuth(input, id),
    config: normalizeConfig(input, id),
    adapter,
    clientFreeReason: clientFree.clientFreeReason,
    clientFreeAdapter: clientFree.clientFreeAdapter,
    metadata: isPlainObject(input.metadata) ? Object.freeze({ ...input.metadata }) : Object.freeze({})
  });
}

module.exports = {
  TRANSLATION_PROVIDER_CONTRACT_VERSION,
  TRANSLATION_PROVIDER_ID_PATTERN,
  TRANSLATION_OPERATION_ID_PATTERN,
  TRANSLATION_FIELD_ID_PATTERN,
  TRANSLATION_OPERATIONS,
  TRANSLATION_AUTH_MODES,
  TranslationProviderDescriptorError,
  descriptorError,
  validateTranslationProviderDescriptor,
  __private: { isPlainObject, normalizeText, normalizeId }
};
