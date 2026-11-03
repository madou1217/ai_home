import { memo } from 'react';
import { healthColorForBucket } from './health';
import { useHealthHoverTip } from './useHealthHoverTip';
import type { BucketGranularity, OutcomeBucket } from './types';
import './account-status.css';

interface Props {
  /** 完整时间轴（dayStarts 或 hourStarts），升序 */
  starts: number[];
  /** 与 starts 等长、已对齐的桶（缺失桶为 null） */
  buckets: Array<OutcomeBucket | null>;
  granularity: BucketGranularity;
  size?: 'md' | 'sm' | 'xs';
  /** 单元格间距随容器宽度收窄（移动端 90 格时用），默认 false */
  fit?: boolean;
  className?: string;
  ariaLabel?: string;
}

/**
 * 状态条：一排等高细条，颜色 = 该桶成功率在健康色阶上的位置（绿 → 红连续过渡）。用于 90 天日条 / 24 小时时条，
 * 桌面全局区与表格 mini 列、移动端卡片共用同一份实现（尺寸靠 size/fit 调）。
 */
/**
 * 纯色块层：hover 只更新外层提示，不让 90 个 span 跟着重渲染（memo 隔离）。
 * data-health-cell 是外层 pointerover 委托的索引，不额外挂 90 个事件。
 */
const BucketCells = memo(function BucketCells({ starts, buckets }: Pick<Props, 'starts' | 'buckets'>) {
  return (
    <>
      {starts.map((startMs, index) => {
        const bucket = buckets[index] || null;
        const color = healthColorForBucket(bucket);
        return (
          <span
            key={startMs}
            data-health-cell={index}
            className={`account-status-strip__bar${color ? '' : ' account-status-strip__bar--none'}`}
            style={color ? { background: color } : undefined}
          />
        );
      })}
    </>
  );
});

export default function BucketStrip({ starts, buckets, granularity, size = 'md', fit, className, ariaLabel }: Props) {
  const sizeClass = size === 'sm' ? ' account-status-strip--sm' : size === 'xs' ? ' account-status-strip--xs' : '';
  const { onPointerOver, onPointerLeave, tooltip } = useHealthHoverTip(granularity, starts, buckets);
  return (
    <div
      className={`account-status-strip${sizeClass}${fit ? ' account-status-strip--fit' : ''}${className ? ` ${className}` : ''}`}
      role="img"
      aria-label={ariaLabel}
      onPointerOver={onPointerOver}
      onPointerLeave={onPointerLeave}
    >
      <BucketCells starts={starts} buckets={buckets} />
      {tooltip}
    </div>
  );
}
