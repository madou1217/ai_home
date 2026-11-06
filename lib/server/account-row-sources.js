'use strict';

// 账号页行的**字段来源表**：切片 C（前门翻转）的唯一真值源。
//
// 为什么需要这张表：/v0/webui/accounts 的行有 39 个字段，来源分散在
//   * Go 的账号视图（/v1/management/accounts：provider/enabled/凭据/身份/额度快照）
//   * Go 物化、Node 直读的额度与 UI 状态（readGoQuotaStates / readGoUIStates）
//   * Node 运行池与 Provider 描述符（运行态、Token 用量、活动、开关能力）
// 三者混在一个 buildHydratedAccountRecord 里，翻转前没人说得清「哪一列其实已经是 Go 的」。
// 把来源写成数据后：
//   * 装配器（assembleAccountRow）只对 source=go 的字段用 Go 值覆盖，其余原样保留；
//   * 对拍器（diffAccountRow）只比 source=go 的字段，避免拿不同词汇的字段制造假警；
//   * 将来某个字段在 Go 侧补齐，只改这张表的一行，不用动装配逻辑。
//
// source 取值：
//   go            —— 直接取 Go 账号视图的值（Go 缺值时按 fallback 保留 Node 值）
//   go-projected  —— Go 计算、Node 已经通过直读库拿到（剩余额度/额度快照）
//   node          —— Node 独有事实，翻转后仍由覆盖层提供
//
// 注意两个**不能按字面映射**的字段（踩过）：
//   * authMode：Node 是 api-key/consumer/opencode-auth/oauth 四种展示词汇，Go 的
//     auth_kind 是 api_key/oauth/vertex_ai、auth_mode 是 ''/consumer/native_auth_json，
//     两套词表不是同一件事（opencode 在 Go 是 api_key，在 Node 却不是 apiKeyMode）。
//   * updatedAt：Node 是「状态/记录更新时间」，Go 的 updated_at 是账号行更新时间，
//     实测相差几分钟到十几分钟，不是同一口径。
// 这两个字段都归 Node，不要在后续「优化」时又接回 Go。

/** 账号页行的字段来源表（顺序与线上响应一致，便于人工比对）。
 *
 * 每个字段都带 reason：这不是注释，而是**判定结论**。新增字段时必须说明它为什么
 * 不能由 Go 提供，避免「看着像能迁」就来回翻烧。
 *   go-fact       Go 事实，值稳定（用户操作才变）
 *   go-computed   Go 计算、Node 渲染（值会随采集实时变化，见各条注释）
 *   node-*        Node 独有事实/能力/派生，逐类给出理由
 */
const ACCOUNT_ROW_FIELDS = Object.freeze([
  { field: 'provider', source: 'go', reason: 'go-fact', fromGo: (go) => normalizeProvider(go && (go.provider_id || go.provider)) },
  { field: 'accountRef', source: 'node', reason: 'row-key' },
  // Node 的 status 是账号启停（up/down），Go 用 enabled 表达同一件事。
  { field: 'status', source: 'go', reason: 'go-fact', fromGo: (go) => (go && typeof go.enabled === 'boolean' ? (go.enabled ? 'up' : 'down') : undefined) },
  { field: 'displayName', source: 'go', reason: 'go-fact', fromGo: (go) => nonEmpty(go && go.display_name) },
  { field: 'configured', source: 'go', reason: 'go-fact', fromGo: (go) => (go && typeof go.has_credential === 'boolean' ? go.has_credential : undefined) },
  { field: 'apiKeyMode', source: 'node', reason: 'credential-vocabulary' },
  { field: 'isDefault', source: 'go', reason: 'go-fact', fromGo: (go) => (go && typeof go.is_default === 'boolean' ? go.is_default : undefined) },
  { field: 'isMobile', source: 'node', reason: 'node-capability' },
  { field: 'remainingPct', source: 'go-projected', reason: 'go-computed' },
  { field: 'usageSnapshot', source: 'go-projected', reason: 'go-computed' },
  { field: 'upstreamErrorRules', source: 'node', reason: 'node-config' },
  { field: 'upstreamErrorGroupIds', source: 'node', reason: 'node-config' },
  { field: 'updatedAt', source: 'node', reason: 'node-state-time' },
  { field: 'planType', source: 'go', reason: 'go-fact', fromGo: (go) => nonEmpty(go && go.subscription_kind) },
  { field: 'email', source: 'go', reason: 'go-fact', fromGo: (go) => nonEmpty(go && go.email) },
  { field: 'displayNames', source: 'node', reason: 'node-derived-identity' },
  { field: 'tokenUsage', source: 'node', reason: 'node-usage' },
  { field: 'authMode', source: 'node', reason: 'credential-vocabulary' },
  { field: 'authPending', source: 'node', reason: 'node-oauth' },
  { field: 'authPendingStale', source: 'node', reason: 'node-oauth' },
  { field: 'authPendingAgeMs', source: 'node', reason: 'node-oauth' },
  { field: 'baseUrl', source: 'node', reason: 'credential-vocabulary' },
  { field: 'customUpstream', source: 'node', reason: 'node-capability' },
  { field: 'windowActivationSupported', source: 'node', reason: 'node-capability' },
  { field: 'aliasPoolParticipates', source: 'node', reason: 'node-capability' },
  { field: 'activityActions', source: 'node', reason: 'node-capability' },
  { field: 'gatewayTargetSupported', source: 'node', reason: 'node-capability' },
  // quotaStatus 保持 Node 渲染：Go 在持续采集，值会比 Node 缓存的行新（实测同一账号
  // 在两次影子对账里一个 exhausted 一个 pending）。装配若取实时值，响应就不再与线上
  // 行逐字段相等，零差异门禁会被正常采集抖动打红；数据本身仍来自 Go（go-projected）。
  { field: 'quotaStatus', source: 'go-projected', reason: 'go-computed' },
  { field: 'schedulableStatus', source: 'node', reason: 'node-derived-state' },
  { field: 'lastUsedAt', source: 'node', reason: 'node-runtime' },
  { field: 'runtimeStatus', source: 'node', reason: 'node-runtime' },
  { field: 'runtimeUntil', source: 'node', reason: 'node-runtime' },
  { field: 'runtimeReason', source: 'node', reason: 'node-runtime' },
  { field: 'schedulableReason', source: 'node', reason: 'node-derived-state' },
  { field: 'planName', source: 'node', reason: 'node-derived-identity' },
  { field: 'loginType', source: 'node', reason: 'node-derived-identity' },
  { field: 'zcodeRegion', source: 'node', reason: 'node-derived-identity' },
  // quotaReason 保持 Node 渲染：它是条件字段（无原因时 key 不存在），而 Node 的行是
  // 缓存构建的——Go 的同一列可能已经更新而 Node 缓存还没有，覆盖会给行凭空加一个 key，
  // 装配结果不再与线上行逐字段相等（真机 qoder 一行命中）。数据仍来自 Go，只是时机由 Node 决定。
  { field: 'quotaReason', source: 'go-projected', reason: 'go-computed' },
  { field: 'runtimeModels', source: 'node', reason: 'node-runtime' }
]);

