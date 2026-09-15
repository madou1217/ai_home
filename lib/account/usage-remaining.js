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
  zcode: 'zcode_plan_balance',
  // CodeBuddy 家族四支共用**同一个 kind**：同地区 work/code 是同一个账号、同一个
  // 余额接口、同一种快照形状（见 lib/account/codebuddy-billing.js），按 provider 拆
  // 四个 kind 只会让 snapshot.kind 的分支翻四倍，没有任何语义差别。
  codebuddy: 'codebuddy_credit_balance',
  codebuddycn: 'codebuddy_credit_balance',
  workbuddy: 'codebuddy_credit_balance',
  workbuddycn: 'codebuddy_credit_balance'
});

// 时间窗型快照（entries[]: { remainingPct, ... }）
const ENTRY_WINDOW_KINDS = new Set([
  USAGE_SNAPSHOT_KINDS.codex,
  USAGE_SNAPSHOT_KINDS.claude,
  USAGE_SNAPSHOT_KINDS.kimi,
  USAGE_SNAPSHOT_KINDS.zcode,
  USAGE_SNAPSHOT_KINDS.codebuddy
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
      // category='gift'（kimi 赠送额度）只是旁路信息：Gift 用尽不代表账号不可用，
      // 不能拖低账号级 min(remainingPct)，否则调度会把健康账号误判成额度耗尽。
      // category='detail'（CodeBuddy 家族的每包明细）同理：家族发一条 sum 聚合条目作
      // 为账号级权威值，每包再各发一条明细供展示；明细用尽的赠送包不代表账号不可用。
      .filter((entry) => entry && entry.category !== 'gift' && entry.category !== 'detail')
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

// CodeBuddy 家族配额快照的 source 标识：同上，accounts.js / usage/cache.js 的 trusted
// 校验与 codebuddy-quota-probe.js 的产出必须引用同一常量。
const USAGE_SOURCE_CODEBUDDY = 'codebuddy_billing_resource_summary_api';

module.exports = {
  USAGE_SNAPSHOT_KINDS,
  USAGE_SOURCE_KIMI,
  USAGE_SOURCE_ZCODE,
  USAGE_SOURCE_CODEBUDDY,
  getUsageRemainingPctValues,
  getMinRemainingPctFromUsageSnapshot
};
