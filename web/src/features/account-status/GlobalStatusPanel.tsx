import React from 'react';
import { UpOutlined, DownOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import SectionCard from '@/components/ui/SectionCard';
import { buildGlobalBuckets, healthColorForUptime, summarizeUptime } from './health';
import BucketStrip from './BucketStrip';
import StripWithFooter from './StripWithFooter';
import ContributionGrid from './ContributionGrid';
import TierLegend from './TierLegend';
import type { UseAccountOutcomesResult } from './useAccountOutcomes';
import './account-status.css';

const COLLAPSE_STORAGE_KEY = 'accounts-global-status-collapsed:v1';

function readStoredCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1';
  } catch (_error) {
    return false;
  }
}

function persistCollapsed(collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? '1' : '0');
  } catch (_error) { /* ignore */ }
}

/**
 * 账号页顶部全局状态区（inspired by status.claude.com + GitHub 贡献图）：
 * 90 天可用率 KPI、90 天日条、最近 24 小时时条、90 天立方体网格、档位图例。
 * 全局 = 所有账号求和（先按 days/hours 内容去重合并账号，见 health.ts）。
 * 默认可折叠，避免把账号表格挤到下面。
 */
export default function GlobalStatusPanel({ outcomes }: { outcomes: UseAccountOutcomesResult }) {
  const [collapsed, setCollapsed] = React.useState<boolean>(readStoredCollapsed);
  const { data, loading, unavailable } = outcomes;

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      persistCollapsed(next);
      return next;
    });
  };

  const globalDayBuckets = React.useMemo(
    () => (data ? buildGlobalBuckets(data.accounts, data.dayStarts, 'days') : []),
    [data]
  );
  const globalHourBuckets = React.useMemo(
    () => (data ? buildGlobalBuckets(data.accounts, data.hourStarts, 'hours') : []),
    [data]
  );
  const overallUptime = React.useMemo(() => summarizeUptime(globalDayBuckets), [globalDayBuckets]);

  if (!loading && unavailable) {
    return (
      <SectionCard title="账号健康状态" className="accounts-global-status">
        <p className="account-status-unavailable">状态数据暂不可用</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="账号健康状态"
      className="accounts-global-status"
      extra={(
        <Button type="text" size="small" icon={collapsed ? <DownOutlined /> : <UpOutlined />} onClick={toggle}>
          {collapsed ? '展开' : '收起'}
        </Button>
      )}
    >
      {!data ? (
        <p className="account-status-unavailable">{loading ? '加载中…' : '暂无数据（从现在开始记录）'}</p>
      ) : collapsed ? (
        <BucketStrip
          starts={data.dayStarts}
          buckets={globalDayBuckets}
          granularity="day"
          size="xs"
          ariaLabel="最近 90 天全局健康状态（已收起）"
        />
      ) : (
        <div className="account-status-global">
          <div className="account-status-global__kpi">
            <span
              className={`account-status-global__kpi-value${overallUptime.hasData ? '' : ' account-status-uptime--none'}`}
              style={{ color: healthColorForUptime(overallUptime) }}
            >
              {overallUptime.hasData ? `${overallUptime.rate?.toFixed(2)}%` : '—'}
            </span>
            <span className="account-status-global__kpi-label">
              {overallUptime.hasData ? `90 天整体可用率 · 共 ${overallUptime.totalRequests} 次请求` : '暂无数据（从现在开始记录）'}
            </span>
          </div>

          <div>
            <div className="account-status-global__block-title">最近 90 天</div>
            <StripWithFooter starts={data.dayStarts} buckets={globalDayBuckets} granularity="day" size="sm" />
          </div>

          <div>
            <div className="account-status-global__block-title">最近 24 小时</div>
            <StripWithFooter starts={data.hourStarts} buckets={globalHourBuckets} granularity="hour" size="sm" />
          </div>

          <div>
            <div className="account-status-global__block-title">90 天概览</div>
            <ContributionGrid dayStarts={data.dayStarts} buckets={globalDayBuckets} />
          </div>

          <TierLegend />
        </div>
      )}
    </SectionCard>
  );
}
