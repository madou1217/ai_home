'use strict';

// 账号额度 payload 归一 —— **条目/模型归一统一走额度视图模型**（lib/usage/quota/view.js）。
//
// 历史形态是一份 13 个 kind 的手写 switch：每个分支把 entries/models 再抄一遍字段映射，
// 条目字段一改要改 13 处，新增 provider 漏了分支会**静默变成空快照**（账号页把额度当成 0，
// 也就是「已耗尽」）。现在：
//   * 形态与条目结构由 provider 描述符 + 视图模型给出（label / category / 排序 / 单位）；
//   * 本文件只保留各家快照真正独有的 payload 字段（账号信息、套餐订阅、模型能力、重置次数），
//     且以**声明式字段表**表达，不再逐 kind 重复代码；
//   * kind 未在任何描述符里声明时返回 null（与历史一致：未知快照不进账号 payload）。

const { buildQuotaView, resolveEntryShapeByKind } = require('../usage/quota');

// 账号信息里按 kind 暴露的字符串 / 数字字段（新增字段 = 表里加一项）。
const ACCOUNT_STRING_FIELDS = {
  codex_oauth_status: ['planType', 'email', 'upstreamAccountId', 'organizationId'],
  claude_oauth_usage: ['email', 'fullName', 'planType'],
  grok_credit_usage: ['email', 'planType', 'planName'],
  kiro_credit_usage: ['email', 'planType', 'planName'],
  agy_code_assist_quota: ['planType', 'email', 'subscriptionTier', 'project'],
  kimi_oauth_usage: ['displayName', 'userId', 'phone', 'planType', 'planName'],
  zcode_plan_balance: ['planType'],
  codebuddy_credit_balance: ['planType'],
  cline_pass_usage: ['userId', 'planName']
};

// 账号信息里的数组字段（新增 = 表里加一项）。
const ACCOUNT_ARRAY_FIELDS = {
  // 多套餐时逐个给出套餐名；展示层据此渲染多个标签，不解析 `A + B` 拼接串。
  zcode_plan_balance: ['planNames']
};

const ACCOUNT_NUMBER_FIELDS = {
  codex_oauth_status: ['subscriptionActiveUntilMs', 'subscriptionLastCheckedMs', 'planConfirmedAtMs'],
  cline_pass_usage: ['periodStartMs', 'periodEndMs']
};

