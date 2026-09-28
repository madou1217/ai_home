import { Popover } from 'antd';
import { alignBuckets, summarizeUptime } from './health';
import BucketStrip from './BucketStrip';
import StripWithFooter from './StripWithFooter';
import type { AccountOutcomesData } from './types';
import './account-status.css';

interface Props {
  accountRef: string;
  data: AccountOutcomesData | null;
  unavailable: boolean;
}

/**
 * 账号表格「健康状态」列：紧凑 90 天 mini 条 + 90 天可用率；
 * 悬浮弹出最近 24 小时明细条，不占用表格列宽。
 */
export default function AccountHealthCell({ accountRef, data, unavailable }: Props) {
  if (unavailable) {
    return <span className="account-status-unavailable">状态数据暂不可用</span>;
  }
  if (!data) {
    return <span className="account-status-unavailable">加载中…</span>;
  }
  const account = data.accounts.find((item) => item.accountRef === accountRef) || null;
  const dayBuckets = alignBuckets(data.dayStarts, account?.days);
  const hourBuckets = alignBuckets(data.hourStarts, account?.hours);
  const uptime = summarizeUptime(dayBuckets);

  if (!account) {
    return <span className="account-status-unavailable">暂无数据（从现在开始记录）</span>;
  }

  return (
    <Popover
      trigger={['hover', 'click']}
      placement="left"
      overlayClassName="account-status-popover"
      content={(
        <div>
          <div className="account-status-popover__title">最近 24 小时</div>
          <StripWithFooter starts={data.hourStarts} buckets={hourBuckets} granularity="hour" size="sm" />
        </div>
      )}
    >
      <div className="account-status-mini">
        <BucketStrip
          starts={data.dayStarts}
          buckets={dayBuckets}
          granularity="day"
          size="xs"
          ariaLabel={`账号 ${accountRef} 最近 90 天健康状态`}
        />
        <span className={`account-status-mini__uptime account-status-uptime--${uptime.tier}`}>
          {uptime.hasData ? `${uptime.rate?.toFixed(2)}% 可用` : '暂无数据'}
        </span>
      </div>
    </Popover>
  );
}