function normalizeProvider(value) {
  const text = String(value || '').trim().toLowerCase();
  return text || undefined;
}

// nonEmpty 把「Go 还没写」与「Go 认为是空值」合并成同一个结论：不覆盖 Node。
// 空串/空白/null 都算缺值——Go 的 account_profiles 目前整张表是空的（见方案 §3.5）。
function nonEmpty(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return text ? text : undefined;
}

// Go 视图能判定的字段：装配与对拍都只认这一份，避免两边各写一套名单。
const GO_ASSEMBLED_FIELDS = Object.freeze(
  ACCOUNT_ROW_FIELDS.filter((entry) => entry.source === 'go')
);

function isVertexPlaceholder(goRow) {
  return String((goRow && goRow.auth_kind) || '').toLowerCase() === 'vertex_ai';
}

// assembleAccountRow 以**当前 Node 行为基线**，只用 Go 有值且语义等价的字段覆盖。
//
// 这样翻转前后的行形状完全一致：Node 独有字段与 go-projected 字段原样保留，
// 只有「Go 能判定、且两侧词汇相同」的字段改由 Go 说了算。
// Vertex 占位账号是既定例外：Go 刻意把它置为 enabled=false，页面仍按 Node 的 up 显示，
// 否则 Gemini 的 Vertex 入口会凭空变成「已停用」（同 account-shadow 的排除规则）。
function assembleAccountRow(nodeRow, goRow) {
  if (!nodeRow || typeof nodeRow !== 'object') return nodeRow;
  if (!goRow || typeof goRow !== 'object') return { ...nodeRow };
  const out = { ...nodeRow };
  for (const entry of GO_ASSEMBLED_FIELDS) {
    if (entry.field === 'status' && isVertexPlaceholder(goRow)) continue;
    const value = entry.fromGo(goRow);
    if (value === undefined) continue;
    out[entry.field] = value;
  }
  return out;
}

// diffAccountRow 只在两侧都给得出值时判定，输出 [{field, node, go}]。
//
// 不做「Go 缺值也算差异」：那不是漂移，是 Go 还没写（例如空的 account_profiles）。
// 这类情况由 countFallbacks 单独统计，避免对拍报告被已知缺口淹没。
function diffAccountRow(nodeRow, goRow) {
  const diffs = [];
  if (!nodeRow || !goRow) return diffs;
  for (const entry of GO_ASSEMBLED_FIELDS) {
    if (entry.field === 'status' && isVertexPlaceholder(goRow)) continue;
    const goValue = entry.fromGo(goRow);
    if (goValue === undefined) continue;
    const nodeValue = nodeRow[entry.field];
    if (nodeValue === undefined || nodeValue === null || nodeValue === '') continue;
    if (!sameScalar(entry.field, nodeValue, goValue)) {
      diffs.push({ field: entry.field, node: nodeValue, go: goValue });
    }
  }
  return diffs;
}

