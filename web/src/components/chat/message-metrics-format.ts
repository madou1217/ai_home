import type { ChatMessageMetrics } from '@/types';

/**
 * 格式化持续总耗时（如：6.3秒 / 17秒 / 1分25秒）
 * 10秒以内保留 1 位小数，与 TTFT 精度对齐，避免四舍五入造成的「用时 6秒 首 token 6.2秒」视觉矛盾
 */
export function formatDurationLabel(ms?: number): string {
  if (ms == null || Number.isNaN(ms) || ms < 0) return '';
  const seconds = ms / 1000;
  if (seconds < 10) {
    const formatted = (Math.round(seconds * 10) / 10).toFixed(1).replace(/\.0$/, '');
    return `${formatted}秒`;
  }
  const totalSeconds = Math.round(seconds);
  if (totalSeconds < 60) {
    return `${totalSeconds}秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return remainingSeconds > 0 ? `${minutes}分${remainingSeconds}秒` : `${minutes}分钟`;
}

/**
 * 格式化首 Token / 首字耗时（如：1.4秒 / 6.2秒 / 14秒）
 */
export function formatTtftLabel(ms?: number): string {
  if (ms == null || Number.isNaN(ms) || ms < 0) return '';
  const seconds = ms / 1000;
  if (seconds < 10) {
    const formatted = (Math.round(seconds * 10) / 10).toFixed(1).replace(/\.0$/, '');
    return `${formatted}秒`;
  }
  return `${Math.round(seconds)}秒`;
}

/**
 * 格式化生成速度（如：60 tok/s）
 */
export function formatTokensPerSecLabel(tokensPerSec?: number): string {
  if (tokensPerSec == null || Number.isNaN(tokensPerSec) || tokensPerSec <= 0) return '';
  const rounded = Math.round(tokensPerSec);
  return `${rounded} tok/s`;
}

/**
 * 估算文本的 Token 数量（用于没有上游 usage 时的兜底）
 * 中文字符/标点约为 1.5 字符/token，英文及代码约为 4 字符/token
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  let cjkCount = 0;
  let otherCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // CJK Unified Ideographs & common Asian punctuation
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjkCount++;
    } else {
      otherCount++;
    }
  }
  const estimated = Math.ceil(cjkCount / 1.5 + otherCount / 4);
  return Math.max(1, estimated);
}

/**
 * 计算完整的指标结果对象
 */
export function calculateMessageMetrics(params: {
  startTime: number;
  firstTokenTime?: number;
  completedTime?: number;
  outputTokens?: number;
  text?: string;
}): ChatMessageMetrics | undefined {
  const { startTime, firstTokenTime, completedTime = Date.now(), text = '' } = params;
  if (!startTime || startTime <= 0) return undefined;

  let durationMs = Math.max(0, completedTime - startTime);
  let ttftMs = firstTokenTime && firstTokenTime >= startTime
    ? Math.max(0, firstTokenTime - startTime)
    : undefined;

  // 严格守卫：首 token 耗时不可能大于总耗时（消除时钟/时间戳微小抖动）
  if (ttftMs != null && ttftMs > durationMs) {
    durationMs = ttftMs;
  }

  const tokens = params.outputTokens != null && params.outputTokens > 0
    ? params.outputTokens
    : (text ? estimateTokenCount(text) : undefined);

  let tokensPerSec: number | undefined;
  if (tokens != null && tokens > 0) {
    // 优先采用解码时间 (duration - ttft) 来算速率，若解码时间极短（如单次返回），采用总耗时
    const decodeMs = (ttftMs != null && durationMs > ttftMs && (durationMs - ttftMs) >= 500)
      ? durationMs - ttftMs
      : durationMs;
    const decodeSeconds = Math.max(0.5, decodeMs / 1000);
    tokensPerSec = Math.round(tokens / decodeSeconds);
  }

  return {
    durationMs,
    ttftMs,
    outputTokens: tokens,
    tokensPerSec,
  };
}
