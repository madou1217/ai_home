'use strict';

// 额度视图模型 —— **把各家形态不同的快照归一成同一组 scope**，CLI（`aih <p> ls` / `usage` /
// PTY 标题）与 WebUI（账号列表 / 详情）都渲染这一份，不再各自按 kind 写分支。
//
// 事实来源仍是 provider 描述符：条目形态由 `quota.entryShape` 声明
// （window = 滚动时间窗，bucket = 余额/积分桶，models = 每模型额度），本文件
// **不持有任何 provider 名单**，只按形态做通用归一。
//
// 归一规则（与额度派生层口径一致，见 lib/account/usage-remaining.js）：
//   * category='gift'（赠送包）与 'detail'（每包明细）是旁路信息，**不参与账号级 min 剩余**，
//     渲染时排在主额度之后并带标签 —— 否则赠送包用尽会把健康账号显示成「已耗尽」。
//   * 只有带有限数值 remainingPct 的条目才计入 min；没有数值的条目照样列出来
//     （`usage` 详情是诊断面，上下文比数字重要）。
//   * 形态声明与快照结构不匹配时不静默返回空：`unrenderable` 带原因，调用方与测试都能看见。

const { getProviderCapability, listProviders } = require('../../providers');

const SCOPE_CATEGORY_PRIMARY = 'primary';
const SCOPE_CATEGORY_GIFT = 'gift';
const SCOPE_CATEGORY_DETAIL = 'detail';

// 形态 → 快照里承载条目的字段。
const SHAPE_ENTRY_FIELD = {
  window: 'entries',
  bucket: 'entries',
  models: 'models'
};

const BUCKET_LABELS = {
  credits: 'Credits',
  credit: 'Credits',
  balance: 'Balance',
  monthly: 'Monthly',
  monthly_quota: 'Monthly',
  five_hour: '5h',
  five_hour_window: '5h',
  seven_day: '7days',
  seven_day_window: '7days',
  daily: 'Daily',
  weekly: 'Weekly',
  gift: 'Gift'
};

function normalizeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function clampPct(value) {
  const numeric = normalizeNumber(value);
  if (numeric === null) return null;
  return Math.max(0, Math.min(100, numeric));
}

