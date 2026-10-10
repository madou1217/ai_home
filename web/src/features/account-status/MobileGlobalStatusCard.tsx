import React from 'react';
import { HudSection } from '@/mobile/ui';
import { buildGlobalBuckets, healthColorForUptime, summarizeUptime } from './health';
import StripWithFooter from './StripWithFooter';
import type { UseAccountOutcomesResult } from './useAccountOutcomes';
import './account-status.css';

/**
 * 移动端账号列表顶部全局状态卡：90 天整体可用率 + 自适应宽度的 90 天状态条。
 * 全局聚合规则（去重合并账号 + 逐桶求和）与桌面 GlobalStatusPanel 共用 health.ts。
 */
export default function MobileGlobalStatusCard({ outcomes }: { outcomes: UseAccountOutcomesResult }) {
  const { data, loading, unavailable } = outcomes;

  const globalDayBuckets = React.useMemo(
    () => (data ? buildGlobalBuckets(data.accounts, data.dayStarts, 'days') : []),
    [data]
  );
  const overallUptime = React.useMemo(() => summarizeUptime(globalDayBuckets), [globalDayBuckets]);

  if (!loading && unavailable) {
    return (
      <HudSection title="账号健康状态" code="STATUS">
        <p className="account-status-unavailable">状态数据暂不可用</p>
      </HudSection>
    );
  }

  return (
    <HudSection title="账号健康状态" code="STATUS">
      {!data ? (
        <p className="account-status-unavailable">{loading ? '加载中…' : '暂无数据（从现在开始记录）'}</p>
      ) : (
        <>
          <div className="account-status-global__kpi">
            <span
              className={`account-status-global__kpi-value${overallUptime.hasData ? '' : ' account-status-uptime--none'}`}
              style={{ color: healthColorForUptime(overallUptime) }}
            >
              {overallUptime.hasData ? `${overallUptime.rate?.toFixed(2)}%` : '—'}
            </span>
            <span className="account-status-global__kpi-label">
              {overallUptime.hasData ? '90 天整体可用率' : '暂无数据（从现在开始记录）'}
            </span>
          </div>
          <div className="account-status-mobile-strip">
            <StripWithFooter starts={data.dayStarts} buckets={globalDayBuckets} granularity="day" size="xs" fit />
          </div>
        </>
      )}
    </HudSection>
  );
}
