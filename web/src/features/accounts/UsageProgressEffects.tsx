import React, { useEffect, useRef, useState } from 'react';

import UsageSnapshotCell, { getUsageBarColor } from '@/components/account/UsageSnapshotCell';
import type { Account, ManagementAccountActivity } from '@/types';
import { getAccountRef } from '@/features/accounts/account-model-catalog';
import BurningParticles from './BurningParticles';
import TokenDropNumber from './TokenDropNumber';
import type { TokenDropEvent } from './useTokenDropEvents';
import './UsageProgressEffects.css';

interface Props {
  record: Account;
  activity: ManagementAccountActivity | null;
  drops: TokenDropEvent[];
}

/**
 * 剩余额度进度条运行动效包装（低侵入）：
 * - 运行中（inFlight > 0）：进度条渐变流光扫过，表达"正在被消耗"。
 * - remainingPct 下降：进度条做一次短促回弹（被咬了一口）。
 * - tokenUsage 增量：由页面级 useTokenDropEvents 产出的掉落事件在此渲染伤害数字。
 * 不修改 UsageSnapshotCell 内部实现，全部通过外层容器 + CSS 后代选择器驱动。
 */
const UsageProgressEffects = ({ record, activity, drops }: Props) => {
  const running = Boolean(activity && activity.inFlight > 0);
  const remainingPct = record.remainingPct;
  const previousPctRef = useRef<number | null>(remainingPct);
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    const previous = previousPctRef.current;
    previousPctRef.current = remainingPct;
    if (
      previous != null
      && remainingPct != null
      && Number.isFinite(previous)
      && Number.isFinite(remainingPct)
      && remainingPct < previous
    ) {
      setPulsing(true);
      const timer = window.setTimeout(() => setPulsing(false), 650);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [remainingPct]);

  const accountRef = getAccountRef(record);
  const accountDrops = Array.isArray(drops)
    ? drops.filter((drop) => drop.accountRef === accountRef)
    : [];

  return (
    <div
      className={[
        'usage-progress-effects',
        running ? 'usage-progress-effects--running' : '',
        pulsing ? 'usage-progress-effects--pulsing' : ''
      ].filter(Boolean).join(' ')}
    >
      <UsageSnapshotCell record={record} />
      {running ? (
        <BurningParticles
          active
          anchorPct={remainingPct == null || !Number.isFinite(remainingPct) ? 50 : remainingPct}
          color={getUsageBarColor(remainingPct)}
        />
      ) : null}
      <TokenDropNumber drops={accountDrops} />
    </div>
  );
};

export default UsageProgressEffects;
