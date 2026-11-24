import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { HudTone } from '@/mobile/ui';
import styles from './MobileAccountQuota.module.css';

export interface QuotaBarPoint {
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

/**
 * 紧凑柱带：把窗口 / 自然周期画成等宽柱（纯 CSS，不加载图表库）。
 * 手指横向拖动逐柱读数；键盘左右方向键同样可用。
 */
export default function QuotaBarStrip({ points, ariaLabel, tone, formatValue }: QuotaBarStripProps) {
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
