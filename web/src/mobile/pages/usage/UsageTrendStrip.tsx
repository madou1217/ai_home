import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { ModelUsageTrend, ModelUsageTrendPoint } from '@/types';
import { formatCost, formatTokens } from '@/features/model-usage/model-usage-presentation';
import { buildTrendSlots, formatTrendAxisTime } from '@/features/model-usage/model-usage-query';
import { EmptySignal, HudChips, type HudTone } from '@/mobile/ui';
import styles from '../MobileUsage.module.css';

type TrendMetric = 'tokens' | 'cost' | 'cache';

// 与桌面 UsageTrendChart 同样的三种口径：Tokens / 成本 / 缓存率
const METRICS: Array<{ key: TrendMetric; label: string; tone: HudTone }> = [
  { key: 'tokens', label: 'Tokens', tone: 'info' },
  { key: 'cost', label: '成本', tone: 'ok' },
  { key: 'cache', label: '缓存率', tone: 'warn' }
];

function valueOf(point: ModelUsageTrendPoint | null, metric: TrendMetric): number | null {
  if (!point) return null;
  if (metric === 'cost') return Number(point.costUsd) || 0;
  if (metric === 'cache') return point.cacheHitRate == null ? null : Number(point.cacheHitRate) * 100;
  return Number(point.totalTokens) || 0;
}

function formatValue(value: number | null, metric: TrendMetric) {
  if (value == null) return '-';
  if (metric === 'cost') return formatCost(value);
  if (metric === 'cache') return `${value.toFixed(1)}%`;
  return formatTokens(value);
}

/**
 * 紧凑趋势条：把 dashboard.trend 的时间槽画成等宽柱（纯 CSS，不加载图表库）。
 * 手指在柱带上横向拖动即可逐槽读数；键盘可用左右方向键。
 */
export default function UsageTrendStrip({ trend }: { trend: ModelUsageTrend }) {
  const [metric, setMetric] = useState<TrendMetric>('tokens');
  const [selected, setSelected] = useState<number | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const slots = useMemo(() => buildTrendSlots(trend), [trend]);
  const values = useMemo(() => slots.map((point) => valueOf(point, metric)), [metric, slots]);

  useEffect(() => {
    setSelected(null);
  }, [trend]);

  const peakIndex = useMemo(() => {
    let best = -1;
    values.forEach((value, index) => {
      if (value == null) return;
      if (best < 0 || value > (values[best] ?? 0)) best = index;
    });
    return best;
  }, [values]);

  const scale = metric === 'cache' ? 100 : Math.max(peakIndex >= 0 ? values[peakIndex] ?? 0 : 0, 0);
  const tone = METRICS.find((item) => item.key === metric)?.tone || 'info';

  if (slots.length === 0) {
    return <EmptySignal title="NO TREND" description="当前范围内暂无趋势数据。" />;
  }

  const slotTime = (index: number) => slots[index]?.bucketStartMs || trend.fromMs + index * trend.bucketMs;
  const readoutIndex = selected ?? (peakIndex >= 0 ? peakIndex : slots.length - 1);
  const readoutLabel = selected == null ? (peakIndex >= 0 ? '峰值' : '最新') : '所选';

  const pickFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = stripRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    setSelected(Math.max(0, Math.min(slots.length - 1, Math.floor(ratio * slots.length))));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.key === 'ArrowLeft' ? -1 : 1;
    setSelected((current) => Math.max(0, Math.min(slots.length - 1, (current ?? readoutIndex) + step)));
  };

  return (
    <div className={styles.trend}>
      <HudChips
        ariaLabel="趋势口径"
        value={metric}
        onChange={(key) => setMetric(key as TrendMetric)}
        items={METRICS.map((item) => ({ key: item.key, label: item.label }))}
      />
      <div className={styles.trendReadout} aria-live="polite">
        <span className="hud-label">{readoutLabel} · {formatTrendAxisTime(slotTime(readoutIndex), trend.bucketMs)}</span>
        <span className={`${styles.trendValue} mhud-tone--${tone}`}>{formatValue(values[readoutIndex] ?? null, metric)}</span>
      </div>
      <div
        ref={stripRef}
        className={styles.trendStrip}
        role="slider"
        tabIndex={0}
        aria-label="模型用量时间趋势"
        aria-valuemin={0}
        aria-valuemax={slots.length - 1}
        aria-valuenow={readoutIndex}
        aria-valuetext={`${formatTrendAxisTime(slotTime(readoutIndex), trend.bucketMs)} ${formatValue(values[readoutIndex] ?? null, metric)}`}
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
        {values.map((value, index) => {
          const height = value == null || scale <= 0 ? 0 : Math.max(2, Math.round((value / scale) * 100));
          return (
            <span
              key={index}
              className={`${styles.trendBar}${index === readoutIndex ? ` ${styles.trendBarActive}` : ''}`}
              aria-hidden="true"
            >
              {value == null ? (
                <span className={styles.trendGap} />
              ) : (
                <span className={`${styles.trendFill} mhud-bg--${tone}`} style={{ height: `${height}%` }} />
              )}
            </span>
          );
        })}
      </div>
      <div className={styles.trendAxis} aria-hidden="true">
        <span>{formatTrendAxisTime(slotTime(0), trend.bucketMs)}</span>
        <span>{formatTrendAxisTime(slotTime(slots.length - 1), trend.bucketMs)}</span>
      </div>
    </div>
  );
}