// countFallbacks 统计「Go 没写、沿用 Node」的字段，用于报告已知缺口而不是差异。
function countFallbacks(goRow) {
  const missing = [];
  if (!goRow) return missing;
  for (const entry of GO_ASSEMBLED_FIELDS) {
    if (entry.fromGo(goRow) === undefined) missing.push(entry.field);
  }
  return missing;
}

// diffProjectedRow 核对「Go 计算、Node 直读」的投影字段是否真的同一份。
//
// 这些字段不参与装配覆盖（Node 已经从库里读到了 Go 的结果），但**时效**必须一致：
// 额度快照如果一侧有、另一侧没有，或者 captured_at 差了一分钟以上，说明同步断了，
// 前门翻转后页面会显示过期额度。auth_mode 之类词汇不同的字段不在这里比。
function diffProjectedRow(nodeRow, goRow) {
  const diffs = [];
  if (!nodeRow || !goRow) return diffs;
  const nodeSnapshot = nodeRow.usageSnapshot && typeof nodeRow.usageSnapshot === 'object'
    ? nodeRow.usageSnapshot
    : null;
  const goSnapshot = goRow.usage_snapshot && typeof goRow.usage_snapshot === 'object'
    ? goRow.usage_snapshot
    : null;
  // 只比「两侧都有快照」的时效。只有一侧有快照不是漂移：
  //   * Node 的 usageSnapshot 是**按 Provider 有选择地内嵌**的（cline/qoder 等只给
  //     remainingPct/quotaStatus，不内嵌整份文档），Go 有行、Node 没有是展示口径；
  //   * Node 有、Go 没有说明 Node 还留着一份旧缓存（禁用账号的遗留），由
  //     countNodeOnlySnapshots 当告警统计，不影响翻转后的页面。
  if (!nodeSnapshot || !goSnapshot) return diffs;
  const lag = usageSnapshotLagMs(nodeRow, goRow);
  // 只有 **Node 比 Go 新** 才是漂移：说明 Node 还自己产出了一份 Go 不知道的快照。
  // Go 比 Node 新是正常的采集时延（实测 100–240s，Go 在持续采集、Node 的缓存等下一轮同步），
  // 翻转后页面会直接拿 Go 的值，反而更新；把它当差异会让门禁永远红。
  if (lag > 1000) {
    diffs.push({
      field: 'usageSnapshot.capturedAt',
      node: toMs(nodeSnapshot.capturedAt),
      go: toMs(goSnapshot.captured_at)
    });
  }
  return diffs;
}

// usageSnapshotLagMs 返回 Node 快照比 Go 快照新多少毫秒（负值 = Go 更新）。
// 两侧缺任一侧时返回 0（无法判定），调用方据此跳过。
function usageSnapshotLagMs(nodeRow, goRow) {
  const nodeSnapshot = nodeRow && nodeRow.usageSnapshot && typeof nodeRow.usageSnapshot === 'object'
    ? nodeRow.usageSnapshot
    : null;
  const goSnapshot = goRow && goRow.usage_snapshot && typeof goRow.usage_snapshot === 'object'
    ? goRow.usage_snapshot
    : null;
  if (!nodeSnapshot || !goSnapshot) return 0;
  const nodeCapturedAt = toMs(nodeSnapshot.capturedAt);
  const goCapturedAt = toMs(goSnapshot.captured_at);
  if (!nodeCapturedAt || !goCapturedAt) return 0;
  return nodeCapturedAt - goCapturedAt;
}

// countNodeOnlySnapshots 统计「Node 有额度快照、Go 没有」的账号。
//
// 这类账号翻转后页面仍显示 Node 的缓存（覆盖层保留），但那份缓存可能很旧
// （实测两个已禁用 agy 账号停在 13 天前）。作为告警暴露，不作为差异阻断。
function countNodeOnlySnapshots(nodeRow, goRow) {
  const nodeHas = nodeRow && nodeRow.usageSnapshot && typeof nodeRow.usageSnapshot === 'object';
  const goHas = goRow && goRow.usage_snapshot && typeof goRow.usage_snapshot === 'object';
  return Boolean(nodeHas) && !goHas;
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value || '').trim();
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sameScalar(field, nodeValue, goValue) {
  if (field === 'provider' || field === 'status') {
    return String(nodeValue).trim().toLowerCase() === String(goValue).trim().toLowerCase();
  }
  return nodeValue === goValue;
}

module.exports = {
  ACCOUNT_ROW_FIELDS,
  GO_ASSEMBLED_FIELDS,
  assembleAccountRow,
  diffAccountRow,
  diffProjectedRow,
  usageSnapshotLagMs,
  countNodeOnlySnapshots,
  countFallbacks
};
