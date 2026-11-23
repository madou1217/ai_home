import { Input, Typography } from 'antd';

export const UPSTREAM_429_RETRY_LIMITS = {
  minSteps: 1,
  maxSteps: 24,
  minStepSeconds: 1,
  maxStepSeconds: 3600,
  // 累计等待没有硬上限；超过建议值时只提示，不阻止保存。
  recommendedTotalSeconds: 1800
} as const;

export interface ParsedBackoffSchedule {
  steps: number[] | null;
  totalSeconds: number;
  error: string | null;
}

export function formatBackoffSeconds(steps: readonly number[] | undefined | null): string {
  if (!Array.isArray(steps) || steps.length === 0) return '';
  return steps.join(', ');
}

export function parseBackoffSecondsText(
  text: string,
  options: { allowEmpty?: boolean } = {}
): ParsedBackoffSchedule {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    if (options.allowEmpty) {
      return { steps: [], totalSeconds: 0, error: null };
    }
    return {
      steps: null,
      totalSeconds: 0,
      error: '请至少输入 1 个整数秒数（例如 30 或 10, 30, 60）'
    };
  }
  const rawParts = trimmed.split(/[,，\s]+/).filter(Boolean);
  if (rawParts.length < UPSTREAM_429_RETRY_LIMITS.minSteps) {
    return {
      steps: null,
      totalSeconds: 0,
      error: '请至少输入 1 个整数秒数'
    };
  }
  if (rawParts.length > UPSTREAM_429_RETRY_LIMITS.maxSteps) {
    return {
      steps: null,
      totalSeconds: 0,
      error: `最多支持 ${UPSTREAM_429_RETRY_LIMITS.maxSteps} 次重试`
    };
  }
  const steps: number[] = [];
  let totalSeconds = 0;
  for (let i = 0; i < rawParts.length; i += 1) {
    const token = rawParts[i];
    if (!/^\d+$/.test(token)) {
      return {
        steps: null,
        totalSeconds: 0,
        error: `第 ${i + 1} 项“${token}”必须是正整数秒`
      };
    }
    const seconds = Number(token);
    if (
      !Number.isInteger(seconds) ||
      seconds < UPSTREAM_429_RETRY_LIMITS.minStepSeconds ||
      seconds > UPSTREAM_429_RETRY_LIMITS.maxStepSeconds
    ) {
      return {
        steps: null,
        totalSeconds: 0,
        error: `第 ${i + 1} 项必须在 ${UPSTREAM_429_RETRY_LIMITS.minStepSeconds}–${UPSTREAM_429_RETRY_LIMITS.maxStepSeconds} 秒之间`
      };
    }
    totalSeconds += seconds;
    steps.push(seconds);
  }
  return { steps, totalSeconds, error: null };
}

interface BackoffScheduleInputProps {
  id?: string;
  ariaLabel?: string;
  value: string;
  disabled?: boolean;
  allowEmpty?: boolean;
  placeholder?: string;
  onChange: (nextText: string) => void;
  onPressEnter?: () => void;
}

/**
 * 逗号分隔的 429 退避秒数输入：每项为该次额外重试前的等待秒数（非累计时间）。
 */
export function BackoffScheduleInput({
  id,
  ariaLabel = '退避等待队列（秒）',
  value,
  disabled = false,
  allowEmpty = false,
  placeholder = '30 或 10, 30, 60',
  onChange,
  onPressEnter
}: BackoffScheduleInputProps) {
  const parsed = parseBackoffSecondsText(value, { allowEmpty });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Input
        id={id}
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        status={parsed.error ? 'error' : undefined}
        onChange={(event) => onChange(event.target.value)}
        onPressEnter={onPressEnter}
      />
      {parsed.error ? (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          {parsed.error}
        </Typography.Text>
      ) : parsed.steps && parsed.steps.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            共 {parsed.steps.length} 次额外重试（顺序等待 {parsed.steps.map((s) => `${s}s`).join(' → ')}，总计 {parsed.totalSeconds}s）
          </Typography.Text>
          {parsed.totalSeconds > UPSTREAM_429_RETRY_LIMITS.recommendedTotalSeconds ? (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              累计等待超过 {UPSTREAM_429_RETRY_LIMITS.recommendedTotalSeconds} 秒，通常意义有限；仍可保存。
            </Typography.Text>
          ) : null}
        </div>
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          留空表示沿用全局退避队列；每项为该次重试前等待秒数（1–{UPSTREAM_429_RETRY_LIMITS.maxStepSeconds}s，最多 {UPSTREAM_429_RETRY_LIMITS.maxSteps} 项；累计超过 {UPSTREAM_429_RETRY_LIMITS.recommendedTotalSeconds}s 只提示，不阻止保存）
        </Typography.Text>
      )}
    </div>
  );
}
