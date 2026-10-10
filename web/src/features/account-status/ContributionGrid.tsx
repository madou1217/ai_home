import dayjs from 'dayjs';
import { Tooltip } from 'antd';
import { healthColorForBucket } from './health';
import { buildBucketTooltip } from './tooltip';
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

export default function ContributionGrid({ dayStarts, buckets, className }: Props) {
  const { cells, columns } = layoutCells(dayStarts, buckets);
  return (
    <div
      className={`account-status-grid${className ? ` ${className}` : ''}`}
      style={{ gridTemplateColumns: `repeat(${columns}, 10px)` }}
      role="img"
      aria-label="90 天健康状态立方体网格"
    >
      {cells.map((cell) => {
        const color = healthColorForBucket(cell.bucket);
        const tooltip = buildBucketTooltip(cell.startMs, cell.bucket, 'day');
        return (
          <Tooltip
            key={cell.startMs}
            title={(
              <div>
                <div>{tooltip.title}</div>
                <div>{tooltip.summaryLine}</div>
                {tooltip.failureLines.map((line) => <div key={line}>{line}</div>)}
              </div>
            )}
          >
            <span
              className={`account-status-grid__cell${color ? '' : ' account-status-grid__cell--none'}`}
              style={{ gridColumn: cell.column + 1, gridRow: cell.row + 1, ...(color ? { background: color } : {}) }}
            />
          </Tooltip>
        );
      })}
    </div>
  );
}
