'use strict';

// 账号结果桶的失败词表：Node 的 policy kind → Go 的 FailureKind 闭集。
//
// 唯一事实源是 Go 的 core/accountruntime/policy.go（FailureKind 常量 + PolicyFor 闭集校验）；
// 本文件只是它在 Node 侧的镜像与翻译表，不新增任何分类。
//
// 为什么需要翻译：结果桶（GET /v0/webui/account-outcomes）是「Go 承接的计数」与「Node 承接的
// 计数」两路合并的视图（见 account-outcomes-view.js）。Go 只会写闭集里的名字，Node 此前把
// policy.kind 原样写进桶，于是同一个上游事件在同一个桶里出现两种名字（Go 的 model_overloaded
// vs Node 的 overloaded），前端也只能回落成原始 slug 展示。这里在记账边界上归一。
//
// 新增 policy kind 时必须在这里加一行：test/account-outcome-kinds.test.js 会扫描
// upstream-failure-policy.js / upstream-edge-block.js 的 kind 字面量，漏映射直接红。

/** Go FailureKind 闭集（与 core/accountruntime/policy.go 逐项对应，测试守卫一致）。 */
const FAILURE_KINDS = Object.freeze([
  'rate_limited',
  'model_overloaded',
  'upstream_unavailable',
  'request_timeout',
  'connection_reset',
  'stream_disconnected',
  'credential_rejected',
  'static_credential_rejected',
  'reauthentication_required',
  'quota_exhausted',
  'billing_blocked',
  'workspace_deactivated',
  'model_unsupported',
  'region_unsupported',
  'permission_denied',
  'upstream_edge_rejected',
  'invalid_request',
  'not_found',
  'safety_rejected',
  'malformed_response',
  'request_cancelled',
  'unclassified'
]);

const FAILURE_KIND_SET = new Set(FAILURE_KINDS);

/**
 * Node policy kind → Go FailureKind。按语义对齐，不按名字硬套；已经是闭集成员的标签
 * （safety_rejected / not_found / invalid_request / unclassified 等）不需要出现在表里。
 */
const POLICY_KIND_TO_FAILURE_KIND = Object.freeze({
  // 瞬态：容量 / 限流 / 上游不可用 / 超时 / 断连
  rate_limited: 'rate_limited',
  overloaded: 'model_overloaded',
  model_capacity_unavailable: 'model_overloaded',
  upstream_server_error: 'upstream_unavailable',
  service_unavailable: 'upstream_unavailable',
  timeout: 'request_timeout',
  network_error: 'connection_reset',
  // 凭据 / 计费 / 权限 / 地区 / 模型可用性
  auth_invalid: 'credential_rejected',
  payment_required: 'billing_blocked',
  model_entitlement_required: 'permission_denied',
  account_tier_model_denied: 'permission_denied',
  model_not_available_on_endpoint: 'model_unsupported',
  model_quota_exhausted: 'quota_exhausted',
  account_usage_exhausted: 'quota_exhausted',
  // zcode 1113（没有可用资源包）：账号级不可用，归配额耗尽族
  account_no_resource_package: 'quota_exhausted',
  // zcode 3012（账号被上游风控拦截）：账号级受限，与凭据无关（见 zcode-business-error）
  account_restricted_by_upstream: 'permission_denied',
  location_unsupported: 'region_unsupported',
  model_region_restricted: 'region_unsupported',
  // 响应无法按目标协议解释 / 证据不足
  empty_model_response: 'malformed_response',
  unknown_status: 'unclassified',
  unknown_error: 'unclassified',
  // 请求级：Go 对 400/404 同样只归 invalid_request / not_found，且不改账号运行态
  context_length_exceeded: 'invalid_request',
  item_not_persisted_or_encrypted_incompatible: 'invalid_request',
  // 出口协议不被原生客户端支持（Bun 只认 HTTP(S) 代理）：请求交付不出去，与账号无关
  proxy_protocol_unsupported: 'invalid_request',
  // 站点边缘（WAF/CDN/网关）按请求格式回绝：与账号凭据无关（见 upstream-edge-block.js）
  upstream_edge_blocked: 'upstream_edge_rejected',
  upstream_edge_format_rejected: 'upstream_edge_rejected'
});

/**
 * 已归一化的标签 → 闭集成员。闭集成员（含 'success'）原样返回；表里有的按表翻译；
 * 其余未知标签原样返回（不猜、不丢，前端回落成原文展示）。
 */
function toFailureKind(label) {
  const text = String(label == null ? '' : label).trim();
  if (!text) return '';
  if (text === 'success' || FAILURE_KIND_SET.has(text)) return text;
  return POLICY_KIND_TO_FAILURE_KIND[text] || text;
}

function isFailureKind(label) {
  return FAILURE_KIND_SET.has(String(label == null ? '' : label).trim());
}

module.exports = {
  FAILURE_KINDS,
  POLICY_KIND_TO_FAILURE_KIND,
  isFailureKind,
  toFailureKind
};
