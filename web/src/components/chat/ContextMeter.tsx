import { memo, useMemo, useState } from 'react';
import { Tooltip, Popover } from 'antd';
import { DashboardOutlined, CompressOutlined } from '@ant-design/icons';
import type { ChatMessage } from '@/types';
import { computeContextStats, DEFAULT_CONTEXT_MAX_TOKENS } from './context-meter-stats';
import styles from './composer/composer.module.css';

interface Props {
  messages: ChatMessage[];
  maxTokens?: number; // 默认 128k / 200k
  onCompactSuggest?: () => void;
}

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export const ContextMeter = memo(function ContextMeter({
  messages,
  maxTokens = DEFAULT_CONTEXT_MAX_TOKENS,
  onCompactSuggest,
}: Props) {
  const [open, setOpen] = useState(false);

  const stats = useMemo(() => computeContextStats(messages, maxTokens), [maxTokens, messages]);

  if (stats.usedTokens <= 0) return null;

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
        <span className={styles.contextMeterPercent}>{stats.percent}%</span>
      </div>
      <div className={styles.contextMeterBarBg}>
        <div
          className={styles.contextMeterBarFill}
          style={{
            width: `${stats.percent}%`,
            background: strokeColor,
          }}
        />
      </div>
      <div className={styles.contextMeterNumbers}>
        <span>已用 ~{stats.usedTokens > 1000 ? `${(stats.usedTokens / 1000).toFixed(1)}k` : stats.usedTokens} tok</span>
        <span>总量 {stats.contextWindow > 1000 ? `${Math.round(stats.contextWindow / 1000)}k` : stats.contextWindow} tok</span>
      </div>
      {stats.isWarning ? (
        <div className={styles.contextMeterWarning}>
          <span>⚠️ 占用已达 {stats.percent}% 高水位</span>
          {onCompactSuggest ? (
            <button
              type="button"
              className={styles.contextCompactBtn}
              onClick={() => {
                setOpen(false);
                onCompactSuggest();
              }}
            >
              <CompressOutlined /> 立即压缩 /compact
            </button>
          ) : null}
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
      <Tooltip title={`上下文占用 ~${stats.percent}%`} placement="top" mouseEnterDelay={0.3}>
        <button
          type="button"
          className={styles.contextMeterTrigger}
          aria-label={`上下文占用 ${stats.percent}%`}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
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
          </svg>
        </button>
      </Tooltip>
    </Popover>
  );
});

export default ContextMeter;
