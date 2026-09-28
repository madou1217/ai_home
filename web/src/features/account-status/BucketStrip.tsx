import { Tooltip } from 'antd';
import { tierForBucket } from './health';
import { buildBucketTooltip } from './tooltip';
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
 * 状态条：一排等高细条，颜色 = 该桶健康档位。用于 90 天日条 / 24 小时时条，
 * 桌面全局区与表格 mini 列、移动端卡片共用同一份实现（尺寸靠 size/fit 调）。
 */
export default function BucketStrip({ starts, buckets, granularity, size = 'md', fit, className, ariaLabel }: Props) {
  const sizeClass = size === 'sm' ? ' account-status-strip--sm' : size === 'xs' ? ' account-status-strip--xs' : '';
  return (
    <div
      className={`account-status-strip${sizeClass}${fit ? ' account-status-strip--fit' : ''}${className ? ` ${className}` : ''}`}
      role="img"
      aria-label={ariaLabel}
    >
      {starts.map((startMs, index) => {
        const bucket = buckets[index] || null;
        const tier = tierForBucket(bucket);
        const tooltip = buildBucketTooltip(startMs, bucket, granularity);
        return (
          <Tooltip
            key={startMs}
            title={(
              <div>
                <div>{tooltip.title}</div>
                <div>{tooltip.summaryLine}</div>
                {tooltip.failureLines.map((line) => <div key={line}>{line}</div>)}
              </div>
            )}
          >
            <span className={`account-status-strip__bar account-status-strip__bar--${tier}`} />
          </Tooltip>
        );
      })}
    </div>
  );
}
