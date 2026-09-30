import { memo, type ReactNode } from 'react';
import { Button, Dropdown, Tag, Tooltip, type MenuProps } from 'antd';
import {
  CopyOutlined,
  MoreOutlined,
  DesktopOutlined,
  CodeOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import type { Account, ManagementAccountActivity, Provider } from '@/types';
import AccountActivityIcon from '@/features/accounts/AccountActivityIcon';
import AccountSubscriptionLines from '@/features/accounts/AccountSubscriptionLines';
import {
  getAccountPrimaryLabel,
  getAccountSecondaryLabel,
  getPlanTagColor,
  getPlanTagLabel,
  renderAccountDisplayBadge,
  renderAccountRegionTag,
  renderAccountRoleIcons,
} from '@/features/accounts/AccountBadges';
import { canCopyAccountEmail, requiresAccountReauth } from '@/features/accounts/account-state';
import TokenUsageCell from './TokenUsageCell';
import { formatTimeCell } from '@/utils/datetime';
import styles from './AccountCardGrid.module.css';

interface AccountCardGridProps {
  accounts: Account[];
  provider: Provider;
  loading?: boolean;
  getActivity: (account: Account) => ManagementAccountActivity | null;
  /** 健康红绿图标（悬停看 90 天 / 24 小时明细），与列表账号列同一组件。 */
  renderHealth: (account: Account) => ReactNode;
  /** 剩余额度（全部窗口 + 消耗动效），与列表「剩余额度」列同一组件。 */
  renderUsage: (account: Account) => ReactNode;
  /** ⋮ 菜单与列表操作列共用同一套 items + 点击分发。 */
  getMenuItems: (account: Account) => MenuProps['items'];
  onMenuClick: (account: Account, key: string) => void;
  onCopy: (account: Account) => void;
  isDesktopSupported: (account: Account) => boolean;
  onOpenApp: (account: Account) => void;
  onOpenCli: (account: Account) => void;
  /** 订阅到期待确认时的「确认」动作（刷新额度），与列表同源。 */
  onConfirmSubscription?: (account: Account) => void;
  isConfirmingSubscription?: (account: Account) => boolean;
}

/**
 * 账号卡片网格（Cyber HUD）：信息与列表模式对齐——账号名 / 健康 / 订阅有效期 / 调度状态 /
 * 套餐 / 全部额度窗口 / Token 用量 / 上次使用。展示逻辑全部复用列表同源的徽章与单元格组件，
 * 卡片只负责排版，避免两套判定分叉（此前卡片自行推导“不可用”，与列表调度状态不一致）。
 */
export const AccountCardGrid = memo(function AccountCardGrid({
  accounts,
  provider,
  loading = false,
  getActivity,
  renderHealth,
  renderUsage,
  getMenuItems,
  onMenuClick,
  onCopy,
  onConfirmSubscription,
  isConfirmingSubscription,
  isDesktopSupported,
  onOpenApp,
  onOpenCli,
}: AccountCardGridProps) {
  if (accounts.length === 0 && !loading) {
    return (
      <div className={styles.emptyGrid}>
        <span>暂无配置的 {provider.toUpperCase()} 账号</span>
      </div>
    );
  }

  return (
    <div className={styles.gridContainer}>
      {accounts.map((acc) => {
        const primaryLabel = getAccountPrimaryLabel(acc);
        const secondaryLabel = getAccountSecondaryLabel(acc);
        const lastUsed = formatTimeCell(acc.lastUsedAt);
        const requiresReauth = requiresAccountReauth(acc);

        return (
          <div
            key={acc.accountRef}
            data-account-ref={acc.accountRef}
            className={`${styles.accountCard} hud-panel hud-panel--sm`}
          >
            <div className={styles.cardHeader}>
              <div className={styles.avatarWrapper}>
                <AccountActivityIcon provider={acc.provider} activity={getActivity(acc)} size={20} />
              </div>
              <div className={styles.accountInfo}>
                <div className={styles.titleRow}>
                  <Tooltip title={primaryLabel} mouseEnterDelay={0.6}>
                    <strong className={styles.accountTitle}>{primaryLabel}</strong>
                  </Tooltip>
                  <span className={styles.titleIcons}>
                    {renderHealth(acc)}
                    {renderAccountRoleIcons(acc)}
                    {canCopyAccountEmail(acc) ? (
                      <Tooltip title="复制账号">
                        <button type="button" className={styles.iconBtn} aria-label="复制账号" onClick={() => onCopy(acc)}>
                          <CopyOutlined />
                        </button>
                      </Tooltip>
                    ) : null}
                  </span>
                </div>
                {secondaryLabel ? <span className={styles.accountSubtitle}>{secondaryLabel}</span> : null}
                <AccountSubscriptionLines
                  record={acc}
                  onConfirm={onConfirmSubscription}
                  confirming={Boolean(isConfirmingSubscription && isConfirmingSubscription(acc))}
                />
              </div>
              <Dropdown
                menu={{ items: getMenuItems(acc), onClick: ({ key }) => onMenuClick(acc, String(key)) }}
                trigger={['click']}
                placement="bottomRight"
              >
                <Button type="text" shape="circle" size="small" icon={<MoreOutlined />} className={styles.moreBtn} />
              </Dropdown>
            </div>

            <div className={styles.cardBody}>
              <div className={styles.statusRow}>
                {renderAccountDisplayBadge(acc)}
                <span className={styles.tagGroup}>
                  <Tag color={getPlanTagColor(acc)} className={styles.planTag}>{getPlanTagLabel(acc)}</Tag>
                  {renderAccountRegionTag(acc)}
                </span>
              </div>
              <div className={styles.usageBlock}>{renderUsage(acc)}</div>
              <div className={styles.metaRow}>
                <TokenUsageCell usage={acc.tokenUsage} />
              </div>
            </div>

            <div className={styles.cardFooter}>
              <Tooltip title="仅统计经 aih server 成功转发的请求">
                <span className={styles.lastUsed}>
                  上次使用 {lastUsed ? lastUsed.relative : '—'}
                </span>
              </Tooltip>
              {requiresReauth ? (
                <Button size="small" icon={<SyncOutlined />} onClick={() => onMenuClick(acc, 'reauth')}>
                  重新登录
                </Button>
              ) : (
                <span className={styles.footerActions}>
                  <Tooltip title="快速进入 CLI 会话">
                    <Button size="small" icon={<CodeOutlined />} onClick={() => onOpenCli(acc)}>
                      终端
                    </Button>
                  </Tooltip>
                  {isDesktopSupported(acc) ? (
                    <Tooltip title="拉起官方桌面 App">
                      <Button size="small" icon={<DesktopOutlined />} onClick={() => onOpenApp(acc)}>
                        客户端
                      </Button>
                    </Tooltip>
                  ) : null}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
});

export default AccountCardGrid;
