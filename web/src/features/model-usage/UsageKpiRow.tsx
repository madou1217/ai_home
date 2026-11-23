import { memo } from 'react';
import {
  formatCacheRate,
  formatCost,
  formatTokens
} from './model-usage-presentation';
import type { ModelUsageStats } from '@/types';

export interface UsageKpiRowProps {
  stats: ModelUsageStats;
  totalCacheTokens: number;
  overallCacheHitRate: number | null;
}

/**
 * 模型用量核心指标条：紧凑 6 格等分，标签使用清晰可读字号，数值等宽防溢出，
 * 窄屏自动折行避免截断。
 */
export const UsageKpiRow = memo(function UsageKpiRow({
  stats,
  totalCacheTokens,
  overallCacheHitRate
}: UsageKpiRowProps) {
  return (
    <section className="usage-kpi-rail" aria-label="核心用量指标">
      <div className="usage-kpi-item usage-kpi-item--primary">
        <span className="usage-kpi-label">总 Tokens</span>
        <strong className="usage-kpi-value" title={formatTokens(stats.totalTokens)}>
          {formatTokens(stats.totalTokens)}
        </strong>
        <small className="usage-kpi-sub">
          {stats.totalCalls} 次调用 · {stats.totalSessions} 个会话
        </small>
      </div>
      <div className="usage-kpi-item">
        <span className="usage-kpi-label">输入</span>
        <strong className="usage-kpi-value" title={formatTokens(stats.inputTokens)}>
          {formatTokens(stats.inputTokens)}
        </strong>
        <small className="usage-kpi-sub">不含缓存读写</small>
      </div>
      <div className="usage-kpi-item">
        <span className="usage-kpi-label">输出</span>
        <strong className="usage-kpi-value" title={formatTokens(stats.outputTokens)}>
          {formatTokens(stats.outputTokens)}
        </strong>
        <small className="usage-kpi-sub">推理 {formatTokens(stats.reasoningOutputTokens)}</small>
      </div>
      <div className="usage-kpi-item">
        <span className="usage-kpi-label">缓存</span>
        <strong className="usage-kpi-value" title={formatTokens(totalCacheTokens)}>
          {formatTokens(totalCacheTokens)}
        </strong>
        <small className="usage-kpi-sub">
          读 {formatTokens(stats.cacheReadInputTokens)} · 写 {formatTokens(stats.cacheCreationInputTokens)}
        </small>
      </div>
      <div className="usage-kpi-item">
        <span className="usage-kpi-label">缓存命中率</span>
        <strong className="usage-kpi-value" title={formatCacheRate(overallCacheHitRate)}>
          {formatCacheRate(overallCacheHitRate)}
        </strong>
        <small className="usage-kpi-sub">读缓存 / 全部输入侧</small>
      </div>
      <div className="usage-kpi-item usage-kpi-item--cost">
        <span className="usage-kpi-label">估算成本</span>
        <strong className="usage-kpi-value" title={formatCost(stats.totalCostUsd)}>
          {formatCost(stats.totalCostUsd)}
        </strong>
        <small className="usage-kpi-sub">USD · 按当前价格快照</small>
      </div>
    </section>
  );
});

export default UsageKpiRow;
