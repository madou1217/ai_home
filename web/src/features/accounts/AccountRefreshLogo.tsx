import { Tooltip } from 'antd';
import type { Account, ManagementAccountActivity } from '@/types';
import AccountActivityIcon from './AccountActivityIcon';
import { getAccountPrimaryLabel } from './AccountBadges';
import './AccountRefreshLogo.css';

interface Props {
  account: Account;
  activity: ManagementAccountActivity | null;
  refreshing: boolean;
  onRefresh: (account: Account) => void;
  size?: number;
}

export default function AccountRefreshLogo({ account, activity, refreshing, onRefresh, size = 18 }: Props) {
  return (
    <Tooltip title={refreshing ? '正在并发刷新账号状态、模型和额度' : '刷新账号状态、模型和额度'}>
      <button
        type="button"
        className="account-refresh-logo"
        aria-label={`刷新账号 ${getAccountPrimaryLabel(account)} 的状态、模型和额度`}
        aria-busy={refreshing}
        disabled={refreshing}
        onClick={(event) => { event.stopPropagation(); onRefresh(account); }}
      >
        <AccountActivityIcon provider={account.provider} activity={activity} size={size} />
      </button>
    </Tooltip>
  );
}
