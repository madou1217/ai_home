import React, { memo } from 'react';
import type { CSSProperties } from 'react';

import { buildBloodBurst } from './blood-burst';

interface Props {
  accountRef: string;
  dropId: string;
  deltaTokens: number;
  /** 咬合发生在整套攻击动画的哪一刻（ms）——血是从那一下开始溅的。 */
  biteAtMs: number;
}

/**
 * 咬中那一下溅出来的血。
 *
 * 三层各管一件事，合起来才是一条被重力拉回来的抛物线：
 * drift 水平匀速、fall 先减速上升再加速坠落、drop 自己淡开并转个身。
 * 三层动的都是 transform / opacity，整团血不碰布局。
 */
const BloodBurst = ({ accountRef, dropId, deltaTokens, biteAtMs }: Props) => {
  const droplets = buildBloodBurst(accountRef, dropId, deltaTokens);

  return (
    <span className="quota-blood" aria-hidden="true">
      {droplets.map((droplet) => (
        <span
          key={droplet.id}
          className="quota-blood-drift"
          style={{
            ['--blood-drift' as string]: `${droplet.driftPx}px`,
            ['--blood-rise' as string]: `${droplet.risePx}px`,
            ['--blood-fall' as string]: `${droplet.fallPx}px`,
            ['--blood-size' as string]: `${droplet.sizePx}px`,
            ['--blood-stretch' as string]: droplet.stretch,
            ['--blood-spin' as string]: `${droplet.spinDeg}deg`,
            ['--blood-color' as string]: droplet.color,
            ['--blood-life' as string]: `${droplet.lifeMs}ms`,
            ['--blood-delay' as string]: `${biteAtMs + droplet.delayMs}ms`
          } as CSSProperties}
        >
          <span className="quota-blood-fall">
            <span className="quota-blood-drop" />
          </span>
        </span>
      ))}
    </span>
  );
};

export default memo(BloodBurst);
