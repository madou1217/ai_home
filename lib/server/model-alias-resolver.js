'use strict';

const {
  resolveAliasCandidates,
  resolveAliasUpstreamProvider
} = require('./model-alias-store');
const { isSupportedProvider } = require('./providers');

function readRequestModel(requestJson) {
  return requestJson && typeof requestJson.model === 'string'
    ? requestJson.model
    : '';
}

function createAliasResolution(model) {
  const requestedModel = String(model || '').trim();
  return {
    requestedModel,
    effectiveModel: requestedModel,
    aliasMatched: false,
    aliasId: '',
    aliasTarget: '',
    aliasScopeProvider: '',
    aliasTargetProvider: '',
    effectiveProvider: ''
  };
}

function resolveProtocolAliasBaseProvider(input = {}) {
  const clientProtocol = String(input.clientProtocol || '').trim();
  if (clientProtocol === 'anthropic_messages' || clientProtocol === 'anthropic_count_tokens') return 'claude';
  if (clientProtocol === 'gemini_generate_content' || clientProtocol === 'gemini_stream_generate_content') {
    return 'gemini';
  }

  if (typeof input.resolveRequestProvider === 'function') {
    return String(input.resolveRequestProvider(
      input.options || {},
      input.requestJson || {},
      input.headers || {},
      input.state || {}
    ) || '').trim() || 'codex';
  }

  return 'codex';
}

function resolveExplicitAliasTargetProvider(aliasResult) {
  if (!aliasResult || !isSupportedProvider(aliasResult.targetProvider)) return '';
  return resolveAliasUpstreamProvider(aliasResult);
}

function resolveModelAliasCandidates(input = {}) {
  const aliases = Array.isArray(input.aliases) ? input.aliases : [];
  const requestJson = input.requestJson && typeof input.requestJson === 'object'
    ? input.requestJson
    : {};
  const requestedModel = readRequestModel(requestJson);
  if (!requestedModel) {
    return { requestedModel: '', baseProvider: '', candidates: [] };
  }
  const baseProvider = resolveProtocolAliasBaseProvider(input);
  return {
    requestedModel,
    baseProvider,
    candidates: resolveAliasCandidates(aliases, requestedModel, baseProvider)
  };
}

function buildUnmatchedAliasContext(requestJson, requestedModel, baseProvider) {
  return {
    requestJson,
    changed: false,
    aliasResolution: createAliasResolution(requestedModel),
    aliasTargetProvider: '',
    preferModelRouting: false,
    baseProvider
  };
}

function applyAliasCandidate(input = {}) {
  const requestJson = input.requestJson && typeof input.requestJson === 'object'
    ? input.requestJson
    : {};
  const candidate = input.candidate;
  const requestedModel = readRequestModel(requestJson);
  if (!candidate) {
    return buildUnmatchedAliasContext(requestJson, requestedModel, String(input.baseProvider || ''));
  }

  const aliasTargetProvider = resolveExplicitAliasTargetProvider(candidate);
  const nextRequestJson = {
    ...requestJson,
    model: candidate.target
  };

  return {
    requestJson: nextRequestJson,
    changed: true,
    aliasTargetProvider,
    preferModelRouting: !aliasTargetProvider,
    baseProvider: String(input.baseProvider || ''),
    aliasResolution: {
      ...createAliasResolution(requestedModel),
      aliasMatched: true,
      aliasId: candidate.id,
      aliasTarget: candidate.target,
      aliasScopeProvider: candidate.provider,
      aliasTargetProvider: candidate.targetProvider,
      aliasPriority: Number(candidate.priority) || 0,
      effectiveModel: candidate.target,
      effectiveProvider: aliasTargetProvider
    }
  };
}

function resolveModelAliasRequest(input = {}) {
  const requestJson = input.requestJson && typeof input.requestJson === 'object'
    ? input.requestJson
    : {};
  const { requestedModel, baseProvider, candidates } = resolveModelAliasCandidates(input);
  if (!candidates.length) {
    return buildUnmatchedAliasContext(requestJson, requestedModel, baseProvider);
  }
  return applyAliasCandidate({ requestJson, candidate: candidates[0], baseProvider });
}

module.exports = {
  applyAliasCandidate,
  createAliasResolution,
  resolveModelAliasCandidates,
  resolveModelAliasRequest,
  resolveProtocolAliasBaseProvider,
  __private: {
    readRequestModel,
    resolveExplicitAliasTargetProvider
  }
};
