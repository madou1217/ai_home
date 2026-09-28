import { CheckCircleFilled, CloseCircleFilled, ExclamationCircleFilled, MinusCircleOutlined } from '@ant-design/icons';
import { Popover } from 'antd';
import { alignBuckets, summarizeUptime } from './health';
import StripWithFooter from './StripWithFooter';
import type { AccountOutcomesData, HealthTier } from './types';
import './account-status.css';

interface Props {
  accountRef: string;
  data: AccountOutcomesData | null;
  unavailable: boolean;
}

const TIER_ICON: Record<HealthTier, { icon: JSX.Element; label: string }> = {
  operational: { icon: <CheckCircleFilled />, label: '正常' },
  degraded: { icon: <ExclamationCircleFilled />, label: '轻微异常' },
  partial: { icon: <ExclamationCircleFilled />, label: '部分异常' },
  major: { icon: <CloseCircleFilled />, label: '严重异常' },
  none: { icon: <MinusCircleOutlined />, label: '暂无数据' }
};

/**
 * 账号健康状态图标：按最近 90 天可用率着色（绿=正常、橙=有异常、红=严重、灰=无数据），
 * 悬停展开 90 天日条 + 最近 24 小时条。放在账号名一行，不单独占表格列（卡片模式共用）。
 */
export default function AccountHealthIcon({ accountRef, data, unavailable }: Props) {
  if (unavailable || !data) return null;
  const account = data.accounts.find((item) => item.accountRef === accountRef) || null;
  const dayBuckets = alignBuckets(data.dayStarts, account?.days);
  const hourBuckets = alignBuckets(data.hourStarts, account?.hours);
  const uptime = summarizeUptime(dayBuckets);
  const today = summarizeUptime(hourBuckets);
  // 最近 24 小时有数据时以它为准着色：状态图标要反映「现在」而不是 90 天均值。
  const tier = today.hasData ? today.tier : uptime.tier;
  const meta = TIER_ICON[tier];

  return (
    <Popover
      trigger={['hover', 'click']}
      placement="right"
      overlayClassName="account-status-popover"
      content={(
        <div className="account-status-hover">
          <div className="account-status-popover__title">
            最近 90 天 · {uptime.hasData ? `${uptime.rate?.toFixed(2)}% 可用` : '暂无数据（从现在开始记录）'}
          </div>
          <StripWithFooter starts={data.dayStarts} buckets={dayBuckets} granularity="day" size="sm" />
          <div className="account-status-popover__title">
            最近 24 小时 · {today.hasData ? `${today.rate?.toFixed(2)}% 可用` : '暂无数据'}
          </div>
          <StripWithFooter starts={data.hourStarts} buckets={hourBuckets} granularity="hour" size="sm" />
        </div>
      )}
    >
      <span
        className={`account-health-icon account-status-uptime--${tier}`}
        role="img"
        aria-label={`健康状态：${meta.label}`}
      >
        {meta.icon}
      </span>
    </Popover>
  );
}
