'use strict';

// 时间窗渲染器 —— **现在是额度视图模型（lib/usage/quota/view.js）的适配层**：
// 条目形态由 provider 描述符的 `quota.entryShape === 'window'` 决定，这里不再维护
// 第二份 kind 名单（codex/claude/cline/kimi 的窗口形态由此自动识别）。
//
// 输出与历史实现逐字节一致（`ls` / `usage` / PTY 标题共用）：
//   * 只渲染真正带窗口标签（entry.window）且有数值 remainingPct 的条目；
//   * 最短窗口在前（5h 在 7days 前）；provider 没给 5h 窗口就不显示，绝不伪造。
// bucket / models 形态的 provider 交给各自的渲染分支或通用视图渲染器。

const { buildQuotaView } = require('../../../usage/quota');

function getWindowScopes(cache, options = {}) {
  const view = buildQuotaView(cache);
  if (view.shape !== 'window') return [];
  // 默认只看主额度：category='gift'/'detail' 是旁路信息，进了行内摘要会让
  // 「赠送包用尽」看起来像账号已耗尽（口径同 lib/account/usage-remaining.js）。
  const source = options.includeSecondary ? view.scopes : view.primaryScopes;
  return source.filter((scope) => scope.shape === 'window' && scope.windowLabel);
}

function getOrderedUsageWindows(cache) {
  return getWindowScopes(cache)
    .filter((scope) => scope.remainingPct !== null)
    .map((scope) => ({
      window: scope.windowLabel,
      remainingPct: scope.remainingPct,
      windowMinutes: scope.windowMinutes,
      resetIn: scope.resetIn
    }));
}

// One inline string for `ls` / the PTY title.
//   compact (title): "5h:91% 7days:52%"
//   default (ls):    "5h: 91.0% / 7days: 52.0%"
function formatUsageWindows(cache, options = {}) {
  const windows = getOrderedUsageWindows(cache);
  if (!windows.length) return '';
  if (options.compact) {
    return windows.map((w) => `${w.window}:${Math.round(w.remainingPct)}%`).join(' ');
  }
  return windows.map((w) => `${w.window}: ${w.remainingPct.toFixed(1)}%`).join(' / ');
}

// One line per window for the detailed `usage` view: "5h: 91.0% (resets in 4h)".
// Unlike the compact ls/title views, this keeps windows that carry no numeric
// figure (e.g. codex team-plan fallback rows), since `usage` is the diagnostic
// surface where that context matters.
function formatUsageWindowLines(cache) {
  // 明细面保留旁路条目（gift/detail），但带标签，避免被当成真实配额。
  return getWindowScopes(cache, { includeSecondary: true })
    .map((scope) => {
      const tag = scope.category === 'primary' ? '' : ` [${scope.category}]`;
      if (scope.remainingPct !== null) {
        const reset = scope.resetIn ? ` (resets in ${scope.resetIn})` : '';
        return `${scope.windowLabel}: ${scope.remainingPct.toFixed(1)}%${reset}${tag}`;
      }
      return `${scope.windowLabel}${tag}`;
    })
    .filter(Boolean);
}

module.exports = {
  getOrderedUsageWindows,
  formatUsageWindows,
  formatUsageWindowLines
};
