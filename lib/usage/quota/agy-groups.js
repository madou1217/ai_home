'use strict';

/**
 * Antigravity (AGY) Code Assist 配额分组：
 * 上游模型划分为 2 个模型组（Gemini 与 Claude & GPT）。
 * 在 CLI（`aih agy ls`）中展示配额时按组展示，而不是随意挑选单个具体模型。
 */

const AGY_GROUP_TITLES = Object.freeze({
  claude_gpt: 'Claude & GPT',
  gemini: 'Gemini',
  other: 'Other'
});

/**
 * 识别模型所属的 AGY 配额组 key。
 * 规则与 WebUI (usage-snapshot-format.ts) 及 quota-reset (agy-strategy.js) 保持一致。
 *
 * @param {string} [model]
 * @param {string} [displayName]
 * @returns {'claude_gpt' | 'gemini' | 'other'}
 */
function resolveAgyQuotaGroupKey(model, displayName = '') {
  const searchable = `${String(model || '')} ${String(displayName || '')}`.toLowerCase();
  if (searchable.includes('gemini')) return 'gemini';
  if (searchable.includes('claude') || searchable.includes('gpt')) return 'claude_gpt';
  return 'other';
}

/**
 * 把 snapshot.models 归一化聚合为配额组数组。
 * 每个组包含：key, title, remainingPct, resetIn, resetAtMs, models。
 *
 * @param {Array<object>} [models]
 * @param {object} [_options]
 * @returns {Array<{ key: string, title: string, remainingPct: number, resetIn: string, resetAtMs: number, models: Array<object> }>}
 */
function groupAgyQuotaModels(models = [], _options = {}) {
  if (!Array.isArray(models) || models.length === 0) return [];
  const groupsMap = new Map();

  for (const item of models) {
    if (!item || typeof item !== 'object') continue;
    if (item.remainingPct == null || item.remainingPct === '') continue;
    const remainingNum = Number(item.remainingPct);
    if (!Number.isFinite(remainingNum)) continue;
    const remainingPct = Math.max(0, Math.min(100, remainingNum));

    const modelId = String(item.model || '').trim();
    const displayName = String(item.displayName || '').trim();
    const key = resolveAgyQuotaGroupKey(modelId, displayName);
    const title = AGY_GROUP_TITLES[key] || (key.charAt(0).toUpperCase() + key.slice(1));
    const resetIn = String(item.resetIn || '').trim();
    const resetAtMs = Number(item.resetAtMs) > 0 ? Number(item.resetAtMs) : 0;

    const existing = groupsMap.get(key);
    if (!existing) {
      groupsMap.set(key, {
        key,
        title,
        remainingPct,
        resetIn,
        resetAtMs,
        models: [item]
      });
    } else {
      existing.models.push(item);
      // 保留组内最紧（最低）的 remainingPct 与相应的重置时间
      if (remainingPct < existing.remainingPct) {
        existing.remainingPct = remainingPct;
        existing.resetIn = resetIn || existing.resetIn;
        existing.resetAtMs = resetAtMs || existing.resetAtMs;
      } else if (remainingPct === existing.remainingPct) {
        if (!existing.resetIn && resetIn) {
          existing.resetIn = resetIn;
          existing.resetAtMs = resetAtMs;
        } else if (resetAtMs > 0 && (existing.resetAtMs === 0 || resetAtMs < existing.resetAtMs)) {
          existing.resetAtMs = resetAtMs;
          if (resetIn) existing.resetIn = resetIn;
        }
      }
    }
  }

  // 排序：剩余比例低的排在前面（优先展示紧张配额），同比例按标题字母序保持稳定
  return Array.from(groupsMap.values()).sort((a, b) => {
    if (a.remainingPct !== b.remainingPct) {
      return a.remainingPct - b.remainingPct;
    }
    return a.title.localeCompare(b.title);
  });
}

/**
 * 组装单个配额组的行内文本。
 *
 * @param {object} group
 * @param {object} [options]
 * @returns {string}
 */
function formatAgyGroupInline(group, options = {}) {
  if (!group || typeof group !== 'object') return '';
  const pct = options.compact
    ? `${Math.round(group.remainingPct)}%`
    : `${group.remainingPct.toFixed(1)}%`;
  const cleanReset = String(group.resetIn || '').trim();
  const hasResetIn = cleanReset && cleanReset !== 'unknown' && cleanReset !== 'soon';
  const reset = hasResetIn
    ? (options.compact ? `:${cleanReset}` : ` (${cleanReset})`)
    : '';

  if (options.compact) {
    return `${group.title}:${pct}${reset}`;
  }
  return `${group.title}: ${pct}${reset}`;
}

/**
 * 格式化 AGY 配额组用于 `aih agy ls` / 状态标签行内展示：
 * 例如："Claude & GPT: 95.6% (3h 43m) / Gemini: 100.0% (5h)"
 *
 * @param {Array<object>} [models]
 * @param {object} [options]
 * @returns {string}
 */
function formatAgyQuotaGroups(models = [], options = {}) {
  const groups = groupAgyQuotaModels(models, options);
  if (groups.length === 0) return '';
  return groups.map((g) => formatAgyGroupInline(g, options)).join(options.compact ? ' ' : ' / ');
}

module.exports = {
  AGY_GROUP_TITLES,
  resolveAgyQuotaGroupKey,
  groupAgyQuotaModels,
  formatAgyGroupInline,
  formatAgyQuotaGroups
};
