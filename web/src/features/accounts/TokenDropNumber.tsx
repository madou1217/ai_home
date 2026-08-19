import React from 'react';

import type { TokenDropEvent } from './useTokenDropEvents';
import './TokenDropNumber.css';

function formatTokenDelta(value: number) {
  if (value >= 999_500_000) return `+${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 999_500) return `+${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `+${(value / 1_000).toFixed(1)}K`;
  return `+${value}`;
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

/**
 * 伤害数字：token 消耗掉落飘字。
 * 纯渲染组件——事件由页面级 useTokenDropEvents 产出后按账号过滤传入，
 * 组件本身不持有状态，动画由 CSS keyframes 驱动，播完由 hook 清理事件。
 */
const TokenDropNumber = ({ drops }: { drops: TokenDropEvent[] }) => {
  if (!Array.isArray(drops) || drops.length === 0) return null;

  return (
    <span className="token-drop-layer" aria-hidden="true">
      {drops.map((drop) => {
        const costLabel = formatCostDelta(drop.deltaCostUsd);
        return (
          <span key={drop.id} className="token-drop">
            <span className="token-drop-tokens">{formatTokenDelta(drop.deltaTokens)}</span>
            {costLabel ? <span className="token-drop-cost">{costLabel}</span> : null}
          </span>
        );
      })}
    </span>
  );
};

export default TokenDropNumber;