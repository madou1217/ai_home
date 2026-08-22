import React, { useEffect, useRef, useState } from 'react';

import UsageSnapshotCell from '@/components/account/UsageSnapshotCell';
import type { Account, ManagementAccountActivity } from '@/types';
import { getAccountRef } from '@/features/accounts/account-model-catalog';
import TokenDropNumber from './TokenDropNumber';
import type { TokenDropEvent } from './useTokenDropEvents';
import { isAccountConsuming, selectAccountDrops } from './usage-activity';
import './UsageProgressEffects.css';

interface Props {
  record: Account;
  activity: ManagementAccountActivity | null;
  drops: TokenDropEvent[];
}

/**
 * 剩余额度进度条运行动效包装（低侵入）：
 * - 运行中：进度条渐变流光扫过，表达"正在被消耗"。
 * - remainingPct 下降：进度条做一次短促回弹。
 * - tokenUsage 增量：由页面级 useTokenDropEvents 产出的掉落事件在此渲染伤害数字。
 * 火药燃点由 UsageSnapshotCell 挂在真实轨道内；本层只编排活动状态与掉落事件。
 */
const UsageProgressEffects = ({ record, activity, drops }: Props) => {
  const accountRef = getAccountRef(record);
  const accountDrops = selectAccountDrops(drops, accountRef);
  // 判定收敛在 usage-activity 里，避免活动状态与掉落反馈各自推导。
  const running = isAccountConsuming(activity, accountDrops);
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

  return (
    <div
      className={[
        'usage-progress-effects',
        running ? 'usage-progress-effects--running' : '',
        pulsing ? 'usage-progress-effects--pulsing' : ''
      ].filter(Boolean).join(' ')}
      data-usage-layout={record.apiKeyMode ? 'unmetered' : 'metered'}
    >
      <UsageSnapshotCell
        record={record}
        running={running}
        activityRate={Number(activity?.rate) || 0}
        activeModels={activity?.activeModels}
      />
      {!record.apiKeyMode ? (
        <TokenDropNumber drops={accountDrops} />
      ) : null}
    </div>
  );
};

export default UsageProgressEffects;
