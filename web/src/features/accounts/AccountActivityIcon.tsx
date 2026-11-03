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
  const runtimeSessions = Math.max(0, Number(activity && activity.runtimeSessions) || 0);
  const runtimeAttached = Math.max(0, Number(activity && activity.runtimeAttached) || 0);
  const runtimeActive = Boolean(activity && (activity.runtimeActive || runtimeSessions > 0));
  const style: CSSProperties | undefined = active
    ? {
        display: 'inline-block',
        animation: `${provider === 'agy' ? 'aih-account-activity-spin-y' : 'aih-account-activity-spin'} ${spinDurationMs(activity as ManagementAccountActivity)}ms linear infinite`
      }
    : undefined;
  // 活跃原因按来源说清楚：持久 CLI 会话（所有 provider）→ 原生会话回合 → 网关请求。
  // 「终端只是开着」不是服务中：只有真实回合/请求才点亮转圈，否则标题明确写「空闲」。
  const title = !active
    ? runtimeActive
      ? `CLI 终端已打开（${runtimeSessions} 个会话，${runtimeAttached} 个在用，当前空闲）`
      : undefined
    : runtimeAttached > 0
      ? `服务中 · CLI 会话 ${runtimeAttached}/${runtimeSessions} 已进入 · 请求速率 ${(activity as ManagementAccountActivity).rate} 次/10s`
      : (activity as ManagementAccountActivity).sessionTurnActive
        ? `服务中 · 原生会话回合运行中 · 请求速率 ${(activity as ManagementAccountActivity).rate} 次/10s`
        : `服务中 · 请求速率 ${(activity as ManagementAccountActivity).rate} 次/10s`;
  return (
    <span
      data-account-activity={active ? 'active' : 'idle'}
      data-account-activity-rate={active ? String((activity as ManagementAccountActivity).rate) : '0'}
      data-account-activity-runtime={runtimeActive ? 'live' : 'idle'}
      title={title}
      style={style}
    >
      <ProviderIcon provider={provider} size={size} />
    </span>
  );
};

export default AccountActivityIcon;