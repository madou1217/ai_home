import { useEffect, useMemo, useState } from 'react';
import { Grid, Segmented, Select, Space, Tooltip, Typography } from 'antd';
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';

// 与模型用量页共用同一套 HUD 表面（KPI 切角条、发丝网格、图表壳）；
// 改动 .usage-* 时两边要一起看，避免视觉语言分叉。
import '@/pages/ModelUsage.css';
import './AccountQuota.css';

import PageScaffold from '@/components/ui/PageScaffold';
import SectionCard from '@/components/ui/SectionCard';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import AnimatedValue from '@/components/ui/AnimatedValue';
import SettingStatusTag, { type SettingStatusState } from '@/components/ui/SettingStatusTag';
import MobileBackButton from '@/components/mobile/MobileBackButton';
import { resolveOrderedDirection, useSurfaceSwitch } from '@/hooks/use-surface-switch';
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
import type { AccountQuotaStatsResponse, QuotaStatsGranularity, QuotaUsageBucket } from '@/types';

const STALE_THRESHOLD_MS = 10 * 60 * 1000;

function shortenAccountRef(accountRef: string) {
  if (accountRef.length <= 18) return accountRef;
  return `${accountRef.slice(0, 9)}…${accountRef.slice(-6)}`;
}

type QuotaAccountState = {
  status: SettingStatusState;
  label: '已配置' | '未配置' | '获取失败' | '无额度';
  detail: string;
};

function resolveQuotaAccountState(
  provider: string,
  accountRef: string,
  data: AccountQuotaStatsResponse | null,
  error: string | null
): QuotaAccountState {
  if (!provider || !accountRef) {
    return { status: 'unset', label: '未配置', detail: '缺少账号参数，无法定位额度配置' };
  }
  if (error) {
    return { status: 'error', label: '获取失败', detail: error };
  }
  if (!data) {
    return { status: 'unset', label: '未配置', detail: '尚未获取到额度数据' };
  }
  const remaining = data.current?.remainingPct;
  if (remaining !== null && remaining !== undefined && remaining <= 0) {
    return { status: 'error', label: '无额度', detail: '当前剩余额度为 0%' };
  }
  const hasAnyDimension = data.dimensions.some((item) => item.available);
  const hasSnapshot = remaining !== null && remaining !== undefined;
  const hasUsage = (data.usageBuckets || []).length > 0;
  if (!hasAnyDimension && !hasSnapshot && !hasUsage) {
    return { status: 'unset', label: '未配置', detail: '该账号尚未产生额度快照或用量记录' };
  }
  return {
    status: 'applied',
    label: '已配置',
    detail: hasSnapshot ? `当前剩余 ${formatQuotaPct(remaining)}` : '按网关调用记录统计'
  };
}

function resolveRefreshStatus(
  loading: boolean,
  error: string | null,
  data: AccountQuotaStatsResponse | null
): { status: SettingStatusState; label: string; detail?: string } {
  if (loading) {
    return { status: 'saving', label: '刷新中' };
  }
  if (error) {
    return { status: 'error', label: '获取失败', detail: error };
  }
  const capturedAt = data?.current?.capturedAtMs || data?.generatedAtMs || 0;
  if (!capturedAt) {
    return { status: 'unset', label: '未采样' };
  }
  const ageMs = Date.now() - capturedAt;
  if (ageMs > STALE_THRESHOLD_MS) {
    return {
      status: 'dirty',
      label: `数据陈旧 · ${formatQuotaClock(capturedAt)}`,
      detail: '快照时间距今较久，可点击刷新获取最新状态'
    };
  }
  return {
    status: 'saved',
    label: `已更新 · ${formatQuotaClock(capturedAt)}`
  };
}

interface QuotaKpiStripProps {
  isUsageView: boolean;
  data: AccountQuotaStatsResponse | null;
  periodLabel: string;
  costText: string;
  avgTokensText: string;
  peakBucket: QuotaUsageBucket | null;
  activeGranularity: QuotaStatsGranularity;
  quotaState: QuotaAccountState;
}

