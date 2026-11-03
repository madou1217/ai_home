import { memo } from 'react';
import { Tag, Tooltip } from 'antd';
import { GlobalOutlined, StopOutlined } from '@ant-design/icons';
import { describeAccountEgress } from './egress-upstream-presentation';
import type { AccountEgressEntry } from './use-account-egress-summary';

interface AccountEgressBadgeProps {
  entry: AccountEgressEntry | undefined;
  onOpen: () => void;
}

/**
 * 账号列表 / 卡片上的出口徽标：只在「设置了出口」或「当前网络被上游拒绝」时出现，
 * 未设置且网络正常的账号不显示（避免 30 多个账号都挂一枚「未设置」）。点击打开出口设置。
 */
export const AccountEgressBadge = memo(function AccountEgressBadge({ entry, onOpen }: AccountEgressBadgeProps) {
  if (!entry) return null;
  const { account, upstream } = entry;
  const denied = account.network?.status === 'denied';
  if (!account.egress && !denied) return null;
  const badge = describeAccountEgress(account);
  const color = badge.tone === 'error' ? 'error' : badge.tone === 'success' ? 'processing' : 'default';
  const tip = [
    badge.label,
    badge.detail,
    `上游 ${upstream.host}`,
    denied ? '点击设置出口' : '点击修改出口'
  ].filter(Boolean).join(' · ');
  return (
    <Tooltip title={tip}>
      <Tag
        color={color}
        icon={denied ? <StopOutlined /> : <GlobalOutlined />}
        className="account-egress-badge"
        role="button"
        tabIndex={0}
        aria-label={`出口：${badge.label}，${denied ? '设置' : '修改'}出口`}
        onClick={(event) => { event.stopPropagation(); onOpen(); }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          onOpen();
        }}
      >
        {badge.label}
      </Tag>
    </Tooltip>
  );
});