/** `rolling_300m` / `five_hour` / `credits` 这类内部桶名 → 人读标签。 */
function humanizeBucketLabel(bucket) {
  const raw = String(bucket || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (BUCKET_LABELS[lower]) return BUCKET_LABELS[lower];
  const rolling = /^rolling_(\d+)m$/.exec(lower);
  if (rolling) {
    const minutes = Number(rolling[1]);
    if (minutes > 0 && minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  }
  // 'gift:Invite to Earn Credit' 之类的复合桶名只取可读部分。
  const prefixed = /^(gift|detail):(.+)$/.exec(raw);
  if (prefixed) return prefixed[2].trim();
  return raw;
}

/** 分钟数 → 标签（条目没给 window/bucket 时的兜底）。 */
function labelFromWindowMinutes(windowMinutes) {
  const minutes = normalizeNumber(windowMinutes);
  if (minutes === null || minutes <= 0) return '';
  if (minutes % 1440 === 0) return `${minutes / 1440}days`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function resolveScopeCategory(entry) {
  const category = String(entry && entry.category || '').trim().toLowerCase();
  if (category === SCOPE_CATEGORY_GIFT) return SCOPE_CATEGORY_GIFT;
  if (category === SCOPE_CATEGORY_DETAIL) return SCOPE_CATEGORY_DETAIL;
  return SCOPE_CATEGORY_PRIMARY;
}

// 「通用桶名」= 只描述额度种类、不携带身份（模型名 / 套餐名 / 赠送包名）的桶。
// 通用桶显示窗口标签（7days / 5h），具名桶显示自己的名字。
const GENERIC_BUCKET_PATTERN = /^(credits?|balance|monthly|monthly_quota|daily|weekly|gift|five_hour(_window)?|seven_day(_window)?|rolling_\d+m)$/;

function resolveScopeLabel(entry, shape) {
  if (shape === 'models') {
    return String(entry && (entry.model || entry.displayName) || '').trim();
  }
  // 窗口标签：provider 可能给 `5h`（人读），也可能给 `300m`/`10080m`（原始分钟数，
  // 见 grok 探针）——后者归一成人读形式，否则列表里会出现 "10080m: 100.0%"。
  const rawWindowLabel = String(entry && entry.window || '').trim();
  const windowLabel = /^(\d+)m$/.test(rawWindowLabel)
    ? (labelFromWindowMinutes(Number(rawWindowLabel.slice(0, -1))) || rawWindowLabel)
    : rawWindowLabel;
  const rawBucket = String(entry && entry.bucket || '').trim();
  const bucketLabel = humanizeBucketLabel(rawBucket);
  const genericBucket = !rawBucket || GENERIC_BUCKET_PATTERN.test(rawBucket.toLowerCase());
  if (!genericBucket) {
    // 具名桶：bucket 形态带窗口时保留两者（zcode 的每模型余额桶 = 模型名 + 1days），
    // 窗口形态直接用桶名（kimi 赠送包 "Invite to Earn Credit"，不再被压成 "gift"）。
    return shape === 'bucket' && windowLabel ? `${bucketLabel} ${windowLabel}` : bucketLabel;
  }
  if (windowLabel) return windowLabel;
  if (bucketLabel) return bucketLabel;
  return labelFromWindowMinutes(entry && entry.windowMinutes) || 'Balance';
}

function normalizeScope(entry, shape, index) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const label = resolveScopeLabel(source, shape);
  const windowMinutes = normalizeNumber(source.windowMinutes) || 0;
  const bucket = String(source.bucket || '').trim();
  const model = String(source.model || '').trim();
  const identity = shape === 'models' ? (model || label) : (bucket || label);
  return Object.freeze({
    id: `${shape}:${identity || index}`,
    index,
    shape,
    label,
    bucket,
    group: String(source.group || source.groupLabel || '').trim(),
    category: resolveScopeCategory(source),
    remainingPct: clampPct(source.remainingPct),
    windowMinutes,
    windowLabel: String(source.window || '').trim(),
    resetIn: String(source.resetIn || '').trim(),
    resetAtMs: normalizeNumber(source.resetAtMs) || 0,
    totalUnits: normalizeNumber(source.totalUnits),
    usedUnits: normalizeNumber(source.usedUnits),
    remainingUnits: normalizeNumber(source.remainingUnits),
    unitType: String(source.unitType || '').trim(),
    model,
    displayName: String(source.displayName || '').trim()
  });
}

/** 形态解析：显式入参 → 描述符声明 → 快照 kind 反查 → 由快照结构推断。 */
function resolveEntryShape(snapshot, options = {}) {
  if (options.entryShape) return String(options.entryShape).trim();
  const provider = String(options.provider || '').trim().toLowerCase();
  if (provider) {
    const capability = getProviderCapability(provider, 'quota', options);
    const declared = capability && capability.entryShape;
    if (declared) return String(declared).trim();
  }
  // 调用方只拿到快照（CLI 展示层 / 服务端 payload / WebUI）时按 kind 反查描述符：
  // 展示层因此不需要维护第二份 kind 名单。
  const byKind = resolveEntryShapeByKind(snapshot && snapshot.kind, options);
  if (byKind) return byKind;
  if (Array.isArray(snapshot && snapshot.models)) return 'models';
  if (Array.isArray(snapshot && snapshot.entries)) return 'bucket';
  return 'account';
}

let kindShapeIndexCache = null;

/** kind → entryShape 反查索引（由描述符构建，含缓存）。 */
function getKindShapeIndex(options = {}) {
  if (kindShapeIndexCache) return kindShapeIndexCache;
  const index = new Map();
  for (const provider of listProviders('quota', options)) {
    const capability = getProviderCapability(provider, 'quota', options);
    if (!capability || capability.supported !== true) continue;
    if (!capability.kind || !capability.entryShape) continue;
    index.set(String(capability.kind), String(capability.entryShape));
  }
  kindShapeIndexCache = index;
  return index;
}

function resolveEntryShapeByKind(kind, options = {}) {
  const key = String(kind || '').trim();
  if (!key) return '';
  return getKindShapeIndex(options).get(key) || '';
}

function resetKindShapeIndexCache() {
  kindShapeIndexCache = null;
}


/**
 * 把一份额度快照归一成视图模型。
 *
 * @returns {{
 *   kind: string, capturedAt: number, shape: string, account: object|null,
 *   scopes: Array<object>, primaryScopes: Array<object>, secondaryScopes: Array<object>,
 *   minRemainingPct: number|null, minScope: object|null, unrenderable: string
 * }}
 */
function buildQuotaView(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    return {
      kind: '',
      capturedAt: 0,
      shape: '',
      account: null,
      scopes: [],
      primaryScopes: [],
      secondaryScopes: [],
      minRemainingPct: null,
      minScope: null,
      unrenderable: 'snapshot_missing'
    };
  }

  const shape = resolveEntryShape(snapshot, options);
  const entryField = SHAPE_ENTRY_FIELD[shape] || null;
  const entries = entryField ? snapshot[entryField] : [];
  const scopeShape = shape === 'models' ? 'models' : shape;
  const scopes = [];
  let unrenderable = '';

  if (entryField && !Array.isArray(entries)) {
    unrenderable = `entry_shape_${shape}_without_${entryField}`;
  } else if (Array.isArray(entries)) {
    entries.forEach((entry, index) => {
      const scope = normalizeScope(entry, scopeShape, index);
      if (!scope.label) return;
      scopes.push(scope);
    });
  }

  // 顶层 remainingPct（无条目快照，或条目里没有可用数值时的账号级兜底）。
  const topLevelPct = clampPct(snapshot.remainingPct);
  if (scopes.length === 0 && topLevelPct !== null) {
    scopes.push(Object.freeze({
      id: 'account:balance',
      index: 0,
      shape: 'account',
      label: 'Balance',
      bucket: '',
      group: '',
      category: SCOPE_CATEGORY_PRIMARY,
      remainingPct: topLevelPct,
      windowMinutes: 0,
      resetIn: '',
      resetAtMs: 0,
      totalUnits: null,
      usedUnits: null,
      remainingUnits: null,
      unitType: '',
      model: '',
      displayName: ''
    }));
  }

  if (scopes.length === 0 && !unrenderable) unrenderable = `no_renderable_scope:${snapshot.kind || 'unknown'}`;

  // 排序：主额度按窗口长度升序（5h 在 7days 前），同长度保持声明顺序；模型按最紧的排前；
  // gift/detail 永远排在主额度之后（它们是旁路信息）。
  const categoryRank = (scope) => (scope.category === SCOPE_CATEGORY_PRIMARY ? 0 : 1);
  const ordered = scopes.slice().sort((left, right) => {
    const byCategory = categoryRank(left) - categoryRank(right);
    if (byCategory !== 0) return byCategory;
    if (left.category === SCOPE_CATEGORY_PRIMARY && right.category === SCOPE_CATEGORY_PRIMARY) {
      // windowMinutes=0 表示「没有声明窗口长度」（如 kimi 的月度总量），排序时视作最长，
      // 排在有明确窗口的条目之后，避免 Monthly 跑到 5h 前面。
      const windowKey = (scope) => (scope.windowMinutes > 0 ? scope.windowMinutes : Number.POSITIVE_INFINITY);
      const byWindow = windowKey(left) - windowKey(right);
      // 两个都是 Infinity 时差值是 NaN —— 必须当「相等」处理，否则比较器返回 NaN，
      // 后续的「最紧模型排前」判定会被跳过（排序结果不可预期）。
      if (Number.isFinite(byWindow) && byWindow !== 0) return byWindow;
      if (left.shape === 'models' && right.shape === 'models') {
        const leftPct = left.remainingPct === null ? Number.POSITIVE_INFINITY : left.remainingPct;
        const rightPct = right.remainingPct === null ? Number.POSITIVE_INFINITY : right.remainingPct;
        if (leftPct !== rightPct) return leftPct - rightPct;
      }
    }
    return left.index - right.index;
  });

  const primaryScopes = ordered.filter((scope) => scope.category === SCOPE_CATEGORY_PRIMARY);
  const secondaryScopes = ordered.filter((scope) => scope.category !== SCOPE_CATEGORY_PRIMARY);
  const numericPrimary = primaryScopes.filter((scope) => scope.remainingPct !== null);
  const minScope = numericPrimary.length > 0
    ? numericPrimary.reduce((lowest, scope) => (scope.remainingPct < lowest.remainingPct ? scope : lowest))
    : null;

  return {
    kind: String(snapshot.kind || ''),
    capturedAt: normalizeNumber(snapshot.capturedAt) || 0,
    shape,
    account: snapshot.account && typeof snapshot.account === 'object' ? snapshot.account : null,
    scopes: ordered,
    primaryScopes,
    secondaryScopes,
    minRemainingPct: minScope ? minScope.remainingPct : null,
    minScope,
    unrenderable
  };
}

function formatPct(scope, options = {}) {
  if (scope.remainingPct === null) return '';
  return options.compact
    ? `${Math.round(scope.remainingPct)}%`
    : `${scope.remainingPct.toFixed(1)}%`;
}

/** 单条 scope 的行内片段：`5h: 91.0%` / `Credits: 90.7%`。 */
function formatScopeInline(scope, options = {}) {
  if (!scope) return '';
  const pct = formatPct(scope, options);
  if (!pct) return scope.label;
  if (options.compact) return `${scope.label}:${pct}`;
  return `${scope.label}: ${pct}`;
}


/**
 * 一行行内摘要（`ls` / PTY 标题 / WebUI 列表）：
 *   compact（标题）：`5h:91% 7days:52%`
 *   default（ls）：  `5h: 91.0% / 7days: 52.0%`
 * 只渲染主额度；gift/detail 是旁路信息，交给详情面。
 */
function formatQuotaViewInline(view, options = {}) {
  const scopes = (view && view.primaryScopes) || [];
  const parts = scopes.map((scope) => formatScopeInline(scope, options)).filter(Boolean);
  if (!parts.length) return '';
  return parts.join(options.compact ? ' ' : ' / ');
}

/** 单位明细：`$12.50 / $40.00`、`450 / 500 credits`。 */
function formatUnits(scope) {
  if (!scope) return '';
  const { remainingUnits, totalUnits, unitType } = scope;
  if (remainingUnits === null && totalUnits === null) return '';
  const symbol = unitType === 'usd' ? '$' : '';
  const suffix = unitType && unitType !== 'usd' ? ` ${unitType}` : '';
  const render = (value) => (value === null ? '?' : `${symbol}${Number(value).toFixed(2)}`);
  if (remainingUnits !== null && totalUnits !== null) return `${render(remainingUnits)} / ${render(totalUnits)}${suffix}`;
  return `${render(remainingUnits !== null ? remainingUnits : totalUnits)}${suffix}`;
}

/**
 * 逐条明细行（`aih <p> usage` / WebUI 详情）：
 *   `5h: 91.0% (resets in 4h)`、`Monthly: 83.0%`、`Invite to Earn Credit: 40.0% [gift]`
 * 没有数值的条目也会列出（只给标签），诊断面保留上下文。
 */
function formatQuotaViewLines(view, options = {}) {
  const scopes = (view && view.scopes) || [];
  const includeSecondary = options.includeSecondary !== false;
  return scopes
    .filter((scope) => includeSecondary || scope.category === SCOPE_CATEGORY_PRIMARY)
    .map((scope) => {
      const pct = formatPct(scope, options);
      const reset = scope.resetIn ? ` (resets in ${scope.resetIn})` : '';
      const units = formatUnits(scope);
      const tag = scope.category === SCOPE_CATEGORY_PRIMARY ? '' : ` [${scope.category}]`;
      if (!pct && !units) return `${scope.label}${tag}`;
      return `${scope.label}: ${[pct, units].filter(Boolean).join(' / ')}${reset}${tag}`;
    })
    .filter(Boolean);
}

module.exports = {
  SCOPE_CATEGORY_PRIMARY,
  SCOPE_CATEGORY_GIFT,
  SCOPE_CATEGORY_DETAIL,
  buildQuotaView,
  resolveEntryShape,
  resolveEntryShapeByKind,
  getKindShapeIndex,
  resetKindShapeIndexCache,
  humanizeBucketLabel,
  formatQuotaViewInline,
  formatQuotaViewLines,
  formatScopeInline,
  formatUnits
};
