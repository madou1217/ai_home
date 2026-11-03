import dayjs from 'dayjs';
import { memo, useMemo } from 'react';
import { healthColorForBucket } from './health';
import { useHealthHoverTip } from './useHealthHoverTip';
import type { OutcomeBucket } from './types';
import './account-status.css';

interface Props {
  /** 90 个本地零点时间戳，升序 */
  dayStarts: number[];
  /** 与 dayStarts 等长、已对齐的桶（缺失为 null） */
  buckets: Array<OutcomeBucket | null>;
  className?: string;
}

interface Cell {
  startMs: number;
  bucket: OutcomeBucket | null;
  column: number;
  row: number;
}

/** 90 天 → GitHub 提交图风格布局：列 = 周，行 = 星期（0=周日 … 6=周六）。 */
function layoutCells(dayStarts: number[], buckets: Array<OutcomeBucket | null>): { cells: Cell[]; columns: number } {
  if (dayStarts.length === 0) return { cells: [], columns: 0 };
  const first = dayjs(dayStarts[0]);
  const firstWeekStart = first.subtract(first.day(), 'day');
  let maxColumn = 0;
  const cells = dayStarts.map((startMs, index) => {
    const d = dayjs(startMs);
    const row = d.day();
    const column = Math.floor(d.diff(firstWeekStart, 'day') / 7);
    if (column > maxColumn) maxColumn = column;
    return { startMs, bucket: buckets[index] || null, column, row };
  });
  return { cells, columns: maxColumn + 1 };
}

const GridCells = memo(function GridCells({ dayStarts, buckets }: Pick<Props, 'dayStarts' | 'buckets'>) {
  const { cells, columns } = useMemo(() => layoutCells(dayStarts, buckets), [dayStarts, buckets]);
  return (
    <div
      className="account-status-grid"
      style={{ gridTemplateColumns: `repeat(${columns}, 10px)` }}
    >
      {cells.map((cell, index) => {
        const color = healthColorForBucket(cell.bucket);
        return (
          <span
            key={cell.startMs}
            data-health-cell={index}
            className={`account-status-grid__cell${color ? '' : ' account-status-grid__cell--none'}`}
            style={{ gridColumn: cell.column + 1, gridRow: cell.row + 1, ...(color ? { background: color } : {}) }}
          />
        );
      })}
    </div>
  );
});

export default function ContributionGrid({ dayStarts, buckets, className }: Props) {
  const { onPointerOver, onPointerLeave, tooltip } = useHealthHoverTip('day', dayStarts, buckets);
  return (
    <div
      className={`account-status-grid-host${className ? ` ${className}` : ''}`}
      role="img"
      aria-label="90 天健康状态立方体网格"
      onPointerOver={onPointerOver}
      onPointerLeave={onPointerLeave}
    >
      <GridCells dayStarts={dayStarts} buckets={buckets} />
      {tooltip}
    </div>
  );
}
