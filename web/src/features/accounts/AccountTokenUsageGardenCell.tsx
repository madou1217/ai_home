import React, { useEffect, useMemo, useState } from 'react';

import TokenUsageCell from '@/components/account/TokenUsageCell';
import type { Account, ManagementAccountActivity } from '@/types';
import { getAccountRef } from './account-model-catalog';
import UpstreamQuotaGarden from './UpstreamQuotaGarden';
import type { TokenDropEvent } from './useTokenDropEvents';
import { isAccountConsuming, selectAccountDrops } from './usage-activity';

interface Props {
  record: Account;
  activity: ManagementAccountActivity | null;
  drops: TokenDropEvent[];
}

/**
 * Token 用量列的组合边界：普通账号维持原图表，API Key 账号在真实柱顶挂载捕食花。
 */
const AccountTokenUsageGardenCell = ({ record, activity, drops }: Props) => {
  const accountRef = getAccountRef(record);
  const accountDrops = useMemo(
    () => selectAccountDrops(drops, accountRef),
    [accountRef, drops]
  );
  const eligible = Boolean(record.apiKeyMode && record.tokenUsage);
  const active = eligible && isAccountConsuming(activity, accountDrops);
  const [gardenStageActive, setGardenStageActive] = useState(active);

  useEffect(() => {
    if (active) setGardenStageActive(true);
    if (!eligible) setGardenStageActive(false);
  }, [active, eligible]);

  const stageActive = active || gardenStageActive;

  return (
    <div
      className="account-token-usage-garden-cell"
      data-upstream-quota-garden={eligible ? 'true' : 'false'}
      data-garden-active={active ? 'true' : 'false'}
      data-garden-stage-active={stageActive ? 'true' : 'false'}
    >
      <TokenUsageCell usage={record.tokenUsage} />
      {eligible && record.tokenUsage ? (
        <UpstreamQuotaGarden
          key={accountRef}
          accountRef={accountRef}
          usage={record.tokenUsage}
          active={active}
          drops={accountDrops}
          onStageActiveChange={setGardenStageActive}
        />
      ) : null}
    </div>
  );
};

export default AccountTokenUsageGardenCell;