function toNullableNumber(value) {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function projectAccount(kind, account) {
  const source = account && typeof account === 'object' ? account : null;
  const strings = ACCOUNT_STRING_FIELDS[kind] || [];
  const numbers = ACCOUNT_NUMBER_FIELDS[kind] || [];
  if (!source || (strings.length === 0 && numbers.length === 0 && kind !== 'kimi_oauth_usage')) return null;
  const projected = {};
  for (const field of strings) projected[field] = String(source[field] || '');
  for (const field of numbers) projected[field] = Number(source[field]) || 0;
  // 数组型字段：**多套餐的名字列表**。白名单式投影不列出的字段会被丢弃，所以
  // 必须在这里显式带出（planGroups 曾因此「盘上有、WebUI 看不到」）。
  for (const field of ACCOUNT_ARRAY_FIELDS[kind] || []) {
    const value = Array.isArray(source[field]) ? source[field] : [];
    projected[field] = value.map((item) => String(item || '')).filter(Boolean);
  }
  // 套餐订阅（kimi 桌面端托管链）：账号列显示「套餐名 + 有效期至」。
  // 快照没有订阅信息时保持 null（历史 payload 形态，展示层据此判断「无订阅档」）。
  if (kind === 'kimi_oauth_usage') {
    projected.planSubscription = source.planSubscription && typeof source.planSubscription === 'object'
      ? {
          name: String(source.planSubscription.name || ''),
          status: String(source.planSubscription.status || ''),
          validUntilMs: Number(source.planSubscription.validUntilMs) || 0,
          resetAtMs: Number(source.planSubscription.resetAtMs) || 0
        }
      : null;
  }
  return projected;
}

/** entries 投影：形态、标签、旁路标记、单位都来自视图模型，展示层不需要知道 provider。 */
function projectEntries(view) {
  return view.scopes
    .filter((scope) => scope.shape !== 'models')
    .map((scope) => {
      const projected = {
        bucket: scope.bucket,
        label: scope.label,
        windowMinutes: scope.windowMinutes,
        window: scope.windowLabel,
        remainingPct: scope.remainingPct,
        resetIn: scope.resetIn,
        resetAtMs: scope.resetAtMs
      };
      // 只有快照真的带单位信息时才带单位字段（保持无单位 provider 的 payload 干净）。
      if (scope.totalUnits !== null || scope.usedUnits !== null || scope.remainingUnits !== null || scope.unitType) {
        projected.totalUnits = scope.totalUnits;
        projected.usedUnits = scope.usedUnits;
        projected.remainingUnits = scope.remainingUnits;
        projected.unitType = scope.unitType;
      }
      if (scope.category !== 'primary') projected.category = scope.category;
      return projected;
    });
}

/** models 投影：保留 provider 声明的模型能力字段（agy 的思考/图像/上下文），其余原样透传。 */
function projectModels(view, snapshot) {
  const rawModels = Array.isArray(snapshot.models) ? snapshot.models : [];
  return view.scopes
    .filter((scope) => scope.shape === 'models')
    .map((scope) => {
      const raw = rawModels.find((model) => String(model && model.model || '') === scope.model) || {};
      const projected = {
        model: scope.model,
        label: scope.label,
        remainingPct: scope.remainingPct,
        resetIn: scope.resetIn,
        resetAtMs: scope.resetAtMs
      };
      if (scope.displayName) projected.displayName = scope.displayName;
      if (raw.supportsThinking !== undefined) projected.supportsThinking = Boolean(raw.supportsThinking);
      if (raw.supportsImages !== undefined) projected.supportsImages = Boolean(raw.supportsImages);
      if (raw.maxTokens !== undefined) projected.maxTokens = toNullableNumber(raw.maxTokens);
      if (raw.maxOutputTokens !== undefined) projected.maxOutputTokens = toNullableNumber(raw.maxOutputTokens);
      return projected;
    });
}

function normalizeAccountUsageSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const kind = String(snapshot.kind || '');
  // 未声明 kind（不在任何 provider 描述符里）不进账号 payload —— 与历史行为一致。
  const entryShape = resolveEntryShapeByKind(kind);
  if (!entryShape) return null;

  const view = buildQuotaView(snapshot, { entryShape });
  const payload = {
    kind,
    capturedAt: Number(snapshot.capturedAt) || 0,
    entryShape
  };

  if (kind === 'codex_oauth_status' && String(snapshot.fallbackSource || '')) {
    payload.fallbackSource = String(snapshot.fallbackSource);
  }
  // Codex 重置次数（rateLimitResetCredits）：账号列展示「可用重置次数」。
  if (kind === 'codex_oauth_status') {
    const availableCount = Number(snapshot.rateLimitResetCredits && snapshot.rateLimitResetCredits.availableCount);
    if (Number.isInteger(availableCount) && availableCount >= 0) payload.resetCreditsAvailableCount = availableCount;
  }
  // AGY 的模型转发规则是账号级配置，原样透传。
  if (kind === 'agy_code_assist_quota') {
    payload.modelForwardingRules = snapshot.modelForwardingRules && typeof snapshot.modelForwardingRules === 'object'
      ? { ...snapshot.modelForwardingRules }
      : {};
  }

  const account = projectAccount(kind, snapshot.account);
  // 声明了账号字段的 kind 一定带 account 键（可能为 null，与历史 payload 一致）；
  // 完全不需要账号信息的 kind（如 gemini）不带这个键。
  const declaresAccount = Boolean(ACCOUNT_STRING_FIELDS[kind] || ACCOUNT_NUMBER_FIELDS[kind] || kind === 'kimi_oauth_usage');
  if (declaresAccount) payload.account = account;

  if (view.shape === 'models') {
    payload.models = projectModels(view, snapshot);
  } else {
    payload.entries = projectEntries(view);
  }
  // 套餐分组：同账号多个套餐（例如基础套餐 + 领到的试用套餐）各自成组。
  // 本函数是**白名单式** payload 构造，未列入的字段会被丢弃（planGroups 曾因此在
  // 盘上存在但 WebUI 看不到）。新增展示字段必须在这里显式带出。
  if (Array.isArray(snapshot.planGroups) && snapshot.planGroups.length > 0) {
    payload.planGroups = snapshot.planGroups.map((group) => ({
      planGroupId: String(group && group.planGroupId || ''),
      planId: String(group && group.planId || ''),
      name: String(group && group.name || ''),
      status: String(group && group.status || ''),
      endsAtMs: Number(group && group.endsAtMs) || 0,
      priority: Number(group && group.priority) || 0,
      // 组内条目用同一个 view 构造器投影，字段与顶层 entries 一致。
      entries: projectEntries(buildQuotaView(
        { ...snapshot, entries: (group && group.entries) || [] },
        { entryShape }
      ))
    }));
  }
  return payload;
}

module.exports = {
  normalizeAccountUsageSnapshot
};
