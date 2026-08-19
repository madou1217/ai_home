import React from 'react';
import type { CSSProperties } from 'react';
import ProviderIcon from '@/components/chat/ProviderIcon';
import type { ManagementAccountActivity } from '@/types';
import './AccountActivityIcon.css';

interface Props {
  provider: string;
  activity: ManagementAccountActivity | null;
  size?: number;
}

// 转速与 10s 请求速率成正比：rate 越高单圈越快（下限 0.3s/圈，避免闪花）。
function spinDurationMs(activity: ManagementAccountActivity): number {
  const rate = Math.max(0, Number(activity.rate) || 0);
  const duration = 3000 / (1 + rate / 5);
  return Math.max(300, Math.round(duration));
}

const AccountActivityIcon = ({ provider, activity, size = 18 }: Props) => {
  const active = Boolean(activity && activity.inFlight > 0);
  const style: CSSProperties | undefined = active
    ? {
        display: 'inline-block',
        animation: `${provider === 'agy' ? 'aih-account-activity-spin-y' : 'aih-account-activity-spin'} ${spinDurationMs(activity as ManagementAccountActivity)}ms linear infinite`
      }
    : undefined;
  return (
    <span
      data-account-activity={active ? 'active' : 'idle'}
      data-account-activity-rate={active ? String((activity as ManagementAccountActivity).rate) : '0'}
      title={active ? `服务中 · 请求速率 ${(activity as ManagementAccountActivity).rate} 次/10s` : undefined}
      style={style}
    >
      <ProviderIcon provider={provider} size={size} />
    </span>
  );
};

export default AccountActivityIcon;