function QuotaKpiStrip({
  isUsageView,
  data,
  periodLabel,
  costText,
  avgTokensText,
  peakBucket,
  activeGranularity,
  quotaState
}: QuotaKpiStripProps) {
  const current = data?.current;
  const summary = data?.summary;
  const usageSummary = data?.usageSummary;

  const remainingSub = current?.resetAtMs
    ? `下次关窗 ${formatQuotaClock(current.resetAtMs)}`
    : (data?.emptyReason === 'snapshot_only' ? '最新快照' : quotaState.label);

  if (isUsageView) {
    return (
      <section className="usage-kpi-rail quota-kpi-rail" aria-label="用量核心指标">
        <div className="usage-kpi-item usage-kpi-item--primary">
          <span>当前剩余</span>
          <strong><AnimatedValue>{formatQuotaPct(current?.remainingPct)}</AnimatedValue></strong>
          <small>{remainingSub}</small>
        </div>
        <div className="usage-kpi-item">
          <span>总 Tokens</span>
          <strong><AnimatedValue>{formatTokens(usageSummary?.totalTokens ?? 0)}</AnimatedValue></strong>
          <small>{periodLabel}均 {avgTokensText}</small>
        </div>
        <div className="usage-kpi-item usage-kpi-item--cost">
          <span>估算成本</span>
          <strong><AnimatedValue>{costText}</AnimatedValue></strong>
          <small>USD · 按当前价格快照</small>
        </div>
        <div className="usage-kpi-item">
          <span>请求数</span>
          <strong><AnimatedValue>{usageSummary?.requestCount ?? 0}</AnimatedValue></strong>
          <small>{usageSummary?.bucketCount ?? 0} 个{periodLabel}桶</small>
        </div>
        <div className="usage-kpi-item">
          <span>峰值 Tokens</span>
          <strong><AnimatedValue>{formatTokens(peakBucket?.tokens ?? 0)}</AnimatedValue></strong>
          <small>{peakBucket ? formatUsageBucketAxis(peakBucket.bucketStartMs, activeGranularity) : '范围内无用量'}</small>
        </div>
        <div className="usage-kpi-item">
          <span>统计范围</span>
          <strong><AnimatedValue>{`${data?.range.rangeDays ?? 0} 天`}</AnimatedValue></strong>
          <small>自然{periodLabel}聚合</small>
        </div>
      </section>
    );
  }

  return (
    <section className="usage-kpi-rail quota-kpi-rail" aria-label="额度窗口核心指标">
      <div className="usage-kpi-item usage-kpi-item--primary">
        <span>当前剩余</span>
        <strong><AnimatedValue>{formatQuotaPct(current?.remainingPct)}</AnimatedValue></strong>
        <small>{remainingSub}</small>
      </div>
      <div className="usage-kpi-item">
        <span>窗口数</span>
        <strong><AnimatedValue>{summary?.windowCount ?? 0}</AnimatedValue></strong>
        <small>完整数据 {summary?.coveredWindowCount ?? 0}</small>
      </div>
      <div className="usage-kpi-item">
        <span>平均消耗</span>
        <strong><AnimatedValue>{formatQuotaPct(summary?.avgConsumedPct)}</AnimatedValue></strong>
        <small>峰值 {formatQuotaPct(summary?.maxConsumedPct)}</small>
      </div>
      <div className="usage-kpi-item">
        <span>总 Tokens</span>
        <strong><AnimatedValue>{formatTokens(summary?.totalTokens ?? 0)}</AnimatedValue></strong>
        <small>每窗均 {avgTokensText}</small>
      </div>
      <div className="usage-kpi-item usage-kpi-item--cost">
        <span>估算成本</span>
        <strong><AnimatedValue>{costText}</AnimatedValue></strong>
        <small>USD · 按当前价格快照</small>
      </div>
      <div className="usage-kpi-item">
        <span>请求数</span>
        <strong><AnimatedValue>{summary?.requestCount ?? 0}</AnimatedValue></strong>
        <small>
          {summary?.lastResetAtMs
            ? `最近重置 ${formatQuotaClock(summary.lastResetAtMs)}`
            : '范围内无重置'}
        </small>
      </div>
    </section>
  );
}

