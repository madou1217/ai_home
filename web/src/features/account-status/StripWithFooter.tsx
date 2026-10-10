import dayjs from 'dayjs';
import BucketStrip from './BucketStrip';
import { healthColorForUptime, summarizeUptime } from './health';
import type { BucketGranularity, OutcomeBucket } from './types';
import './account-status.css';

interface Props {
  starts: number[];
  buckets: Array<OutcomeBucket | null>;
  granularity: BucketGranularity;
  size?: 'md' | 'sm' | 'xs';
  fit?: boolean;
}

function formatUptimeText(rate: number | null, hasData: boolean): string {
  if (!hasData || rate === null) return '暂无数据（从现在开始记录）';
  return `${rate.toFixed(2)}% 可用`;
}

/**
 * status.claude.com 风格：状态条 + 下方一行「起点 … 可用率 … 终点」。
 * 90 天日条 / 24 小时时条共用；起止文案随 granularity 切换措辞。
 */
export default function StripWithFooter({ starts, buckets, granularity, size = 'sm', fit }: Props) {
  const summary = summarizeUptime(buckets);
  const startLabel = granularity === 'day' ? `${starts.length} 天前` : `${starts.length} 小时前`;
  const endLabel = granularity === 'day' ? '今天' : '现在';
  return (
    <div>
      <BucketStrip
        starts={starts}
        buckets={buckets}
        granularity={granularity}
        size={size}
        fit={fit}
        ariaLabel={granularity === 'day' ? '最近 90 天健康状态' : '最近 24 小时健康状态'}
      />
      <div className="account-status-strip-footer">
        <span>{startLabel}</span>
        <span
          className={`account-status-uptime${summary.hasData ? '' : ' account-status-uptime--none'}`}
          style={{ color: healthColorForUptime(summary) }}
        >
          {formatUptimeText(summary.rate, summary.hasData)}
        </span>
        <span>{endLabel}</span>
      </div>
    </div>
  );
}

export { formatUptimeText };
export function formatBucketRangeLabel(starts: number[], granularity: BucketGranularity): string {
  if (starts.length === 0) return '';
  const first = dayjs(starts[0]);
  const last = dayjs(starts[starts.length - 1]);
  return granularity === 'day'
    ? `${first.format('YYYY-MM-DD')} ~ ${last.format('YYYY-MM-DD')}`
    : `${first.format('MM-DD HH:00')} ~ ${last.format('MM-DD HH:00')}`;
}
