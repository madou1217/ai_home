import { HudSection } from '@/mobile/ui';
import { alignBuckets, summarizeUptime } from './health';
import StripWithFooter from './StripWithFooter';
import type { AccountOutcomesData } from './types';
import './account-status.css';

interface Props {
  accountRef: string;
  data: AccountOutcomesData | null;
  unavailable: boolean;
  loading: boolean;
}

/**
 * 移动端账号详情抽屉「健康状态」分区：90 天条 + 24 小时条 + 各自可用率；
 * 两条状态条都用 fit 模式收窄间距，避免在窄屏抽屉里横向溢出。
 */
export default function AccountDetailStatusSection({ accountRef, data, unavailable, loading }: Props) {
  if (!loading && unavailable) {
    return (
      <HudSection title="健康状态" code="STATUS">
        <p className="account-status-unavailable">状态数据暂不可用</p>
      </HudSection>
    );
  }
  if (!data) {
    return (
      <HudSection title="健康状态" code="STATUS">
        <p className="account-status-unavailable">{loading ? '加载中…' : '暂无数据（从现在开始记录）'}</p>
      </HudSection>
    );
  }

  const account = data.accounts.find((item) => item.accountRef === accountRef) || null;
  const dayBuckets = alignBuckets(data.dayStarts, account?.days);
  const hourBuckets = alignBuckets(data.hourStarts, account?.hours);
  const uptime = summarizeUptime(dayBuckets);

  if (!account) {
    return (
      <HudSection title="健康状态" code="STATUS">
        <p className="account-status-unavailable">暂无数据（从现在开始记录）</p>
      </HudSection>
    );
  }

  return (
    <HudSection title="健康状态" code="STATUS" count={uptime.hasData ? `${uptime.rate?.toFixed(2)}%` : undefined}>
      <div className="account-status-mobile-strip">
        <div className="account-status-global__block-title">最近 90 天</div>
        <StripWithFooter starts={data.dayStarts} buckets={dayBuckets} granularity="day" size="xs" fit />
      </div>
      <div className="account-status-mobile-strip" style={{ marginTop: 12 }}>
        <div className="account-status-global__block-title">最近 24 小时</div>
        <StripWithFooter starts={data.hourStarts} buckets={hourBuckets} granularity="hour" size="xs" fit />
      </div>
    </HudSection>
  );
}
