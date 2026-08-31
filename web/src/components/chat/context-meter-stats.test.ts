import { describe, expect, test } from 'bun:test';
import {
  computeContextStats,
  estimateContextTokens,
  CONTEXT_WARNING_THRESHOLD_PERCENT,
} from './context-meter-stats';
import type { ChatMessage } from '@/types';

describe('estimateContextTokens', () => {
  test('优先使用精确 metrics 累计', () => {
    const messages = [
      { metrics: { inputTokens: 1000, outputTokens: 500 } },
      { metrics: { inputTokens: 2000, outputTokens: 800 } },
    ] as unknown as ChatMessage[];
    expect(estimateContextTokens(messages)).toBe(4300);
  });

  test('无 metrics 时按字符数粗估(~1.5 字符/token)', () => {
    const messages = [{ content: 'a'.repeat(150) }] as unknown as ChatMessage[];
    expect(estimateContextTokens(messages)).toBe(100);
  });

  test('空消息列表返回 0', () => {
    expect(estimateContextTokens([])).toBe(0);
  });
});

describe('computeContextStats', () => {
  const buildMessages = (tokens: number): ChatMessage[] =>
    [{ metrics: { inputTokens: tokens } }] as unknown as ChatMessage[];

  test('按动态 maxTokens 换算百分比', () => {
    const stats = computeContextStats(buildMessages(655360), 1048576);
    expect(stats.contextWindow).toBe(1048576);
    expect(stats.percent).toBe(63);
  });

  test('达到 60% 高水位即告警', () => {
    expect(CONTEXT_WARNING_THRESHOLD_PERCENT).toBe(60);
    expect(computeContextStats(buildMessages(60000), 100000).isWarning).toBe(true);
    expect(computeContextStats(buildMessages(58000), 100000).isWarning).toBe(false);
  });

  test('90% 为临界档', () => {
    expect(computeContextStats(buildMessages(90000), 100000).isCritical).toBe(true);
    expect(computeContextStats(buildMessages(80000), 100000).isCritical).toBe(false);
  });
});
