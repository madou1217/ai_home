'use strict';

// 积分/余额明细渲染器 —— 现在由**额度视图模型**驱动（lib/usage/quota/view.js），
// 不再按 provider kind 写死（此前只看 codebuddy 快照）。任何 bucket 形态、带单位信息的
// 快照（codebuddy / workbuddy / kiro / grok / zcode / cline-pass …）都走这里。
//
// 没有单位信息的快照返回 null，交给通用视图渲染器（presenter 里的 formatQuotaViewLines），
// 因此「未知快照仍然打印原始 JSON」的历史行为保持不变。

const { buildQuotaView } = require('../../../usage/quota');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = value => finite(value) ? Number(value.toFixed(4)).toString() : 'unknown';
const label = value => String(value || '').replace(/[\x00-\x1f\x7f\x1b]/g, '').slice(0, 80);

function formatCreditUsageLines(snapshot) {
  const view = buildQuotaView(snapshot);
  const scopes = view.scopes.filter((scope) => scope.shape !== 'models' && scope.shape !== 'window');
  if (!scopes.length) return null;
  if (!scopes.some((scope) => scope.remainingUnits !== null || scope.totalUnits !== null)) return null;
  return scopes.map((scope) => {
    const percent = scope.remainingPct === null ? 'unknown' : `${scope.remainingPct.toFixed(2)}%`;
    const indent = scope.category === 'primary' ? '' : '  ';
    const name = label(scope.bucket) || label(scope.label) || 'credits';
    return `${indent}${name}: ${number(scope.remainingUnits)}/${number(scope.totalUnits)} ${label(scope.unitType) || 'credits'} remaining (${percent})`;
  });
}
module.exports = { formatCreditUsageLines };
