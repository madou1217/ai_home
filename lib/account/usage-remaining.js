'use strict';

// 配额快照（Remaining）的单一事实来源：kind 注册表 + remainingPct 提取。
// 背景：此前 codex/claude/gemini/agy 各自的 kind 白名单和提取逻辑散落在
// derived-state.js / usage/account-runtime.js / usage/snapshot.js / account-usage-view.js
// 四处，新增 provider 要同步改一串文件，漏一处就表现为 Remaining 恒为 Unknown。
//
// 新 provider 集成配额只需两步：
//   1) 在 USAGE_SNAPSHOT_KINDS 登记 provider -> kind；
//   2) 快照用 entries[]（时间窗型）或 models[]（按模型型）承载 remainingPct，
//      下方提取、CLI/WebUI 展示、陈旧缓存丢弃逻辑全部自动生效。

const USAGE_SNAPSHOT_KINDS = Object.freeze({
  codex: 'codex_oauth_status',
  claude: 'claude_oauth_usage',
  gemini: 'gemini_oauth_stats',
  agy: 'agy_code_assist_quota',
  kimi: 'kimi_oauth_usage',
  zcode: 'zcode_plan_balance'
});

// 时间窗型快照（entries[]: { remainingPct, ... }）
const ENTRY_WINDOW_KINDS = new Set([
  USAGE_SNAPSHOT_KINDS.codex,
  USAGE_SNAPSHOT_KINDS.claude,
  USAGE_SNAPSHOT_KINDS.kimi,
  USAGE_SNAPSHOT_KINDS.zcode
]);

// 按模型型快照（models[]: { remainingPct, ... }）
const MODEL_LIST_KINDS = new Set([
  USAGE_SNAPSHOT_KINDS.gemini,
  USAGE_SNAPSHOT_KINDS.agy
]);

function readOptionalNumber(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getUsageRemainingPctValues(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  if (ENTRY_WINDOW_KINDS.has(snapshot.kind) && Array.isArray(snapshot.entries)) {
    return snapshot.entries
      .map((entry) => readOptionalNumber(entry && entry.remainingPct))
      .filter((value) => Number.isFinite(value));
  }
  if (MODEL_LIST_KINDS.has(snapshot.kind) && Array.isArray(snapshot.models)) {
    return snapshot.models
      .map((model) => readOptionalNumber(model && model.remainingPct))
      .filter((value) => Number.isFinite(value));
  }
  return [];
}

function getMinRemainingPctFromUsageSnapshot(snapshot) {
  const values = getUsageRemainingPctValues(snapshot);
  if (values.length === 0) return null;
  return Math.max(0, Math.min(100, Math.min(...values)));
}

// kimi 配额快照的 source 标识：accounts.js 的 trusted 校验与 kimi-quota-probe.js 的
// 产出必须引用同一常量，避免两处字面量漂移导致快照被判不受信而静默丢弃。
const USAGE_SOURCE_KIMI = 'kimi_oauth_usages_api';

// zcode 配额快照的 source 标识：accounts.js 与 usage/cache.js 的 trusted 校验、
// zcode-quota-probe.js 的产出必须引用同一常量，理由同上。
const USAGE_SOURCE_ZCODE = 'zcode_plan_billing_balance_api';

module.exports = {
  USAGE_SNAPSHOT_KINDS,
  USAGE_SOURCE_KIMI,
  USAGE_SOURCE_ZCODE,
  getUsageRemainingPctValues,
  getMinRemainingPctFromUsageSnapshot
};
