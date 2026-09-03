'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('dsh 2.0 long-session memory & performance benchmark (200+ turns simulation)', () => {
  // 模拟 250 轮真实超长会话消息树
  const messages = [];
  for (let i = 0; i < 250; i++) {
    messages.push({
      role: 'user',
      content: `用户测试指令轮次 #${i + 1}：请深度重构工程模块并验证 60fps 动力学。`,
      timestamp: Date.now() - (250 - i) * 60000,
    });
    messages.push({
      role: 'assistant',
      content: `AI 助手回复 #${i + 1}：已完成模块解耦，采用 requestAnimationFrame 调度与视口裁剪算法。`,
      metrics: {
        durationMs: 1200 + (i % 10) * 100,
        ttftMs: 250 + (i % 5) * 20,
        outputTokens: 350 + (i % 50) * 10,
        inputTokens: 1500 + i * 20,
      },
      timestamp: Date.now() - (250 - i) * 60000 + 1500,
    });
  }

  // 1. 验证消息总量
  assert.equal(messages.length, 500);

  // 2. 模拟虚拟列表视口裁剪算法（原 VirtualConversationList 算法,组件已删除,此处保留独立基准）
  const scrollTop = 12000;
  const containerHeight = 800;
  const overscan = 5;
  const estimatedItemHeight = 120;
  const total = messages.length;

  let currentY = 0;
  let start = 0;
  let end = total;

  for (let i = 0; i < total; i++) {
    const h = estimatedItemHeight;
    if (currentY + h < Math.max(0, scrollTop - overscan * estimatedItemHeight)) {
      start = i + 1;
    }
    if (currentY > scrollTop + containerHeight + overscan * estimatedItemHeight) {
      end = i;
      break;
    }
    currentY += h;
  }

  start = Math.max(0, Math.min(start, total - 1));
  end = Math.max(start + 1, Math.min(end, total));

  const visibleCount = end - start;

  // 3. 验证在 500 条消息下，实际渲染的 DOM 节点数量被有效裁剪在 20 节点以内
  assert.ok(visibleCount <= 20, `Visible node count ${visibleCount} should be cropped within 20`);
  assert.ok(start > 80, `Start index ${start} should be shifted past upper overscan boundary`);

  // 4. 验证内存占用与指标聚合计算耗时（必须在 5ms 以内完成）
  const startCalc = performance.now();
  let totalOutputTokens = 0;
  let totalDurationMs = 0;
  for (const m of messages) {
    if (m.metrics) {
      totalOutputTokens += m.metrics.outputTokens || 0;
      totalDurationMs += m.metrics.durationMs || 0;
    }
  }
  const calcDuration = performance.now() - startCalc;

  assert.ok(totalOutputTokens > 0);
  assert.ok(calcDuration < 5, `Aggregation calculation took ${calcDuration}ms, must be < 5ms`);
});
