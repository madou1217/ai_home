import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Select, Spin } from 'antd';
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import ProviderIcon, { providerNames } from '@/components/chat/ProviderIcon';
import { formatCost, formatTokens } from '@/features/model-usage/model-usage-presentation';
import {
  QUOTA_RANGE_OPTIONS,
  formatQuotaClock,
  formatQuotaPct,
  formatQuotaWindowRange,
  formatUsageBucketAxis,
  formatUsageBucketRange,
  formatWindowConsumed,
  getQuotaEmptyDescription,
  getQuotaEmptyHint,
  getUsageBucketPeriodLabel,
  getWindowSourceMeta
} from '@/features/quota-stats/quota-stats-model';
import { useQuotaStats } from '@/features/quota-stats/use-quota-stats';
import type { MobilePageProps } from '@/mobile/mobile-routes';
import {
  EmptySignal,
  HudCard,
  HudChips,
  HudIconButton,
  HudSection,
  MobilePage,
  MobileToolbar,
  MonoList,
  SwipeRow,
  TelemetryGrid,
  TelemetryTile,
  type HudChipItem,
  type HudTone
} from '@/mobile/ui';
import type {
  QuotaStatsGranularity,
  QuotaStatsWindowRow,
  QuotaUsageBucket,
  QuotaWindowMetric
} from '@/types';
import styles from './MobileAccountQuota.module.css';

type UsageMetric = 'tokens' | 'cost' | 'requests';

interface QuotaBarPoint {
  key: string;
  /** 两端轴标签 */
  axisLabel: string;
  /** 读数标题（窗口区间 / 自然周期） */
  title: string;
  value: number | null;
}

interface QuotaBarStripProps {
  points: QuotaBarPoint[];
  ariaLabel: string;
  tone: HudTone;
  formatValue: (value: number | null) => string;
}

const METRIC_TONES: Record<string, HudTone> = {
  percent: 'warn',
  tokens: 'info',
  cost: 'ok',
  requests: 'info'
};

function shortenAccountRef(accountRef: string) {
  if (accountRef.length <= 20) return accountRef;
  return `${accountRef.slice(0, 10)}…${accountRef.slice(-6)}`;
}

/**
 * 紧凑柱带：把窗口 / 自然周期画成等宽柱（纯 CSS，不加载图表库）。
 * 手指横向拖动逐柱读数；键盘左右方向键同样可用。
 */
function QuotaBarStrip({ points, ariaLabel, tone, formatValue }: QuotaBarStripProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelected(null);
  }, [points]);

  const peakIndex = useMemo(() => {
    let best = -1;
    points.forEach((point, index) => {
      if (point.value == null) return;
      if (best < 0 || point.value > (points[best].value ?? 0)) best = index;
    });
    return best;
  }, [points]);

  const scale = Math.max(peakIndex >= 0 ? points[peakIndex].value ?? 0 : 0, 0);
  const readoutIndex = selected ?? (peakIndex >= 0 ? peakIndex : points.length - 1);
  const readoutLabel = selected == null ? (peakIndex >= 0 ? '峰值' : '最新') : '所选';
  const readoutPoint = points[readoutIndex];

  const pickFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = stripRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    setSelected(Math.max(0, Math.min(points.length - 1, Math.floor(ratio * points.length))));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.key === 'ArrowLeft' ? -1 : 1;
    setSelected((current) => Math.max(0, Math.min(points.length - 1, (current ?? readoutIndex) + step)));
  };

  return (
    <div className={styles.strip}>
      <div className={styles.stripReadout} aria-live="polite">
        <span className="hud-label">{readoutLabel} · {readoutPoint?.title || '—'}</span>
        <span className={`${styles.stripValue} mhud-tone--${tone}`}>{formatValue(readoutPoint?.value ?? null)}</span>
      </div>
      <div
        ref={stripRef}
        className={styles.stripBars}
        role="slider"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={Math.max(points.length - 1, 0)}
        aria-valuenow={readoutIndex}
        aria-valuetext={`${readoutPoint?.title || ''} ${formatValue(readoutPoint?.value ?? null)}`}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture?.(event.pointerId);
          pickFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
          pickFromPointer(event);
        }}
        onKeyDown={onKeyDown}
      >
        {points.map((point, index) => {
          const height = point.value == null || scale <= 0
            ? 0
            : Math.max(2, Math.round((point.value / scale) * 100));
          return (
            <span
              key={point.key}
              className={`${styles.stripBar}${index === readoutIndex ? ` ${styles.stripBarActive}` : ''}`}
              aria-hidden="true"
            >
              {point.value == null ? (
                <span className={styles.stripGap} />
              ) : (
                <span className={`${styles.stripFill} mhud-bg--${tone}`} style={{ height: `${height}%` }} />
              )}
            </span>
          );
        })}
      </div>
      <div className={styles.stripAxis} aria-hidden="true">
        <span>{points[0]?.axisLabel || ''}</span>
        <span>{points[points.length - 1]?.axisLabel || ''}</span>
      </div>
    </div>
  );
}

