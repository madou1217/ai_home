import React from 'react';

import type { TokenDropEvent } from './useTokenDropEvents';
import './TokenDropNumber.css';

function formatTokenDelta(value: number) {
  if (value >= 999_500_000) return `-${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 999_500) return `-${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `-${(value / 1_000).toFixed(1)}K`;
  return `-${value}`;
}

function formatCostDelta(value: number | null) {
  if (value == null) return null;
  if (value <= 0) return null;
  if (value < 0.0001) return `-$${value.toExponential(1)}`;
  return `-$${value.toLocaleString('en-US', {
    minimumFractionDigits: value >= 0.01 ? 2 : 0,
    maximumFractionDigits: value >= 1 ? 2 : value >= 0.01 ? 4 : 6
  })}`;
}

/** 由 drop id 派生的确定性伪随机（0-1）：同一 id 的位置跨渲染稳定，互不抖动。 */
function idRandom(id: string, salt: number): number {
  let hash = 2166136261;
  const input = `${id}:${salt}`;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10000) / 10000;
}

/**
 * 伤害数字：token 消耗掉落飘字。
 * 纯渲染组件——事件由页面级 useTokenDropEvents 产出后按账号过滤传入，
 * 组件本身不持有状态，动画由 CSS keyframes 驱动，播完由 hook 清理事件。
 * 位置按 drop id 在额度条附近稳定散布，多个伤害自然错开；动画时长与队列
 * 生命周期对齐。
 */
const TokenDropNumber = ({ drops }: { drops: TokenDropEvent[] }) => {
  if (!Array.isArray(drops) || drops.length === 0) return null;

  return (
    <span className="token-drop-layer" aria-hidden="true">
      {drops.map((drop) => {
        const costLabel = formatCostDelta(drop.deltaCostUsd);
        const left = 10 + idRandom(drop.id, 1) * 62;
        const bottom = idRandom(drop.id, 2) * 14;
        const rotate = (idRandom(drop.id, 3) - 0.5) * 12;
        return (
          <span
            key={drop.id}
            className="token-drop"
            style={{
              left: `${left}%`,
              bottom: `${bottom}px`,
              ['--drop-rotate' as string]: `${rotate}deg`
            }}
          >
            <span className="token-drop-tokens">{formatTokenDelta(drop.deltaTokens)}</span>
            {costLabel ? <span className="token-drop-cost">{costLabel}</span> : null}
          </span>
        );
      })}
    </span>
  );
};

export default TokenDropNumber;
