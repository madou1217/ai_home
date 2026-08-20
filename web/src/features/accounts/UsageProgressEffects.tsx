import React, { useEffect, useRef, useState } from 'react';

import UsageSnapshotCell from '@/components/account/UsageSnapshotCell';
import type { Account, ManagementAccountActivity } from '@/types';
import { getAccountRef } from '@/features/accounts/account-model-catalog';
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
 * 火药燃点由 UsageSnapshotCell 挂在真实轨道内；本层只编排活动状态与掉落事件。
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
      data-usage-layout={record.apiKeyMode ? 'unmetered' : 'metered'}
      data-account-ref={accountRef}
      data-quota-damage-source={record.apiKeyMode ? 'true' : undefined}
    >
      <UsageSnapshotCell
        record={record}
        running={running}
        activityRate={Number(activity?.rate) || 0}
        activeModels={activity?.activeModels}
      />
      {!record.apiKeyMode ? (
        <TokenDropNumber drops={accountDrops} placement="metered" />
      ) : null}
    </div>
  );
};

export default UsageProgressEffects;
