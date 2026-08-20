import React from 'react';

import type { TokenDropEvent } from './useTokenDropEvents';
import './TokenDropNumber.css';

export function formatTokenDelta(value: number) {
  if (value >= 999_500_000) return `-${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 999_500) return `-${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `-${(value / 1_000).toFixed(1)}K`;
  return `-${value}`;
}

export function formatCostDelta(value: number | null) {
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

export const TokenDropLabel = ({ drop }: { drop: TokenDropEvent }) => {
  const costLabel = formatCostDelta(drop.deltaCostUsd);
  return (
    <>
      <span className="token-drop-tokens">{formatTokenDelta(drop.deltaTokens)}</span>
      {costLabel ? <span className="token-drop-cost">{costLabel}</span> : null}
    </>
  );
};

/**
 * 伤害数字：token 消耗掉落飘字。
 * 纯渲染组件——事件由页面级 useTokenDropEvents 产出后按账号过滤传入，
 * 组件本身不持有状态，动画由 CSS keyframes 驱动，播完由 hook 清理事件。
 * 位置按 drop id 在稳定范围内散布，多个伤害自然错开；无额度条账号使用
 * 单独的紧凑锚点，避免数字在整列中漂移。动画时长与队列生命周期对齐。
 */
const TokenDropNumber = ({
  drops,
  placement = 'metered'
}: {
  drops: TokenDropEvent[];
  placement?: 'metered' | 'unmetered';
}) => {
  if (!Array.isArray(drops) || drops.length === 0) return null;

  return (
    <span
      className={`token-drop-layer token-drop-layer--${placement}`}
      data-token-drop-placement={placement}
      aria-hidden="true"
    >
      {drops.map((drop) => {
        const left = placement === 'unmetered'
          ? 34 + idRandom(drop.id, 1) * 48
          : 10 + idRandom(drop.id, 1) * 62;
        const bottom = idRandom(drop.id, 2) * (placement === 'unmetered' ? 10 : 14);
        const rotate = (idRandom(drop.id, 3) - 0.5) * 12;
        return (
          <span
            key={drop.id}
            className="token-drop"
            data-token-drop-id={drop.id}
            style={{
              left: `${left}%`,
              bottom: `${bottom}px`,
              ['--drop-rotate' as string]: `${rotate}deg`
            }}
          >
            <TokenDropLabel drop={drop} />
          </span>
        );
      })}
    </span>
  );
};

export default TokenDropNumber;
