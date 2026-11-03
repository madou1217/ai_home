import React from 'react';
import { DownOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import SectionCard from '@/components/ui/SectionCard';
import Reveal from '@/components/ui/Reveal';
import { buildGlobalBuckets, healthColorForUptime, summarizeUptime } from './health';
import BucketStrip from './BucketStrip';
import StripWithFooter from './StripWithFooter';
import ContributionGrid from './ContributionGrid';
import TierLegend from './TierLegend';
import type { UseAccountOutcomesResult } from './useAccountOutcomes';
import type { AccountOutcomesData, OutcomeBucket } from './types';
import type { UptimeSummary } from './health';
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
        <Button
          type="text"
          size="small"
          onClick={toggle}
          // 展开/收起必须是「点一下就响应、再点立刻反向」；AppButton 默认 720ms 防连点
          // 会让第二次点击直接消失，正好违背这里的交互目标。
          disableDebounce
          aria-expanded={!collapsed}
          aria-controls="accounts-global-status-body"
        >
          <DownOutlined className={`accounts-global-status__toggle-icon${collapsed ? '' : ' is-open'}`} />
          {collapsed ? '展开' : '收起'}
        </Button>
      )}
    >
      {!data ? (
        <p className="account-status-unavailable">{loading ? '加载中…' : '暂无数据（从现在开始记录）'}</p>
      ) : (
        <div id="accounts-global-status-body">
          {/* 收起态只露一条 90 天概览；展开态才铺开 KPI / 两条状态条 / 网格。
              两块内容都 keepMounted：切换时只做 grid-template-rows 过渡，不重挂 200+ 个节点。 */}
          <Reveal open={collapsed} keepMounted exitMs={240}>
            <BucketStrip
              starts={data.dayStarts}
              buckets={globalDayBuckets}
              granularity="day"
              size="xs"
              ariaLabel="最近 90 天全局健康状态（已收起）"
            />
          </Reveal>
          <Reveal
            open={!collapsed}
            keepMounted
            exitMs={240}
            // 这块再高也要逐帧展开：用户明确要求「点击展开必须有过渡动画」。
            tallThreshold={Number.POSITIVE_INFINITY}
          >
            <GlobalStatusDetails
              data={data}
              dayBuckets={globalDayBuckets}
              hourBuckets={globalHourBuckets}
              overallUptime={overallUptime}
            />
          </Reveal>
        </div>
      )}
    </SectionCard>
  );
}

interface DetailsProps {
  data: AccountOutcomesData;
  dayBuckets: Array<OutcomeBucket | null>;
  hourBuckets: Array<OutcomeBucket | null>;
  overallUptime: UptimeSummary;
}

/**
 * 展开态是页面里最重的一块（两条 90/24 格状态条 + 90 格网格）。
 * 用 memo 隔离：折叠只改外层 Reveal 的 CSS 行高，不会让这棵树跟着父组件重渲染。
 */
const GlobalStatusDetails = React.memo(function GlobalStatusDetails({
  data,
  dayBuckets,
  hourBuckets,
  overallUptime
}: DetailsProps) {
  return (
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
        <StripWithFooter starts={data.dayStarts} buckets={dayBuckets} granularity="day" size="sm" />
      </div>

      <div>
        <div className="account-status-global__block-title">最近 24 小时</div>
        <StripWithFooter starts={data.hourStarts} buckets={hourBuckets} granularity="hour" size="sm" />
      </div>

      <div>
        <div className="account-status-global__block-title">90 天概览</div>
        <ContributionGrid dayStarts={data.dayStarts} buckets={dayBuckets} />
      </div>

      <TierLegend />
    </div>
  );
});
