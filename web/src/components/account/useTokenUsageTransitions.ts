import { useEffect, useRef, useState } from 'react';

import type { TokenUsageDimension, TokenUsageMetric, TokenUsageValue } from './token-usage-periods';

/** 一根正在离场的柱子：仍按它消失前的槽位绘制，由 CSS 把它吸回前一格。 */
export interface TokenUsageGhost {
  key: TokenUsageDimension;
  label: string;
  value: TokenUsageValue;
  index: number;
}

interface TokenUsageTransitions {
  entering: ReadonlySet<TokenUsageDimension>;
  ghosts: readonly TokenUsageGhost[];
  /** 留下来但换了槽位的格子：值是"往左挪了几个槽"，动画从旧位置滑到新位置。 */
  shifts: ReadonlyMap<TokenUsageDimension, number>;
}

const STILL: TokenUsageTransitions = {
  entering: new Set(),
  ghosts: [],
  shifts: new Map()
};

/**
 * 折叠是数据驱动的：用量一变，某一格可能直接消失或凭空出现，它右边的格子还要整体左移。
 * 直接增删节点会"闪现"，看不出发生了什么，所以这里把上一帧的可见集合记下来：
 * 新出现的 key 标记为入场（从前一格里脱离出来），消失的 key 保留成 ghost 继续画一小段
 * （被吸回前一格），位置变了的 key 记下位移让它滑过去，动画结束再统一复位。
 */
export function useTokenUsageTransitions(
  metrics: TokenUsageMetric[],
  durationMs: number
): TokenUsageTransitions {
  const previousRef = useRef<TokenUsageMetric[] | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [transitions, setTransitions] = useState<TokenUsageTransitions>(STILL);
  const signature = metrics.map((metric) => metric.key).join(',');

  useEffect(() => () => {
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current = [];
  }, []);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = metrics;
    // 首帧没有"变化"可言，直接落位，不做入场动画。
    if (!previous) return;

    const previousIndexes = new Map(previous.map((metric, index) => [metric.key, index]));
    const currentKeys = new Set(metrics.map((metric) => metric.key));

    const entering = new Set(
      metrics.map((metric) => metric.key).filter((key) => !previousIndexes.has(key))
    );
    const ghosts = previous
      .map((metric, index) => ({ metric, index }))
      .filter(({ metric }) => !currentKeys.has(metric.key))
      .map(({ metric, index }) => ({
        key: metric.key,
        label: metric.label,
        value: metric.value,
        index
      }));
    const shifts = new Map<TokenUsageDimension, number>();
    metrics.forEach((metric, index) => {
      const previousIndex = previousIndexes.get(metric.key);
      if (previousIndex !== undefined && previousIndex !== index) {
        shifts.set(metric.key, previousIndex - index);
      }
    });

    if (entering.size === 0 && ghosts.length === 0 && shifts.size === 0) return;

    setTransitions({ entering, ghosts, shifts });
    const timer = setTimeout(() => {
      setTransitions(STILL);
      timersRef.current = timersRef.current.filter((candidate) => candidate !== timer);
    }, durationMs);
    timersRef.current.push(timer);
  }, [signature, durationMs, metrics]);

  return transitions;
}