/**
 * /accounts/:provider/:accountRef/quota 移动端：账号头卡 + 额度遥测 + 筛选芯片 + 柱带 + 明细列表。
 * 数据层 useQuotaStats 与桌面 AccountQuota 同一套 API；窗口语义全部由服务端派生，前端只渲染。
 */
export default function MobileAccountQuota({ params }: MobilePageProps) {
  const navigate = useNavigate();
  const provider = String(params.provider || '').trim().toLowerCase();
  const accountRef = String(params.accountRef || '').trim();

  // 0 = 未指定，让服务端按账号实际维度选一个；'' = 服务端按能力选窗口或日统计。
  const [windowMinutes, setWindowMinutes] = useState(0);
  const [granularity, setGranularity] = useState<QuotaStatsGranularity | ''>('');
  const [rangeDays, setRangeDays] = useState(30);
  const [scopeKey, setScopeKey] = useState('');
  const [windowMetric, setWindowMetric] = useState<QuotaWindowMetric>('percent');
  const [usageMetric, setUsageMetric] = useState<UsageMetric>('tokens');

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

  // 手动选中的维度变为不可用时，落到第一个可用维度。
  useEffect(() => {
    if (!data || !windowMinutes) return;
    const selected = data.dimensions.find((dimension) => dimension.windowMinutes === windowMinutes);
    if (selected?.available) return;
    const fallback = data.dimensions.find((dimension) => dimension.available);
    if (fallback) setWindowMinutes(fallback.windowMinutes);
  }, [data, windowMinutes]);

  // 服务端选了 scope 就同步过来；切维度后旧 scope 不属于新维度时清空重选。
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
    key: String(dimension.windowMinutes),
    label: dimension.label,
    disabled: !dimension.available
  })), [data]);
  const hasWindowDetails = Boolean(data?.dimensions.some((dimension) => dimension.available));
  const hasWindowDimensions = Boolean(data && data.dimensions.length > 0);

  const granularityItems = useMemo<HudChipItem[]>(() => {
    const items: HudChipItem[] = [];
    if (!data || hasWindowDimensions) {
      items.push({ key: 'window', label: '窗口', disabled: Boolean(data) && !hasWindowDetails });
    }
    items.push({ key: 'day', label: '日' }, { key: 'week', label: '周' });
    return items;
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

  const current = data?.current;
  const summary = data?.summary;
  const usageSummary = data?.usageSummary;
  const periodLabel = getUsageBucketPeriodLabel(activeGranularity);
  const costValue = isUsageView
    ? (usageSummary && usageSummary.costKnown ? usageSummary.totalCostUsd : null)
    : (summary && summary.costKnown ? summary.totalCostUsd : null);

  const windowPoints = useMemo<QuotaBarPoint[]>(() => (data?.windows || []).map((window) => ({
    key: String(window.index),
    axisLabel: formatQuotaClock(window.anchorAtMs),
    title: formatQuotaWindowRange(window),
    value: windowMetric === 'percent'
      ? window.consumedPct
      : windowMetric === 'tokens'
        ? window.tokens
        : (window.costKnown ? window.costUsd : null)
  })), [data, windowMetric]);

  const usagePoints = useMemo<QuotaBarPoint[]>(() => (data?.usageBuckets || []).map((bucket) => ({
    key: String(bucket.index),
    axisLabel: formatUsageBucketAxis(bucket.bucketStartMs, activeGranularity),
    title: formatUsageBucketRange(bucket, activeGranularity),
    value: usageMetric === 'tokens'
      ? bucket.tokens
      : usageMetric === 'requests'
        ? bucket.requestCount
        : (bucket.costKnown ? bucket.costUsd : null)
  })), [activeGranularity, data, usageMetric]);

  const windowRows: QuotaStatsWindowRow[] = data?.windows || [];
  const usageRows: QuotaUsageBucket[] = data?.usageBuckets || [];
  const rowCount = isUsageView ? usageRows.length : windowRows.length;
  const metric = isUsageView ? usageMetric : windowMetric;
  const metricTone = METRIC_TONES[metric] || 'info';
  const formatMetricValue = (value: number | null) => {
    if (value == null) return '—';
    if (metric === 'percent') return formatQuotaPct(value);
    if (metric === 'cost') return formatCost(value);
    if (metric === 'requests') return String(value);
    return formatTokens(value);
  };

  const backToAccounts = () => navigate('/accounts');
  const providerLabel = providerNames[provider as keyof typeof providerNames] || provider || '账号';
  const subtitle = isUsageView
    ? `按自然${periodLabel}统计 Tokens、成本与请求数`
    : (data?.emptyReason === 'snapshot_only'
      ? '无窗口期，仅显示最新快照剩余额度'
      : '按窗口期统计额度消耗、Tokens 与成本');

  const toolbar = (
    <MobileToolbar
      start={<HudIconButton icon={<ArrowLeftOutlined />} label="返回账号" showLabel onClick={backToAccounts} />}
    >
      <HudIconButton
        icon={<RefreshIcon spinning={loading} />}
        label="刷新额度统计"
        tone="primary"
        loading={loading}
        onClick={() => { void reload(); }}
      />
    </MobileToolbar>
  );

  if (!provider || !accountRef) {
    return (
      <MobilePage toolbar={toolbar}>
        <EmptySignal
          title="NO ACCOUNT"
          description="当前账号缺少公开引用，请从账号列表重新进入"
          action={<HudIconButton icon={<ArrowLeftOutlined />} label="返回账号" showLabel onClick={backToAccounts} />}
        />
      </MobilePage>
    );
  }

  if (error) {
    return (
      <MobilePage toolbar={toolbar}>
        <HudCard code="ERR" title="额度统计加载失败" tone="err">
          <p className={styles.errorText} role="alert">{error}</p>
          <div className={styles.errorActions}>
            <HudIconButton icon={<ArrowLeftOutlined />} label="返回账号" showLabel onClick={backToAccounts} />
            <HudIconButton icon={<RefreshIcon spinning={false} />} label="重试" showLabel tone="primary" onClick={() => { void reload(); }} />
          </div>
        </HudCard>
      </MobilePage>
    );
  }

  return (
    <MobilePage toolbar={toolbar}>
      <HudCard
        code={String(provider).toUpperCase()}
        title="额度统计"
        extra={(
          <span className={`mhud-status ${current?.remainingPct == null ? 'mhud-tone--muted' : 'mhud-tone--ok'}`}>
            <span className={`hud-led${current?.remainingPct == null ? '' : ' hud-led--ok'}`} aria-hidden="true" />
            {formatQuotaPct(current?.remainingPct)}
          </span>
        )}
      >
        <div className={styles.accountHead}>
          <ProviderIcon provider={data?.provider || provider} size={22} />
          <span className={styles.accountDesc}>
            {providerLabel} · <span title={accountRef}>{shortenAccountRef(accountRef)}</span>
            <br />
            {subtitle}
          </span>
        </div>
      </HudCard>

      {!data && loading ? (
        <div className={styles.loading}><Spin /></div>
      ) : (
        <>
          <TelemetryGrid>
            <TelemetryTile
              label="当前剩余"
              value={formatQuotaPct(current?.remainingPct)}
              tone={current?.remainingPct == null ? 'muted' : 'ok'}
              led={current?.remainingPct == null ? undefined : 'live'}
              track={current?.remainingPct}
              sub={current?.resetAtMs
                ? `下次关窗 ${formatQuotaClock(current.resetAtMs)}`
                : (data?.emptyReason === 'snapshot_only' ? '无窗口期 · 最新快照' : '暂无活跃窗口')}
            />
            {isUsageView ? (
              <>
                <TelemetryTile
                  label="总 Tokens"
                  value={formatTokens(usageSummary?.totalTokens ?? 0)}
                  tone="info"
                  sub={`${periodLabel}均 ${usageSummary?.avgTokensPerBucket != null ? formatTokens(usageSummary.avgTokensPerBucket) : '—'}`}
                />
                <TelemetryTile
                  label="请求数"
                  value={usageSummary?.requestCount ?? 0}
                  tone="muted"
                  sub={`${usageSummary?.bucketCount ?? 0} 个${periodLabel}桶`}
                />
              </>
            ) : (
              <>
                <TelemetryTile
                  label="窗口数"
                  value={summary?.windowCount ?? 0}
                  tone="info"
                  sub={`有完整消耗数据 ${summary?.coveredWindowCount ?? 0}`}
                />
                <TelemetryTile
                  label="平均消耗"
                  value={formatQuotaPct(summary?.avgConsumedPct)}
                  tone="warn"
                  sub={`峰值 ${formatQuotaPct(summary?.maxConsumedPct)}`}
                />
              </>
            )}
            <TelemetryTile
              wide
              label="估算成本"
              value={costValue != null ? formatCost(costValue) : '—'}
              unit={costValue != null ? 'USD' : undefined}
              tone={costValue != null ? 'ok' : 'muted'}
              sub={isUsageView
                ? `统计范围 ${data?.range.rangeDays ?? rangeDays} 天`
                : `总 Tokens ${formatTokens(summary?.totalTokens ?? 0)} · 请求 ${summary?.requestCount ?? 0}`}
            />
          </TelemetryGrid>

          <HudSection title="筛选" code="FILTER">
            <HudChips
              ariaLabel="统计粒度"
              value={activeGranularity}
              onChange={(key) => setGranularity(key as QuotaStatsGranularity)}
              items={granularityItems}
            />
            {!isUsageView && hasWindowDetails ? (
              <HudChips
                ariaLabel="窗口长度"
                value={String(activeWindowMinutes)}
                onChange={(key) => {
                  // 不同窗口长度的 quotaKey 不通用，换维度时清掉 scope。
                  setScopeKey('');
                  setWindowMinutes(Number(key));
                }}
                items={dimensionOptions}
              />
            ) : null}
            <HudChips
              ariaLabel="统计范围"
              value={String(rangeDays)}
              onChange={(key) => setRangeDays(Number(key))}
              items={QUOTA_RANGE_OPTIONS.map((option) => ({ key: String(option.value), label: option.label }))}
            />
            {!isUsageView && scopeOptions.length > 1 && distinctScopeLabels > 1 ? (
              <Select
                className={styles.scopeSelect}
                value={scopeKey || undefined}
                options={scopeOptions}
                onChange={(value) => setScopeKey(value || '')}
                placeholder="额度范围"
                allowClear
              />
            ) : null}
            <p className={styles.note}>
              {isUsageView
                ? `按服务器本地时区切分自然${periodLabel}，只统计归属到本账号的网关调用。`
                : '窗口由关闭后的第一个真实请求锚定，不按日历滚动；空闲期的 reset 已剔除。'}
            </p>
          </HudSection>

          <HudSection title={isUsageView ? `${periodLabel}用量` : '窗口消耗'} code="CHART" count={rowCount}>
            {rowCount === 0 ? (
              <EmptySignal
                title="NO SIGNAL"
                description={(
                  <>
                    {getQuotaEmptyDescription(data?.emptyReason)}。{getQuotaEmptyHint(data?.emptyReason)}
                  </>
                )}
              />
            ) : (
              <>
                <HudChips
                  ariaLabel="图表口径"
                  value={metric}
                  onChange={(key) => {
                    if (isUsageView) setUsageMetric(key as UsageMetric);
                    else setWindowMetric(key as QuotaWindowMetric);
                  }}
                  items={isUsageView
                    ? [{ key: 'tokens', label: 'Tokens' }, { key: 'cost', label: '成本' }, { key: 'requests', label: '请求' }]
                    : [{ key: 'percent', label: '额度' }, { key: 'tokens', label: 'Tokens' }, { key: 'cost', label: '成本' }]}
                />
                <QuotaBarStrip
                  points={isUsageView ? usagePoints : windowPoints}
                  ariaLabel={isUsageView ? '额度用量柱带' : '额度窗口柱带'}
                  tone={metricTone}
                  formatValue={formatMetricValue}
                />
              </>
            )}
          </HudSection>

          {rowCount > 0 ? (
            <HudSection title="明细" code="ROWS" count={rowCount}>
              {isUsageView ? (
                <MonoList ariaLabel={`${periodLabel}用量明细`}>
                  {usageRows.map((bucket) => (
                    <SwipeRow key={bucket.index} ariaLabel={formatUsageBucketRange(bucket, activeGranularity)}>
                      <span className="mhud-row__main">
                        <span className="mhud-row__title">{formatUsageBucketRange(bucket, activeGranularity)}</span>
                        <span className="mhud-row__meta">{periodLabel}桶 · {bucket.requestCount} 次请求</span>
                      </span>
                      <span className="mhud-row__side">
                        <span className="mhud-tone--info">{formatTokens(bucket.tokens)}</span>
                        <span className={styles.cost}>{bucket.costKnown && bucket.costUsd != null ? formatCost(bucket.costUsd) : '成本未知'}</span>
                      </span>
                    </SwipeRow>
                  ))}
                </MonoList>
              ) : (
                <MonoList ariaLabel="额度窗口明细">
                  {windowRows.map((window) => {
                    const source = getWindowSourceMeta(window);
                    return (
                      <SwipeRow key={window.index} ariaLabel={formatQuotaWindowRange(window)}>
                        <span className="mhud-row__main">
                          <span className="mhud-row__title">{formatQuotaWindowRange(window)}</span>
                          <span className="mhud-row__meta">
                            消耗 {formatWindowConsumed(window)} · {source.label} · 样本 {window.sampleCount} · {window.requestCount} 次
                          </span>
                        </span>
                        <span className="mhud-row__side">
                          <span className="mhud-tone--info">{formatTokens(window.tokens)}</span>
                          <span className={styles.cost}>{window.costKnown && window.costUsd != null ? formatCost(window.costUsd) : '成本未知'}</span>
                        </span>
                      </SwipeRow>
                    );
                  })}
                </MonoList>
              )}
            </HudSection>
          ) : null}

          <p className={styles.footnote}>
            只统计能归属到本账号的网关用量；未归属的历史会话不计入。成本按当前价格快照估算。
            {isUsageView ? '' : ' 标注「仅重置事件 / 重建」的窗口为估算值。'}
          </p>
        </>
      )}
    </MobilePage>
  );
}

/** 刷新图标：loading 时旋转，但按钮本身由 HudIconButton 控制禁用与 aria-busy。 */
function RefreshIcon({ spinning }: { spinning: boolean }) {
  return <ReloadOutlined spin={spinning} />;
}
