import { Button, Tooltip } from 'antd';
import type { Account } from '@/types';
import { formatPlanValidUntil, getKimiPlanSubscription } from './AccountBadges';
import { describeCodexSubscription, getCodexSubscription } from './codex-subscription';

const TONE_COLORS = {
  muted: 'var(--color-muted)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  danger: 'var(--color-danger)'
} as const;

interface AccountSubscriptionLinesProps {
  record: Account;
  /** 订阅已到期、尚未确认时，立即刷新额度来确认续费状态。 */
  onConfirm?: (record: Account) => void;
  confirming?: boolean;
}

// 订阅有效期单独成行（列表账号列与卡片共用）：账号名很长时放在同一行会被省略号截掉。
export default function AccountSubscriptionLines({ record, onConfirm, confirming = false }: AccountSubscriptionLinesProps) {
  const kimi = getKimiPlanSubscription(record);
  const kimiUntil = kimi ? formatPlanValidUntil(kimi.validUntilMs) : '';
  const codex = getCodexSubscription(record);
  const codexView = codex ? describeCodexSubscription(codex) : null;
  return (
    <>
      {kimi && kimiUntil ? (
        <Tooltip title={`套餐有效期至 ${kimiUntil}${kimi.status === 'canceled' ? ' · 已取消续费，到期后不再自动续订' : ' · 订阅生效中，到期自动续订'}`}>
          <div className="account-subscription-line" style={{ color: kimi.status === 'canceled' ? 'var(--color-warning)' : 'var(--color-muted)' }}>
            订阅至 {kimiUntil}{kimi.status === 'canceled' ? ' · 已取消续费' : ''}
          </div>
        </Tooltip>
      ) : null}
      {codexView ? (
        <div className="account-subscription-line" style={{ color: TONE_COLORS[codexView.tone] }}>
          <Tooltip title={codexView.tooltip}>
            <span>{codexView.label}</span>
          </Tooltip>
          {codexView.needsConfirmation && onConfirm ? (
            <Button
              type="link"
              size="small"
              loading={confirming}
              style={{ padding: '0 0 0 6px', height: 'auto', fontSize: 'inherit' }}
              onClick={() => onConfirm(record)}
            >
              确认
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
