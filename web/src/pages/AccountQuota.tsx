import { useEffect, useMemo, useState } from 'react';
import { Alert, Grid, Segmented, Select, Space, Tooltip, Typography } from 'antd';
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';

// 与模型用量页共用同一套 HUD 表面（KPI 切角条、发丝网格、图表壳）；
// 改动 .usage-* 时两边要一起看，避免视觉语言分叉。
import '@/pages/ModelUsage.css';
import './AccountQuota.css';

import PageScaffold from '@/components/ui/PageScaffold';
import SectionCard from '@/components/ui/SectionCard';
import Button from '@/components/ui/AppButton';
import MobileBackButton from '@/components/mobile/MobileBackButton';
import { formatCost, formatTokens } from '@/features/model-usage/model-usage-presentation';
import QuotaWindowChart from '@/features/quota-stats/QuotaWindowChart';
import QuotaWindowTable from '@/features/quota-stats/QuotaWindowTable';
import UsageBucketChart from '@/features/quota-stats/UsageBucketChart';
import UsageBucketTable from '@/features/quota-stats/UsageBucketTable';
import { useQuotaStats } from '@/features/quota-stats/use-quota-stats';
import {
  QUOTA_RANGE_OPTIONS,
  formatQuotaClock,
  formatQuotaPct,
  formatUsageBucketAxis,
  getUsageBucketPeriodLabel
} from '@/features/quota-stats/quota-stats-model';
import type { QuotaStatsGranularity } from '@/types';

function shortenAccountRef(accountRef: string) {
  if (accountRef.length <= 18) return accountRef;
  return `${accountRef.slice(0, 9)}…${accountRef.slice(-6)}`;
}

