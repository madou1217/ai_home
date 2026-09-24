import { memo } from 'react';
import { Button, Dropdown, Space, Tag, Tooltip, message } from 'antd';
import {
  CopyOutlined,
  MoreOutlined,
  DesktopOutlined,
  CodeOutlined,
  DeleteOutlined,
  EditOutlined,
} from '@ant-design/icons';
import type { Account, Provider } from '@/types';
import ProviderIcon from '@/components/chat/ProviderIcon';
import styles from './AccountCardGrid.module.css';

interface AccountCardGridProps {
  accounts: Account[];
  provider: Provider;
  loading?: boolean;
  onEdit?: (account: Account) => void;
  onDelete?: (account: Account) => void;
  onOpenApp?: (account: Account) => void;
  onOpenCli?: (account: Account) => void;
}

/** 复制卡片上已展示的账号 ID（与 Accounts 页 copyAccountEmail 同一模式：clipboard + message 反馈）。 */
async function copyAccountId(value: string) {
  const text = String(value || '').trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    message.success('账号 ID 已复制');
  } catch (_error) {
    message.error('复制失败');
  }
}

/**
 * 账号卡片网格（Cyber HUD）：.hud-panel--sm 切角小卡 + 角标，状态用 .hud-led 指示灯 + 等宽标签，
 * 配额为 3px 发光细轨；操作按钮保持语义图标（CodeOutlined / DesktopOutlined），不使用 Provider Logo。
 */
export const AccountCardGrid = memo(function AccountCardGrid({
  accounts,
  provider,
  loading = false,
  onEdit,
  onDelete,
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
        const isHealthy = acc.quotaStatus === 'healthy' || acc.schedulableStatus === 'schedulable';
        const isWarning = acc.quotaStatus === 'warning' || acc.schedulableStatus === 'cooldown';

        const statusText = isHealthy ? '正常就绪' : isWarning ? '冷却中' : '不可用';
        const remainingPct = typeof acc.remainingPct === 'number' ? Math.round(acc.remainingPct) : null;
        const quotaColor = remainingPct !== null && remainingPct > 20 ? 'var(--color-success)' : 'var(--color-danger)';
        // 卡片上展示的 ID：有 CLI 账号号就显示它，否则显示 accountRef 的前 6 位；复制时给出完整原值。
        const displayedIdValue = acc.cliAccountId || acc.accountRef;

        const actionMenuItems = [
          {
            key: 'edit',
            label: '编辑别名 / 凭据',
            icon: <EditOutlined />,
            onClick: () => onEdit && onEdit(acc),
          },
          {
            key: 'cli',
            label: '启动终端会话',
            icon: <CodeOutlined />,
            onClick: () => onOpenCli && onOpenCli(acc),
          },
          ...(acc.clients?.desktop ? [{
            key: 'desktop',
            label: '拉起桌面客户端',
            icon: <DesktopOutlined />,
            onClick: () => onOpenApp && onOpenApp(acc),
          }] : []),
          {
            type: 'divider' as const,
          },
          {
            key: 'delete',
            label: '删除此账号',
            icon: <DeleteOutlined />,
            danger: true,
            onClick: () => onDelete && onDelete(acc),
          },
        ];

        return (
          <div key={acc.accountRef} className={`${styles.accountCard} hud-panel hud-panel--sm`}>
            {/* 卡片顶部：图标、标题与操作下拉 */}
            <div className={styles.cardHeader}>
              <div className={styles.avatarWrapper}>
                <ProviderIcon provider={acc.provider || provider} size={20} />
              </div>
              <div className={styles.accountInfo}>
                <strong className={styles.accountTitle}>
                  {acc.email || acc.alias || acc.accountRef.slice(0, 12)}
                </strong>
                <span className={styles.accountSubtitle}>
                  <span className={styles.accountSubtitleText}>
                    {acc.provider.toUpperCase()} · ID #{acc.cliAccountId || acc.accountRef.slice(0, 6)}
                  </span>
                  {displayedIdValue ? (
                    <Tooltip title={`复制账号 ID：${displayedIdValue}`}>
                      <button
                        type="button"
                        className={styles.copyIdBtn}
                        aria-label="复制账号 ID"
                        onClick={() => { void copyAccountId(String(displayedIdValue)); }}
                      >
                        <CopyOutlined />
                        <span>COPY</span>
                      </button>
                    </Tooltip>
                  ) : null}
                </span>
              </div>
              <Dropdown menu={{ items: actionMenuItems }} trigger={['click']} placement="bottomRight">
                <Button type="text" shape="circle" size="small" icon={<MoreOutlined />} className={styles.moreBtn} />
              </Dropdown>
            </div>

            {/* 卡片主体：状态徽标与配额进度胶囊 */}
            <div className={styles.cardBody}>
              <div className={styles.statusRow}>
                <div className={`${styles.statusPill} ${isHealthy ? styles.statusHealthy : isWarning ? styles.statusWarning : styles.statusError}`}>
                  <span className={`hud-led ${isHealthy ? 'hud-led--ok' : isWarning ? 'hud-led--warn' : 'hud-led--err'}`} />
                  <span>{statusText}</span>
                </div>
                {acc.planType && (
                  <Tag className={styles.planTag}>{acc.planType.toUpperCase()}</Tag>
                )}
              </div>

              {/* 配额剩余百分比水滴条 */}
              {remainingPct !== null ? (
                <div className={styles.quotaTrack}>
                  <div className={styles.quotaLabels}>
                    <span className="hud-label">配额水位</span>
                    <strong className="hud-display" style={{ color: quotaColor }}>{remainingPct}%</strong>
                  </div>
                  <div className={styles.progressBar}>
                    <div
                      className={styles.progressFill}
                      style={{
                        width: `${Math.max(4, remainingPct)}%`,
                        background: quotaColor,
                        color: quotaColor,
                      }}
                    />
                  </div>
                </div>
              ) : null}
            </div>

            {/* 卡片底部操作栏 */}
            <div className={styles.cardFooter}>
              <Space size={8}>
                <Tooltip title="快速进入 CLI 会话">
                  <Button size="small" icon={<CodeOutlined />} onClick={() => onOpenCli && onOpenCli(acc)}>
                    终端
                  </Button>
                </Tooltip>
                {acc.clients?.desktop && (
                  <Tooltip title="拉起官方桌面 App">
                    <Button size="small" icon={<DesktopOutlined />} onClick={() => onOpenApp && onOpenApp(acc)}>
                      客户端
                    </Button>
                  </Tooltip>
                )}
              </Space>
            </div>
          </div>
        );
      })}
    </div>
  );
});

export default AccountCardGrid;
