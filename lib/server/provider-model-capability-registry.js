'use strict';

const { normalizeModelId } = require('./providers');

const MODEL_FAMILIES = Object.freeze({
  ANY: 'any',
  CLAUDE_OPUS_THINKING: 'claude_opus_thinking'
});

const PROVIDER_MODEL_CAPABILITY_RULES = Object.freeze([
  Object.freeze({
    id: 'codex:openai_responses:omit-temperature',
    reason: 'codex_openai_responses_does_not_accept_temperature',
    provider: 'codex',
    protocols: Object.freeze(['openai_responses']),
    modelFamily: MODEL_FAMILIES.ANY,
    request: Object.freeze({
      omitKeys: Object.freeze(['temperature'])
    })
  }),
  Object.freeze({
    id: 'agy:code_assist:claude_opus_thinking:omit-temperature',
    reason: 'agy_claude_opus_thinking_code_assist_does_not_accept_generation_temperature',
    provider: 'agy',
    protocols: Object.freeze([
      'gemini_code_assist_generate_content',
      'gemini_code_assist_stream_generate_content'
    ]),
    modelFamily: MODEL_FAMILIES.CLAUDE_OPUS_THINKING,
    generationConfig: Object.freeze({
      omitKeys: Object.freeze(['temperature'])
    })
  })
]);

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeModelTokens(model) {
  return normalizeModelId(model)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function modelMatchesFamily(model, family) {
  const normalizedFamily = normalizeKey(family);
  if (!normalizedFamily || normalizedFamily === MODEL_FAMILIES.ANY) return true;

  const tokens = new Set(normalizeModelTokens(model));
  if (normalizedFamily === MODEL_FAMILIES.CLAUDE_OPUS_THINKING) {
    return tokens.has('claude') && tokens.has('opus') && tokens.has('thinking');
  }

  return false;
}

function ruleMatchesRequest(rule, options = {}) {
  if (!rule || typeof rule !== 'object') return false;
  const provider = normalizeKey(options.provider);
  const protocol = normalizeKey(options.protocol || options.upstreamProtocol);
  if (!provider || provider !== normalizeKey(rule.provider)) return false;
  if (!protocol || !(Array.isArray(rule.protocols) && rule.protocols.includes(protocol))) return false;

  const models = [
    options.originalModel,
    options.model
  ].map((item) => String(item || '').trim()).filter(Boolean);
  if (normalizeKey(rule.modelFamily) === MODEL_FAMILIES.ANY) return true;
  return models.some((model) => modelMatchesFamily(model, rule.modelFamily));
}

function uniqueSortedKeys(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))).sort();
}

function listCapabilityOmitKeys(options = {}, sectionName) {
  const keys = [];
  listAppliedCapabilityRules(options, sectionName)
    .forEach((rule) => {
      keys.push(...rule.omitKeys);
    });
  return uniqueSortedKeys(keys);
}

function listAppliedCapabilityRules(options = {}, sectionName) {
  return PROVIDER_MODEL_CAPABILITY_RULES
    .filter((rule) => ruleMatchesRequest(rule, options))
    .map((rule) => {
      const section = rule && rule[sectionName];
      const omitKeys = section && Array.isArray(section.omitKeys)
        ? uniqueSortedKeys(section.omitKeys)
        : [];
      if (omitKeys.length < 1) return null;
      return {
        id: rule.id,
        provider: rule.provider,
        protocols: Array.isArray(rule.protocols) ? rule.protocols.slice() : [],
        modelFamily: rule.modelFamily,
        section: sectionName,
        omitKeys,
        reason: String(rule.reason || '').trim()
      };
    })
    .filter(Boolean);
}

function listOmittedRequestParameterKeys(options = {}) {
  return listCapabilityOmitKeys(options, 'request');
}

function listOmittedGenerationConfigKeys(options = {}) {
  return listCapabilityOmitKeys(options, 'generationConfig');
}

function listAppliedRequestParameterCapabilityRules(options = {}) {
  return listAppliedCapabilityRules(options, 'request');
}

function listAppliedGenerationConfigCapabilityRules(options = {}) {
  return listAppliedCapabilityRules(options, 'generationConfig');
}

function applyOmittedKeys(source, keys) {
  const input = source && typeof source === 'object' ? source : {};
  const omittedKeys = uniqueSortedKeys(keys);
  if (omittedKeys.length < 1) return input;
  const next = { ...input };
  omittedKeys.forEach((key) => {
    delete next[key];
  });
  return next;
}

function applyRequestParameterCapabilityStrategy(payload, options = {}) {
  return applyOmittedKeys(payload, listOmittedRequestParameterKeys(options));
}

function applyGenerationConfigCapabilityStrategy(generationConfig, options = {}) {
  return applyOmittedKeys(generationConfig, listOmittedGenerationConfigKeys(options));
}

module.exports = {
  MODEL_FAMILIES,
  PROVIDER_MODEL_CAPABILITY_RULES,
  applyGenerationConfigCapabilityStrategy,
  applyRequestParameterCapabilityStrategy,
  listAppliedGenerationConfigCapabilityRules,
  listAppliedRequestParameterCapabilityRules,
  listOmittedGenerationConfigKeys,
  listOmittedRequestParameterKeys,
  __private: {
    applyOmittedKeys,
    modelMatchesFamily,
    normalizeKey,
    normalizeModelTokens,
    ruleMatchesRequest,
    uniqueSortedKeys
  }
};
