import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDurationLabel,
  formatTtftLabel,
  formatTokensPerSecLabel,
  estimateTokenCount,
  calculateMessageMetrics,
} from './message-metrics-format';

describe('message-metrics-format', () => {
  describe('formatDurationLabel', () => {
    it('formats milliseconds under 1 second', () => {
      assert.equal(formatDurationLabel(500), '0.5秒');
    });

    it('formats seconds under 1 minute', () => {
      assert.equal(formatDurationLabel(17000), '17秒');
      assert.equal(formatDurationLabel(1200), '1.2秒');
    });

    it('formats minutes and seconds for longer runs', () => {
      assert.equal(formatDurationLabel(60000), '1分钟');
      assert.equal(formatDurationLabel(85000), '1分25秒');
      assert.equal(formatDurationLabel(130000), '2分10秒');
    });

    it('handles undefined or negative values gracefully', () => {
      assert.equal(formatDurationLabel(undefined), '');
      assert.equal(formatDurationLabel(-100), '');
    });
  });

  describe('formatTtftLabel', () => {
    it('formats sub-10s TTFT with 1 decimal place', () => {
      assert.equal(formatTtftLabel(1400), '1.4秒');
      assert.equal(formatTtftLabel(400), '0.4秒');
    });

    it('formats >=10s TTFT as whole seconds', () => {
      assert.equal(formatTtftLabel(14000), '14秒');
    });

    it('handles empty / undefined values', () => {
      assert.equal(formatTtftLabel(undefined), '');
    });
  });

  describe('formatTokensPerSecLabel', () => {
    it('formats tok/s with unit', () => {
      assert.equal(formatTokensPerSecLabel(60), '60 tok/s');
      assert.equal(formatTokensPerSecLabel(59.8), '60 tok/s');
      assert.equal(formatTokensPerSecLabel(0), '');
      assert.equal(formatTokensPerSecLabel(undefined), '');
    });
  });

  describe('estimateTokenCount', () => {
    it('estimates tokens for English and Chinese correctly', () => {
      assert.ok(estimateTokenCount('Hello world!') > 0);
      assert.ok(estimateTokenCount('你好世界') > 0);
    });
  });

  describe('calculateMessageMetrics', () => {
    it('calculates metrics properly from timestamps and text', () => {
      const startTime = 10000;
      const firstTokenTime = 11400; // TTFT 1.4s
      const completedTime = 27000; // Duration 17s
      const metrics = calculateMessageMetrics({
        startTime,
        firstTokenTime,
        completedTime,
        outputTokens: 936,
      });

      assert.ok(metrics);
      assert.equal(metrics?.durationMs, 17000);
      assert.equal(metrics?.ttftMs, 1400);
      assert.equal(metrics?.outputTokens, 936);
      assert.equal(metrics?.tokensPerSec, 60); // 936 / 15.6s = 60
    });
  });
});
