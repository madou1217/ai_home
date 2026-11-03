'use strict';

/**
 * 规则落到**请求**上的唯一实现（网关侧）。
 *
 * 模型名在两种地方出现，规则两处都要覆盖：
 *   - 请求体 `model` 字段：OpenAI chat / responses、Anthropic messages 都是这种；
 *   - **URL 路径**：Gemini 原生是 `/v1beta/models/<model>:generateContent`，请求体里
 *     根本没有 model 字段。只改 body 的话，gemini 客户端永远不受规则影响。
 *
 * 抽成独立模块是为了让「网关到底改了哪一处」能被单测直接覆盖，不必启动整个路由。
 */

const { HEADER_NAME, applySessionModelAlias, sessionModelAliasMatches } = require('./session-model-alias');
const { extractGeminiModelFromPath, rewriteGeminiModelInPath } = require('./protocol-adapters');

/**
 * @returns {{changed: boolean, kind: 'body'|'path'|'', rule: object|null,
 *            requestJson: object, pathname: string}}
 */
function applySessionModelAliasToRequest(input = {}) {
  const rule = input.rule || null;
  const pathname = String(input.pathname || '');
  const applied = applySessionModelAlias({ rule, requestJson: input.requestJson });
  if (applied.changed) {
    return { changed: true, kind: 'body', rule, requestJson: applied.requestJson, pathname };
  }
  if (!rule) {
    return { changed: false, kind: '', rule: null, requestJson: input.requestJson, pathname };
  }
  const pathModel = extractGeminiModelFromPath(pathname);
  if (pathModel && sessionModelAliasMatches(rule, pathModel)) {
    const nextPath = rewriteGeminiModelInPath(pathname, rule.target);
    if (nextPath) {
      return { changed: true, kind: 'path', rule, requestJson: input.requestJson, pathname: nextPath };
    }
  }
  return { changed: false, kind: '', rule, requestJson: input.requestJson, pathname };
}

/** 去掉规则头（大小写都可能，Node 收进来是小写、relay 自拼的是原样大小写）。 */
function stripSessionModelAliasHeader(headers) {
  const source = headers && typeof headers === 'object' ? headers : {};
  const next = { ...source };
  for (const key of Object.keys(next)) {
    if (String(key).toLowerCase() === HEADER_NAME) delete next[key];
  }
  return next;
}

/**
 * 规则落到**路由状态**上的一步：请求体、路径、请求头、上游 body 一起给出新值。
 *
 * 抽出来是为了让「网关改完之后的四个状态到底是什么」可被直接断言——这段接线
 * 之前只能靠启动整个网关才能验证，等于没有回归保护。
 *
 * @returns {{changed: boolean, kind: 'body'|'path'|'', requestJson: object,
 *            pathname: string, headers: object, bodyBuffer: any}}
 */
function applySessionModelAliasToRequestState(input = {}) {
  const headers = input.headers && typeof input.headers === 'object' ? input.headers : {};
  const applied = applySessionModelAliasToRequest({
    rule: input.rule,
    requestJson: input.requestJson,
    pathname: input.pathname
  });
  const bodyBuffer = applied.kind === 'body'
    ? Buffer.from(JSON.stringify(applied.requestJson))
    : input.bodyBuffer;
  return {
    changed: applied.changed,
    kind: applied.kind,
    requestJson: applied.requestJson,
    pathname: applied.kind === 'path' ? applied.pathname : input.pathname,
    // 规则只属于本网关，绝不透传给上游：只要带了规则就摘头，命中与否都一样。
    headers: input.rule ? stripSessionModelAliasHeader(headers) : headers,
    bodyBuffer
  };
}

module.exports = {
  applySessionModelAliasToRequest,
  applySessionModelAliasToRequestState,
  stripSessionModelAliasHeader
};
