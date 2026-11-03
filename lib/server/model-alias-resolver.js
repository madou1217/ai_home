'use strict';

const {
  resolveAliasCandidates,
  resolveAliasUpstreamProvider
} = require('./model-alias-store');
const { isSupportedProvider } = require('./providers');
const { normalizePathname } = require('./protocol-registry');
const { extractGeminiModelFromPath, rewriteGeminiModelInPath } = require('./protocol-adapters');

/**
 * 本次请求的「客户端写的模型名」。
 *
 * 模型名在两种地方出现：OpenAI chat / responses / Anthropic 在请求体 `model` 字段，
 * **Gemini 原生在 URL 路径里**（`/v1beta/models/<model>:generateContent`），请求体
 * 根本没有 model 字段。只读 body 的话，Gemini 客户端永远不会命中别名表 —— 实测
 * （2026-11-01）：给 `gemini-3.8-flash` 配了别名，`aih gemini` 仍按原模型打到上游
 * 拿 11158，日志里 `effectiveModel` 与 `requestedModel` 一字不差。
 *
 * 与会话级 `--model-alias` 同一套判据（见 session-model-alias-request），两条通道
 * 对同一个模型名必须给出同一个解释。
 *
 * 路径先过 `normalizePathname`：Vertex 形态
 * （`/v1beta1/publishers/google/models/<model>:streamGenerateContent`）与标准形态是同一个
 * 请求，只在规范化之后才认得出模型（gemini CLI 的 vertex-ai 模式实测就走这条）。
 */
function readRequestModel(requestJson, pathname = '') {
  const fromBody = requestJson && typeof requestJson.model === 'string'
    ? requestJson.model
    : '';
  if (String(fromBody || '').trim()) return fromBody;
  return extractGeminiModelFromPath(normalizePathname(pathname));
}

/**
 * 别名命中后，把「本次请求意味着哪个模型」同步到 URL 路径上。
 *
 * Gemini 原生把模型名只写在路径里，协议转换（protocol-gemini-request-adapters 的
 * convertGeminiGenerateContentTo*）也是从 pathname 取模型。只改请求体的 `model` 时，
 * 别名会在转换那一步被路径上的原名覆盖回去 —— 实测（2026-11-01）：别名命中、路由也选了
 * 目标的 provider，但上游收到的仍是客户端写的原名，一直撞 11158。
 *
 * 路径名不是 Gemini generateContent 形态时 rewriteGeminiModelInPath 返回空串，原样返回。
 */
function applyAliasPathname(pathname, aliasResolution) {
  if (!aliasResolution || !aliasResolution.aliasMatched) return pathname;
  return rewriteGeminiModelInPath(pathname, aliasResolution.effectiveModel) || pathname;
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
  const requestedModel = readRequestModel(requestJson, input.pathname);
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
  const requestedModel = readRequestModel(requestJson, input.pathname);
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
  return applyAliasCandidate({
    requestJson,
    candidate: candidates[0],
    baseProvider,
    pathname: input.pathname
  });
}

module.exports = {
  applyAliasCandidate,
  applyAliasPathname,
  createAliasResolution,
  resolveModelAliasCandidates,
  resolveModelAliasRequest,
  resolveProtocolAliasBaseProvider,
  __private: {
    readRequestModel,
    resolveExplicitAliasTargetProvider
  }
};
