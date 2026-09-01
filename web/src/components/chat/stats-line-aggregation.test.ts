import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { aggregateSessionStats } from './stats-line-aggregation';
import type { ChatMessage } from '@/types';

/** 构造 N 轮(user+assistant)带指标的会话消息 */
function buildMessages(turns: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ id: `u-${i}`, role: 'user', content: `问题 ${i}` } as ChatMessage);
    messages.push({
      id: `a-${i}`,
      role: 'assistant',
      content: `回答 ${i}`,
      metrics: { durationMs: 3200 + i, ttftMs: 800 + i, outputTokens: 500 + i, inputTokens: 1200 + i },
    } as ChatMessage);
  }
  return messages;
}

describe('aggregateSessionStats', () => {
  it('聚合轮次/耗时/首字/Token 正确', () => {
    const stats = aggregateSessionStats(buildMessages(3));
    assert.equal(stats.turns, 3);
    assert.equal(stats.assistantCount, 3);
    assert.equal(stats.totalOutputTokens, 1503);
    assert.equal(stats.totalInputTokens, 3603);
    assert.ok(stats.hasData);
  });

  it('空消息列表返回 hasData=false', () => {
    assert.equal(aggregateSessionStats([]).hasData, false);
  });

  // F21 性能基准:500 条消息聚合耗时 < 5ms(dsh 2.0 吸收清单验收线)
  it('基准:500 条消息聚合 < 5ms', () => {
    const messages = buildMessages(250); // 250 轮 = 500 条
    aggregateSessionStats(messages); // 预热 JIT
    const start = performance.now();
    const stats = aggregateSessionStats(messages);
    const elapsed = performance.now() - start;
    assert.ok(stats.hasData);
    assert.ok(elapsed < 5, `500 条聚合耗时 ${elapsed.toFixed(3)}ms,应 < 5ms`);
  });
});
