import { memo, useMemo, useState } from 'react';
import { Tooltip, Popover } from 'antd';
import { DashboardOutlined, CompressOutlined } from '@ant-design/icons';
import type { ChatMessage } from '@/types';
import { computeContextStats, DEFAULT_CONTEXT_MAX_TOKENS } from './context-meter-stats';
import styles from './composer/composer.module.css';

interface Props {
  messages: ChatMessage[];
  maxTokens?: number; // 默认 128k / 200k
  usedTokens?: number;
  onCompactSuggest?: () => void;
  showLabel?: boolean;
  unknown?: boolean;
  stale?: boolean;
  compacting?: boolean;
}

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export const ContextMeter = memo(function ContextMeter({
  messages,
  maxTokens = DEFAULT_CONTEXT_MAX_TOKENS,
  usedTokens,
  onCompactSuggest,
  showLabel = false,
  unknown = false,
  stale = false,
  compacting = false,
}: Props) {
  const [open, setOpen] = useState(false);

  const stats = useMemo(() => computeContextStats(messages, maxTokens, usedTokens), [maxTokens, messages, usedTokens]);
  const approximate = usedTokens === undefined ? '~' : '';

  if (stats.usedTokens <= 0 && !unknown && !stale && !compacting && !onCompactSuggest) return null;

  const strokeColor = stats.isCritical
    ? '#ef4444'
    : stats.isWarning
    ? '#f59e0b'
    : 'var(--color-primary, #3b82f6)';

  const content = (
    <div className={styles.contextMeterPopover}>
      <div className={styles.contextMeterHeader}>
        <span className={styles.contextMeterTitle}>
          <DashboardOutlined /> 上下文占用
        </span>
        <span className={styles.contextMeterPercent}>{compacting ? '…' : stale || unknown ? '—' : `${stats.percent}%`}</span>
      </div>
      {!unknown && !stale ? <div className={styles.contextMeterBarBg}>
        <div
          className={styles.contextMeterBarFill}
          style={{
            width: `${stats.percent}%`,
            background: strokeColor,
          }}
        />
      </div> : null}
      {compacting ? <div className={styles.contextMeterNumbers}>正在压缩当前上下文…</div>
        : stale ? <div className={styles.contextMeterNumbers}>上下文已压缩，下一轮收到用量后更新占用</div>
        : unknown ? <div className={styles.contextMeterNumbers}>运行时尚未返回上下文用量</div> : <div className={styles.contextMeterNumbers}>
        <span>已用 {approximate}{stats.usedTokens > 1000 ? `${(stats.usedTokens / 1000).toFixed(1)}k` : stats.usedTokens} tok</span>
        <span>总量 {stats.contextWindow > 1000 ? `${Math.round(stats.contextWindow / 1000)}k` : stats.contextWindow} tok</span>
      </div>}
      {onCompactSuggest ? (
        <div className={styles.contextMeterWarning} data-warning={stats.isWarning || undefined}>
          {stats.isWarning ? <span>占用已达 {stats.percent}% 高水位</span> : null}
          <button
            type="button"
            className={styles.contextCompactBtn}
            onClick={() => {
              setOpen(false);
              onCompactSuggest();
            }}
          >
            <CompressOutlined /> 压缩当前上下文
          </button>
        </div>
      ) : null}
    </div>
  );

  return (
    <Popover
      content={content}
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="topRight"
      overlayClassName={styles.contextMeterOverlay}
    >
      <Tooltip open={open ? false : undefined}
        title={compacting ? '正在压缩上下文' : stale ? '上下文已压缩，用量待更新'
        : unknown ? '上下文用量待统计' : `上下文占用 ${approximate}${stats.percent}%`}
        placement="top" mouseEnterDelay={0.3}>
        <button
          type="button"
          className={styles.contextMeterTrigger}
          aria-label={compacting ? '正在压缩上下文' : stale ? '上下文已压缩，用量待更新'
            : unknown ? '上下文用量待统计' : `上下文占用 ${stats.percent}%`}
          data-labeled={showLabel || undefined}
        >
          {compacting || stale || unknown ? (
            <CompressOutlined aria-hidden="true" />
          ) : <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <circle
              cx="8"
              cy="8"
              r={RADIUS}
              fill="none"
              stroke="rgba(0, 0, 0, 0.08)"
              strokeWidth="2"
            />
            <circle
              cx="8"
              cy="8"
              r={RADIUS}
              fill="none"
              stroke={strokeColor}
              strokeWidth="2"
              strokeDasharray={`${(CIRCUMFERENCE * stats.percent) / 100} ${CIRCUMFERENCE}`}
              strokeLinecap="round"
              transform="rotate(-90 8 8)"
            />
          </svg>}
          {showLabel ? <span>{compacting ? '正在压缩' : stale ? '上下文已压缩'
            : unknown ? '上下文待统计' : `上下文 ${approximate}${stats.percent}%`}</span> : null}
        </button>
      </Tooltip>
    </Popover>
  );
});

export default ContextMeter;
