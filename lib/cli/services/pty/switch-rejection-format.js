'use strict';

// 「为什么没有可切换的账号」→ 人话。
//
// 选号器（lib/account/healthy-account-selector）给出的是 `runtime:rate_limited=2,
// quota_exhausted=1` 这种机器码；直接贴进终端等于没说。用户问过「是不是因为没有
// 可用账号」——提示必须自己回答「为什么没有」。这张表是**展示层**的唯一映射，
// 未知状态原样保留，方便新状态出现时仍然可诊断。

const REJECTION_LABELS = Object.freeze({
  'runtime:auth_invalid': '认证失效',
  'runtime:rate_limited': '限流中',
  'runtime:overloaded': '过载',
  'runtime:network': '网络故障',
  'runtime:network_error': '网络故障',
  'runtime:service_unavailable': '上游不可用',
  'runtime:upstream_error': '上游错误',
  'runtime:cooldown': '冷却中',
  'runtime:routing_blocked': '被路由规则阻断',
  quota_exhausted: '额度耗尽',
  blocked_by_quota: '额度阻断',
  blocked_by_policy: '策略阻断',
  model_cooldown: '该模型冷却中',
  model_unsupported: '不支持当前模型',
  account_disabled: '已停用',
  unconfigured: '未配置',
  api_key_not_allowed: 'API Key 账号被排除',
  missing_account: '账号记录缺失',
  missing_account_ref: '账号引用缺失'
});

function formatRejectionSummary(reason) {
  const text = String(reason || '').trim();
  if (!text) return '';
  const parts = [];
  for (const item of text.split(',')) {
    const [rawStatus, rawCount] = item.trim().split('=');
    const status = String(rawStatus || '').trim();
    if (!status) continue;
    const count = Number(rawCount);
    const label = REJECTION_LABELS[status]
      || (/^no_\w+_accounts$/.test(status) ? '没有其他账号' : status);
    parts.push(Number.isFinite(count) && count > 0 ? `${count} 个${label}` : label);
  }
  return parts.join('、');
}

module.exports = {
  REJECTION_LABELS,
  formatRejectionSummary
};