export default function AccountQuota() {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const navigate = useNavigate();
  const routeParams = useParams<{ provider?: string; accountRef?: string }>();
  const provider = String(routeParams.provider || '').trim().toLowerCase();
  const accountRef = String(routeParams.accountRef || '').trim();

  // 0 = 未指定，让服务端按该账号实际有的维度选一个：首屏只发一次请求，
  // 12h / 722 分钟这类非标准窗口不会被固定传 300 的旧逻辑挡一次。
  const [windowMinutes, setWindowMinutes] = useState(0);
  // '' = 未指定，服务端按账号能力自动选（有窗口明细看窗口，否则给日统计）。
  const [granularity, setGranularity] = useState<QuotaStatsGranularity | ''>('');
  const [rangeDays, setRangeDays] = useState(30);
  const [scopeKey, setScopeKey] = useState('');

  const { data, loading, error, reload } = useQuotaStats({
    provider,
    accountRef,
    windowMinutes,
    scopeKey,
    rangeDays,
    granularity
  });

  // 首屏未指定维度（0）时以服务端选中的维度为准，不回写 state —— 回写会多打一次同样的请求。
  const activeWindowMinutes = windowMinutes || data?.windowMinutes || 0;
  const activeGranularity: QuotaStatsGranularity = granularity || data?.granularity || 'window';
  const isUsageView = activeGranularity !== 'window';

  // 手动切到某个维度后如果它变得不可用（数据被清空等），自动落到第一个可用维度。
  useEffect(() => {
    if (!data || !windowMinutes) return;
    const selected = data.dimensions.find((dimension) => dimension.windowMinutes === windowMinutes);
    if (selected?.available) return;
    const fallback = data.dimensions.find((dimension) => dimension.available);
    if (fallback) setWindowMinutes(fallback.windowMinutes);
  }, [data, windowMinutes]);

  // 服务端可能因为 scope 不存在而回落到该维度第一个 scope，这里把选择器同步过去。
  // 反向也要处理：切换维度后旧 scope 不属于新维度（服务端返回 scope=null），
  // 必须清空让服务端重新选，否则会一直停在 dimension_unavailable。
  useEffect(() => {
    if (!data) return;
    const nextKey = data.scope?.quotaKey || '';
    if (nextKey && nextKey !== scopeKey) {
      setScopeKey(nextKey);
      return;
    }
    const selected = data.dimensions.find((dimension) => dimension.windowMinutes === activeWindowMinutes);
    if (!nextKey && scopeKey && selected?.available) setScopeKey('');
  }, [activeWindowMinutes, data, scopeKey]);

  // 维度由服务端按账号数据派生，前端只做渲染：账号有几个窗口长度就显示几个，
  // 不补「（无）」的固定档位，也不假设一定有 5h / 7天 / 30天。
  const dimensionOptions = useMemo(() => (data?.dimensions || []).map((dimension) => ({
    label: dimension.label,
    value: dimension.windowMinutes,
    disabled: !dimension.available
  })), [data]);
  const hasWindowDetails = Boolean(data?.dimensions.some((dimension) => dimension.available));

  // 账号根本产不出窗口维度（积分/余额型 Provider）时连「窗口」都不出现；
  // 有维度但还没采样时保留入口并置灰，让用户知道这个账号本来有窗口期。
  const hasWindowDimensions = Boolean(data && data.dimensions.length > 0);
  const granularityOptions = useMemo(() => {
    const options: Array<{ label: string; value: QuotaStatsGranularity; disabled?: boolean }> = [];
    if (!data || hasWindowDimensions) {
      options.push({ label: '窗口', value: 'window', disabled: Boolean(data) && !hasWindowDetails });
    }
    options.push({ label: '日', value: 'day' }, { label: '周', value: 'week' });
    return options;
  }, [data, hasWindowDimensions, hasWindowDetails]);

  const currentDimension = data?.dimensions.find((item) => item.windowMinutes === activeWindowMinutes);
  const scopeOptions = useMemo(() => (currentDimension?.scopes || []).map((scope) => ({
    label: scope.label || scope.quotaKey,
    value: scope.quotaKey
  })), [currentDimension]);
  // 多个 scope 但标签一样时，下拉选不出区别，不如直接合并展示。
  const distinctScopeLabels = useMemo(
    () => new Set(scopeOptions.map((option) => option.label)).size,
    [scopeOptions]
  );

  const summary = data?.summary;
  const usageSummary = data?.usageSummary;
  const current = data?.current;
  const periodLabel = getUsageBucketPeriodLabel(activeGranularity);
  const costText = isUsageView
    ? (usageSummary && usageSummary.costKnown && usageSummary.totalCostUsd != null
      ? formatCost(usageSummary.totalCostUsd)
      : '—')
    : (summary && summary.costKnown && summary.totalCostUsd != null
      ? formatCost(summary.totalCostUsd)
      : '—');
  const avgTokensText = isUsageView
    ? (usageSummary?.avgTokensPerBucket != null ? formatTokens(usageSummary.avgTokensPerBucket) : '—')
    : (summary && summary.avgTokensPerWindow != null ? formatTokens(summary.avgTokensPerWindow) : '—');
  const peakBucket = useMemo(() => {
    const buckets = data?.usageBuckets || [];
    if (buckets.length === 0) return null;
    return buckets.reduce((peak, bucket) => (bucket.tokens > peak.tokens ? bucket : peak), buckets[0]);
  }, [data]);

  return (
    <PageScaffold
      ghost
      code="QUOTA"
      title={`额度统计 · ${provider || '账号'}`}
      subTitle={(
        <Tooltip title={accountRef}>
          <span>
            {shortenAccountRef(accountRef)} · {isUsageView
              ? `按自然${periodLabel}统计 Tokens、成本与请求数`
              : (data?.emptyReason === 'snapshot_only'
                ? '无窗口期，仅显示最新快照剩余额度'
                : '按窗口期统计额度消耗、Tokens 与成本')}
          </span>
        </Tooltip>
      )}
      extra={isMobile ? (
        <div className="m-header-actions">
          <MobileBackButton className="m-icon-btn" title="返回账号" onClick={() => navigate('/accounts')} />
          <button
            className="m-icon-btn primary"
            aria-label="刷新额度统计"
            disabled={loading}
            onClick={() => void reload()}
          >
            <ReloadOutlined spin={loading} />
          </button>
        </div>
      ) : [
        <Button key="back" icon={<ArrowLeftOutlined />} onClick={() => navigate('/accounts')}>
          返回账号
        </Button>,
        <Button
          key="refresh"
          type="primary"
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={() => void reload()}
        >
          刷新
        </Button>
      ]}
    >
      {error ? (
        <Alert
          type="error"
          showIcon
          message="额度统计加载失败"
          description={error}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {isUsageView ? (
        <section className="usage-kpi-rail" aria-label="用量核心指标">
          <div className="usage-kpi-item usage-kpi-item--primary">
            <span>当前剩余</span>
            <strong>{formatQuotaPct(current?.remainingPct)}</strong>
            <small>
              {current?.resetAtMs
                ? `下次关窗 ${formatQuotaClock(current.resetAtMs)}`
                : (data?.emptyReason === 'snapshot_only' ? '无窗口期 · 最新快照' : '暂无活跃窗口')}
            </small>
          </div>
          <div className="usage-kpi-item">
            <span>总 Tokens</span>
            <strong>{formatTokens(usageSummary?.totalTokens ?? 0)}</strong>
            <small>{periodLabel}均 {avgTokensText}</small>
          </div>
          <div className="usage-kpi-item usage-kpi-item--cost">
            <span>估算成本</span>
            <strong>{costText}</strong>
            <small>USD · 按当前价格快照</small>
          </div>
          <div className="usage-kpi-item">
            <span>请求数</span>
            <strong>{usageSummary?.requestCount ?? 0}</strong>
            <small>{usageSummary?.bucketCount ?? 0} 个{periodLabel}桶</small>
          </div>
          <div className="usage-kpi-item">
            <span>峰值 Tokens</span>
            <strong>{formatTokens(peakBucket?.tokens ?? 0)}</strong>
            <small>{peakBucket ? formatUsageBucketAxis(peakBucket.bucketStartMs, activeGranularity) : '范围内无用量'}</small>
          </div>
          <div className="usage-kpi-item">
            <span>统计范围</span>
            <strong>{data?.range.rangeDays ?? 0} 天</strong>
            <small>自然{periodLabel}聚合</small>
          </div>
        </section>
      ) : (
        <section className="usage-kpi-rail" aria-label="额度窗口核心指标">
          <div className="usage-kpi-item usage-kpi-item--primary">
            <span>当前剩余</span>
            <strong>{formatQuotaPct(current?.remainingPct)}</strong>
            <small>
              {current?.resetAtMs
                ? `下次关窗 ${formatQuotaClock(current.resetAtMs)}`
                : (data?.emptyReason === 'snapshot_only' ? '无窗口期 · 最新快照' : '暂无活跃窗口')}
            </small>
          </div>
          <div className="usage-kpi-item">
            <span>窗口数</span>
            <strong>{summary?.windowCount ?? 0}</strong>
            <small>有完整消耗数据 {summary?.coveredWindowCount ?? 0}</small>
          </div>
          <div className="usage-kpi-item">
            <span>平均消耗</span>
            <strong>{formatQuotaPct(summary?.avgConsumedPct)}</strong>
            <small>峰值 {formatQuotaPct(summary?.maxConsumedPct)}</small>
          </div>
          <div className="usage-kpi-item">
            <span>总 Tokens</span>
            <strong>{formatTokens(summary?.totalTokens ?? 0)}</strong>
            <small>每窗均 {avgTokensText}</small>
          </div>
          <div className="usage-kpi-item usage-kpi-item--cost">
            <span>估算成本</span>
            <strong>{costText}</strong>
            <small>USD · 按当前价格快照</small>
          </div>
          <div className="usage-kpi-item">
            <span>请求数</span>
            <strong>{summary?.requestCount ?? 0}</strong>
            <small>
              {summary?.lastResetAtMs
                ? `最近重置 ${formatQuotaClock(summary.lastResetAtMs)}`
                : '范围内无重置'}
            </small>
          </div>
        </section>
      )}

      <SectionCard bordered>
        <Space size={12} wrap className="quota-stats-toolbar">
          <Segmented
            value={activeGranularity}
            options={granularityOptions}
            onChange={(value) => setGranularity(value as QuotaStatsGranularity)}
          />
          {!isUsageView && hasWindowDetails ? (
            <Segmented
              value={activeWindowMinutes}
              options={dimensionOptions}
              onChange={(value) => {
                // 换维度时清掉 scope：不同窗口长度的 quotaKey 不通用，
                // 留着旧值会让服务端多走一次「scope 不存在」的空请求。
                setScopeKey('');
                setWindowMinutes(Number(value));
              }}
            />
          ) : null}
          <Segmented
            value={rangeDays}
            options={QUOTA_RANGE_OPTIONS}
            onChange={(value) => setRangeDays(Number(value))}
          />
          {!isUsageView && scopeOptions.length > 1 && distinctScopeLabels > 1 ? (
            <Select
              value={scopeKey || undefined}
              options={scopeOptions}
              onChange={(value) => setScopeKey(value)}
              style={{ minWidth: 180 }}
              placeholder="额度范围"
            />
          ) : null}
          <Typography.Text type="secondary" className="quota-stats-note">
            {isUsageView
              ? `按服务器本地时区切分自然${periodLabel}，只统计归属到本账号的网关调用。`
              : '窗口由关闭后的第一个真实请求锚定，不会按日历滚动；空闲期的 reset 是幻影，已剔除。'}
          </Typography.Text>
        </Space>
      </SectionCard>

      <SectionCard className="usage-insights-card" bodyStyle={{ padding: 0 }}>
        {isUsageView ? (
          <UsageBucketChart
            buckets={data?.usageBuckets || []}
            granularity={activeGranularity}
            emptyReason={data?.emptyReason || null}
          />
        ) : (
          <QuotaWindowChart
            windows={data?.windows || []}
            windowMinutes={activeWindowMinutes}
            emptyReason={data?.emptyReason || null}
          />
        )}
      </SectionCard>

      {isUsageView ? (
        <SectionCard
          title={`${periodLabel}明细`}
          extra={loading ? <Typography.Text type="secondary">更新中…</Typography.Text> : null}
        >
          <UsageBucketTable
            buckets={data?.usageBuckets || []}
            granularity={activeGranularity}
            loading={loading}
          />
          <Typography.Text type="secondary" className="quota-stats-footnote">
            只统计能归属到本账号的网关用量；未归属的历史会话不计入。成本按当前价格快照估算。
          </Typography.Text>
        </SectionCard>
      ) : hasWindowDetails ? (
        <SectionCard
          title="窗口明细"
          extra={loading ? <Typography.Text type="secondary">更新中…</Typography.Text> : null}
        >
          <QuotaWindowTable windows={data?.windows || []} loading={loading} />
          <Typography.Text type="secondary" className="quota-stats-footnote">
            仅统计能归属到本账号的用量记录；未归属的历史会话不计入。历史窗口由重置事件与用量记录尽力重建，
            标注「仅重置事件 / 重建」的行是估算值。
          </Typography.Text>
        </SectionCard>
      ) : null}
    </PageScaffold>
  );
}
