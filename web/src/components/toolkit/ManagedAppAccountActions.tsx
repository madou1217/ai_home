import { Badge, Dropdown, Tooltip, type MenuProps } from 'antd';
import {
  CodeOutlined,
  DesktopOutlined,
  MoreOutlined,
  StarFilled
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import type { Account, ManagedAppItem } from '@/types';

interface Props {
  app: ManagedAppItem;
  accounts: Account[];
  runningAccountPids: Record<string, number[]>;
  runningCliAccountPids: Record<string, number[]>;
  disabled?: boolean;
  onOpen: (app: ManagedAppItem, accountRef?: string, unscoped?: boolean) => void;
}

function accountLabel(account: Account) {
  return String(account.displayName || account.email || account.accountRef || '未命名账号').trim();
}

function accountIsRunning(account: Account, runningAccountPids: Record<string, number[]>) {
  return Array.isArray(runningAccountPids[account.accountRef])
    && runningAccountPids[account.accountRef].length > 0;
}

/**
 * Toolkit 客户端入口的唯一账号选择器：Provider 账号由外层传入，
 * 组件只负责展示同 Provider 账号、默认账号快捷项与无账号新开。
 */
export default function ManagedAppAccountActions({
  app,
  accounts,
  runningAccountPids,
  runningCliAccountPids,
  disabled,
  onOpen
}: Props) {
  const kind = app.type === 'desktop' ? 'desktop' : 'cli';
  const Icon = kind === 'desktop' ? DesktopOutlined : CodeOutlined;
  const runningPids = kind === 'desktop' ? runningAccountPids : runningCliAccountPids;
  const providerAccounts = accounts
    .filter((account) => account.provider === app.provider)
    .sort((left, right) => {
      if (Boolean(left.isDefault) !== Boolean(right.isDefault)) return left.isDefault ? -1 : 1;
      return accountLabel(left).localeCompare(accountLabel(right), 'zh-CN');
    });
  const defaultAccount = providerAccounts.find((account) => account.isDefault && account.configured);
  const hasRunningAccount = providerAccounts.some((account) => accountIsRunning(account, runningPids));

  const items: MenuProps['items'] = [
    ...(defaultAccount ? [{
      key: `account:${defaultAccount.accountRef}`,
      icon: <StarFilled style={{ color: '#faad14' }} />,
      label: (
        <span>
          默认账号 · {accountLabel(defaultAccount)}
          {accountIsRunning(defaultAccount, runningPids) ? <Badge status="success" text="运行中" style={{ marginLeft: 8 }} /> : null}
        </span>
      )
    }] : []),
    ...providerAccounts
      .filter((account) => account.accountRef !== defaultAccount?.accountRef)
      .map((account) => ({
        key: `account:${account.accountRef}`,
        disabled: !account.configured,
        label: (
          <span>
            {accountLabel(account)}
            {!account.configured ? <span style={{ color: '#8c8c8c', marginLeft: 8 }}>未配置</span> : null}
            {accountIsRunning(account, runningPids) ? <Badge status="success" text="运行中" style={{ marginLeft: 8 }} /> : null}
          </span>
        )
      })),
    ...(providerAccounts.length > 0 ? [{ type: 'divider' as const }] : []),
    {
      key: 'unscoped',
      icon: <MoreOutlined />,
      label: `无账号新开 ${kind === 'desktop' ? 'Desktop' : 'CLI'}`
    }
  ];

  const handleMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'unscoped') {
      onOpen(app, undefined, true);
      return;
    }
    if (String(key).startsWith('account:')) {
      onOpen(app, String(key).slice('account:'.length));
    }
  };

  return (
    <Dropdown
      trigger={['click']}
      menu={{ items, onClick: handleMenuClick }}
      disabled={disabled}
    >
      <Tooltip title={`选择账号打开${kind === 'desktop' ? ' Desktop' : ' CLI'}${hasRunningAccount ? '（有账号运行中）' : ''}`}>
        <Button
          size="small"
          shape="circle"
          icon={(
            <Badge dot={hasRunningAccount} status="success">
              <Icon />
            </Badge>
          )}
          disabled={disabled}
          aria-label={`选择账号打开 ${app.name}`}
        />
      </Tooltip>
    </Dropdown>
  );
}
