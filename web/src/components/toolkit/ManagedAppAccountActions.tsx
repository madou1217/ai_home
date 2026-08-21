import { useState, type MouseEvent } from 'react';
import { Badge, Dropdown, Tooltip, type MenuProps } from 'antd';
import {
  CodeOutlined,
  DesktopOutlined,
  MoreOutlined,
  PlusOutlined,
  StopOutlined,
  StarFilled
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { renderAccountRegionTag } from '@/features/accounts/AccountBadges';
import type { Account, ManagedAppItem } from '@/types';
import './ManagedAppAccountActions.css';

export type ManagedAppLaunchTarget = Pick<ManagedAppItem, 'id' | 'name' | 'provider' | 'type'>;

interface Props {
  app: ManagedAppLaunchTarget;
  accounts: Account[];
  runningAccountPids: Record<string, number[]>;
  runningCliAccountPids: Record<string, number[]>;
  disabled?: boolean;
  buttonLabel?: string;
  onOpen: (app: ManagedAppLaunchTarget, accountRef?: string, unscoped?: boolean) => void;
  onClose: (app: ManagedAppLaunchTarget, accountRef: string) => void;
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
  buttonLabel,
  onOpen,
  onClose
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
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

  const runAction = (
    event: MouseEvent<HTMLElement>,
    action: 'open' | 'close',
    accountRef: string
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setMenuOpen(false);
    if (action === 'close') onClose(app, accountRef);
    else onOpen(app, accountRef);
  };

  const accountItem = (account: Account, isDefault = false) => {
    const running = accountIsRunning(account, runningPids);
    return {
      // 运行中的账号行仍保留 open 语义：Desktop 可聚焦已有实例，
      // Kimi 旧的未登录实例也可由此进入托管扫码。内嵌“结束/新开”
      // 按钮会 stopPropagation，不会误触发账号行的 open。
      key: `account:${account.accountRef}`,
      // 账号即使后来失效/取消配置，已运行实例仍必须保留可结束入口。
      disabled: !account.configured && !running,
      ...(isDefault ? { icon: <StarFilled style={{ color: '#faad14' }} /> } : {}),
      label: (
        <span className={`managed-app-account-row${running ? ' is-running' : ''}`}>
          <span className="managed-app-account-name">
            <span className="managed-app-account-name-text">
              {isDefault ? '默认账号 · ' : ''}{accountLabel(account)}
            </span>
            {renderAccountRegionTag(account)}
            {!account.configured ? <span className="managed-app-account-muted">未配置</span> : null}
          </span>
          {running ? (
            <span className="managed-app-account-runtime">
              <span className="managed-app-account-running-label">
                <Badge status="success" text="运行中" />
              </span>
              <span className="managed-app-account-runtime-actions">
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<StopOutlined />}
                  aria-label={`结束 ${accountLabel(account)} 的${kind === 'desktop' ? '桌面实例' : '全部 CLI 会话'}`}
                  onClick={(event) => runAction(event, 'close', account.accountRef)}
                >
                  结束
                </Button>
                {kind === 'cli' ? (
                  <Button
                    type="text"
                    size="small"
                    icon={<PlusOutlined />}
                    aria-label={`为 ${accountLabel(account)} 新开 CLI 会话`}
                    onClick={(event) => runAction(event, 'open', account.accountRef)}
                  >
                    新开会话
                  </Button>
                ) : null}
              </span>
            </span>
          ) : null}
        </span>
      )
    };
  };

  const items: MenuProps['items'] = [
    ...(defaultAccount ? [accountItem(defaultAccount, true)] : []),
    ...providerAccounts
      .filter((account) => account.accountRef !== defaultAccount?.accountRef)
      .map((account) => accountItem(account)),
    ...(providerAccounts.length > 0 && kind === 'cli' ? [{ type: 'divider' as const }] : []),
    ...(kind === 'cli' ? [{
      key: 'unscoped',
      icon: <MoreOutlined />,
      label: '无账号新开 CLI'
    }] : []),
    ...(kind === 'desktop' && providerAccounts.length === 0 ? [{
      key: 'no-account',
      disabled: true,
      label: '暂无可用账号'
    }] : [])
  ];

  const handleMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'unscoped') {
      setMenuOpen(false);
      onOpen(app, undefined, true);
      return;
    }
    if (String(key).startsWith('account:')) {
      setMenuOpen(false);
      onOpen(app, String(key).slice('account:'.length));
    }
  };

  return (
    <Dropdown
      trigger={['click']}
      menu={{ items, onClick: handleMenuClick }}
      disabled={disabled}
      open={menuOpen}
      onOpenChange={setMenuOpen}
    >
      <Tooltip title={`选择账号打开${kind === 'desktop' ? ' Desktop' : ' CLI'}${hasRunningAccount ? '（有账号运行中）' : ''}`}>
        <Button
          size="small"
          shape={buttonLabel ? undefined : 'circle'}
          icon={(
            <Badge dot={hasRunningAccount} status="success">
              <Icon />
            </Badge>
          )}
          disabled={disabled}
          aria-label={`选择账号打开 ${app.name}`}
        >
          {buttonLabel}
        </Button>
      </Tooltip>
    </Dropdown>
  );
}
