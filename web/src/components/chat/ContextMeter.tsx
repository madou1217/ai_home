import { memo, useMemo, useState } from 'react';
import { Tooltip, Popover } from 'antd';
import { DashboardOutlined, CompressOutlined } from '@ant-design/icons';
import type { ChatMessage } from '@/types';
import styles from './chat.module.css';

interface Props {
  messages: ChatMessage[];
  maxTokens?: number; // 默认 128k / 200k
  onCompactSuggest?: () => void;
}

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export const ContextMeter = memo(function ContextMeter({
  messages,
  maxTokens = 128000,
  onCompactSuggest,
}: Props) {
  const [open, setOpen] = useState(false);

  const stats = useMemo(() => {
    let totalOutput = 0;
    let totalInput = 0;
    for (const msg of messages) {
      if (msg.metrics?.outputTokens) totalOutput += msg.metrics.outputTokens;
      if (msg.metrics?.inputTokens) totalInput += msg.metrics.inputTokens;
    }
    // 估算当前对话累积 token：未带精确 metrics 时按字符粗算 (~1.5 字符/token)
    let approxTotal = totalOutput + totalInput;
    if (approxTotal === 0 && messages.length > 0) {
      const charCount = messages.reduce((acc, m) => acc + String(m.content || '').length, 0);
      approxTotal = Math.round(charCount / 1.5);
    }

    const percent = Math.min(100, Math.round((approxTotal / maxTokens) * 100));
    const isWarning = percent >= 80;
    return {
      usedTokens: approxTotal,
      contextWindow: maxTokens,
      percent,
      isWarning,
    };
  }, [maxTokens, messages]);

  if (stats.usedTokens <= 0) return null;

  const strokeColor = stats.isWarning
    ? '#f59e0b'
    : stats.percent > 90
    ? '#ef4444'
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