export default function AccountQuota() {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const navigate = useNavigate();
  const routeParams = useParams<{ provider?: string; accountRef?: string }>();
  const provider = String(routeParams.provider || '').trim().toLowerCase();
  const accountRef = String(routeParams.accountRef || '').trim();
  const { surfaceRef: quotaSurfaceRef, switchSurface: switchQuotaSurface } = useSurfaceSwitch<HTMLDivElement>();

  const [windowMinutes, setWindowMinutes] = useState(0);
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

  const activeWindowMinutes = windowMinutes || data?.windowMinutes || 0;
  const activeGranularity: QuotaStatsGranularity = granularity || data?.granularity || 'window';
  const isUsageView = activeGranularity !== 'window';

  useEffect(() => {
    if (!data || !windowMinutes) return;
    const selected = data.dimensions.find((dimension) => dimension.windowMinutes === windowMinutes);
    if (selected?.available) return;
    const fallback = data.dimensions.find((dimension) => dimension.available);
    if (fallback) setWindowMinutes(fallback.windowMinutes);
  }, [data, windowMinutes]);

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

  const dimensionOptions = useMemo(() => (data?.dimensions || []).map((dimension) => ({
    label: dimension.label,
    value: dimension.windowMinutes,
    disabled: !dimension.available
  })), [data]);
  const hasWindowDetails = Boolean(data?.dimensions.some((dimension) => dimension.available));
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
  const distinctScopeLabels = useMemo(
    () => new Set(scopeOptions.map((option) => option.label)).size,
    [scopeOptions]
  );

  const summary = data?.summary;
  const usageSummary = data?.usageSummary;
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

  const quotaState = useMemo(
    () => resolveQuotaAccountState(provider, accountRef, data, error),
    [provider, accountRef, data, error]
  );
  const refreshStatus = useMemo(
    () => resolveRefreshStatus(loading, error, data),
    [loading, error, data]
  );

  const missingRouteParams = !provider || !accountRef;

  return (
    <PageScaffold
      ghost
      code="QUOTA"
      className="account-quota-page"
      title={`额度统计 · ${provider || '账号'}`}
      subTitle={(
        <Tooltip title={accountRef || '未指定账号'}>
          <span>{accountRef ? `${shortenAccountRef(accountRef)} · 查看该账号额度剩余与调用消耗` : '查看账号额度剩余与调用消耗'}</span>
        </Tooltip>
      )}
      extra={isMobile ? (
        <div className="m-header-actions">
          <MobileBackButton className="m-icon-btn" title="返回账号" onClick={() => navigate('/accounts')} />
          <button
            className="m-icon-btn primary"
            aria-label="刷新额度统计"
            disabled={loading || missingRouteParams}
            onClick={() => void reload()}
          >
            <ReloadOutlined spin={loading} />
          </button>
        </div>
      ) : (
        <Space size={8} wrap>
          <SettingStatusTag status={quotaState.status} label={quotaState.label} detail={quotaState.detail} compact />
          <SettingStatusTag status={refreshStatus.status} label={refreshStatus.label} detail={refreshStatus.detail} compact />
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/accounts')}>
            返回账号
          </Button>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            loading={loading}
            disabled={missingRouteParams}
            onClick={() => void reload()}
          >
            刷新
          </Button>
        </Space>
      )}
    >
      <QuotaKpiStrip
        isUsageView={isUsageView}
        data={data}
        periodLabel={periodLabel}
        costText={costText}
        avgTokensText={avgTokensText}
        peakBucket={peakBucket}
        activeGranularity={activeGranularity}
        quotaState={quotaState}
      />

      <SectionCard bordered>
        <div className="quota-stats-toolbar-wrap">
          <Space size={10} wrap className="quota-stats-toolbar">
            <Segmented
              value={activeGranularity}
              options={granularityOptions}
              onChange={(value) => {
                const next = value as QuotaStatsGranularity;
                const order = granularityOptions.map((item) => item.value);
                switchQuotaSurface(() => setGranularity(next), {
                  slot: 'granularity',
                  current: activeGranularity,
                  next,
                  direction: resolveOrderedDirection(order, activeGranularity, next)
                });
              }}
            />
            {!isUsageView && hasWindowDetails ? (
              <Segmented
                value={activeWindowMinutes}
                options={dimensionOptions}
                onChange={(value) => {
                  const nextMinutes = Number(value);
                  const order = dimensionOptions.map((item) => Number(item.value));
                  switchQuotaSurface(() => {
                    setScopeKey('');
                    setWindowMinutes(nextMinutes);
                  }, {
                    slot: 'windowMinutes',
                    current: activeWindowMinutes,
                    next: nextMinutes,
                    direction: resolveOrderedDirection(order, activeWindowMinutes, nextMinutes)
                  });
                }}
              />
            ) : null}
            <Segmented
              value={rangeDays}
              options={QUOTA_RANGE_OPTIONS}
              onChange={(value) => {
                const nextDays = Number(value);
                const order = QUOTA_RANGE_OPTIONS.map((item) => Number(item.value));
                switchQuotaSurface(() => setRangeDays(nextDays), {
                  slot: 'rangeDays',
                  current: rangeDays,
                  next: nextDays,
                  direction: resolveOrderedDirection(order, rangeDays, nextDays)
                });
              }}
            />
            {!isUsageView && scopeOptions.length > 1 && distinctScopeLabels > 1 ? (
              <Select
                value={scopeKey || undefined}
                options={scopeOptions}
                onChange={(value) => {
                  switchQuotaSurface(() => setScopeKey(value), {
                    slot: 'scopeKey',
                    current: scopeKey,
                    next: value
                  });
                }}
                style={{ minWidth: 168 }}
                placeholder="额度范围"
              />
            ) : null}
            <div className="quota-stats-status-inline">
              {isMobile ? (
                <>
                  <SettingStatusTag status={quotaState.status} label={quotaState.label} detail={quotaState.detail} compact />
                  <SettingStatusTag status={refreshStatus.status} label={refreshStatus.label} detail={refreshStatus.detail} compact />
                </>
              ) : null}
              <Typography.Text type="secondary" className="quota-stats-note">
                {isUsageView
                  ? `按服务器时区聚合自然${periodLabel}归属调用。`
                  : '窗口由重置后的首个请求锚定，仅统计归属到本账号的调用。'}
              </Typography.Text>
            </div>
          </Space>

          {error ? (
            <InlineNote
              tone="error"
              description={error}
              action={<Button size="small" type="link" onClick={() => void reload()}>重试</Button>}
            >
              额度统计获取失败
            </InlineNote>
          ) : missingRouteParams ? (
            <InlineNote
              tone="warning"
              action={<Button size="small" type="link" onClick={() => navigate('/accounts')}>返回账号列表</Button>}
            >
              未指定账号，无法加载额度统计。
            </InlineNote>
          ) : quotaState.label === '无额度' ? (
            <InlineNote tone="warning">
              当前账号剩余额度为 0%，请等待窗口重置或切换其他可用账号。
            </InlineNote>
          ) : null}
        </div>
      </SectionCard>

      <div ref={quotaSurfaceRef}>
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
            extra={<SettingStatusTag status={refreshStatus.status} label={loading ? '刷新中' : `${(data?.usageBuckets || []).length} 行`} compact />}
          >
            <div className="quota-table-scroll">
              <UsageBucketTable
                buckets={data?.usageBuckets || []}
                granularity={activeGranularity}
                loading={loading}
              />
            </div>
            <Typography.Text type="secondary" className="quota-stats-footnote">
              成本按当前价格快照估算，未归属的历史会话不计入。
            </Typography.Text>
          </SectionCard>
        ) : hasWindowDetails ? (
          <SectionCard
            title="窗口明细"
            extra={<SettingStatusTag status={refreshStatus.status} label={loading ? '刷新中' : `${(data?.windows || []).length} 个窗口`} compact />}
          >
            <div className="quota-table-scroll">
              <QuotaWindowTable windows={data?.windows || []} loading={loading} />
            </div>
            <Typography.Text type="secondary" className="quota-stats-footnote">
              标注「仅重置事件 / 重建」的行由历史记录估算，仅供参考。
            </Typography.Text>
          </SectionCard>
        ) : null}
      </div>
    </PageScaffold>
  );
}
