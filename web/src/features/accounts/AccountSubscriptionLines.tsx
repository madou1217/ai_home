import { Tooltip } from 'antd';
import type { Account } from '@/types';
import {
  formatCodexSubscriptionTooltip,
  formatPlanValidUntil,
  getCodexSubscription,
  getKimiPlanSubscription
} from './AccountBadges';

// 订阅有效期单独成行（列表账号列与卡片共用）：账号名很长时放在同一行会被省略号截掉。
export default function AccountSubscriptionLines({ record }: { record: Account }) {
  const kimi = getKimiPlanSubscription(record);
  const kimiUntil = kimi ? formatPlanValidUntil(kimi.validUntilMs) : '';
  const codex = getCodexSubscription(record);
  return (
    <>
      {kimi && kimiUntil ? (
        <Tooltip title={`套餐有效期至 ${kimiUntil}${kimi.status === 'canceled' ? ' · 已取消续费，到期后不再自动续订' : ' · 订阅生效中，到期自动续订'}`}>
          <div className="account-subscription-line" style={{ color: kimi.status === 'canceled' ? 'var(--color-warning)' : 'var(--color-muted)' }}>
            订阅至 {kimiUntil}{kimi.status === 'canceled' ? ' · 已取消续费' : ''}
          </div>
        </Tooltip>
      ) : null}
      {codex ? (
        <Tooltip title={formatCodexSubscriptionTooltip(codex)}>
          <div className="account-subscription-line" style={{ color: codex.stale ? 'var(--color-warning)' : 'var(--color-muted)' }}>
            订阅至 {formatPlanValidUntil(codex.validUntilMs)}{codex.stale ? ' · 待刷新确认' : ''}
          </div>
        </Tooltip>
      ) : null}
    </>
  );
}
