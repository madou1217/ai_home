import './RecoveryAccountsView.css';
import React from 'react';
import { Badge, Empty, List, Space, Tag } from 'antd';
import { DeleteOutlined, SyncOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import SectionCard from '@/components/ui/SectionCard';
import type { Account } from '@/types';
import { providerNames } from '@/components/chat/ProviderIcon';
import { formatAccountIssueReason } from '@/utils/account-reasons';
import {
  getAccountPrimaryLabel,
  getAccountSecondaryLabel
} from '@/features/accounts/AccountBadges';
import { getRecoveryAccountReason } from '@/features/accounts/account-state';
import { getAccountRef } from '@/features/accounts/account-model-catalog';

interface RecoveryAccountsViewProps {
  accounts: Account[];
  loading: boolean;
  highlightedAccountRef?: string;
  removingAccountRefs: Record<string, boolean>;
  onReauth: (account: Account) => void;
  onDelete: (account: Account) => void;
}

export function RecoveryAccountsView({
  accounts,
  loading,
  highlightedAccountRef,
  removingAccountRefs,
  onReauth,
  onDelete
}: RecoveryAccountsViewProps) {
  return (
    <div className="account-recovery-view">
      <p className="account-recovery-view__summary">
        即使认证失效或被停用，OAuth 账号数据仍然保留在这里，不会因页面刷新消失。重新登录后账号会自动回到当前列表；彻底移除仍需显式删除。
      </p>
      <SectionCard
        title="需要重新登录"
        extra={<Badge status={accounts.length > 0 ? 'warning' : 'default'} text={`${accounts.length} 个账号`} />}
      >
        <List
          loading={loading}
          dataSource={accounts}
          locale={{
            emptyText: (
              <Empty
                className="account-recovery-view__empty"
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="当前没有待恢复账号"
              />
            )
          }}
          renderItem={(account) => {
            const accountRef = getAccountRef(account);
            const reason = formatAccountIssueReason(getRecoveryAccountReason(account));
            const secondaryLabel = getAccountSecondaryLabel(account);
            const rowClassName = [
              highlightedAccountRef === accountRef ? 'accounts-row-target' : '',
              removingAccountRefs[accountRef] ? 'accounts-row-exiting animate__animated animate__fadeOutLeft animate__faster' : ''
            ].filter(Boolean).join(' ');

            return (
              <List.Item
                key={accountRef}
                className={rowClassName}
                data-account-ref={accountRef}
                actions={[
                  <Button
                    key="reauth"
                    size="small"
                    icon={<SyncOutlined />}
                    onClick={() => onReauth(account)}
                  >
                    重新登录
                  </Button>,
                  <Button
                    key="delete"
                    type="text"
                    danger
                    size="small"
                    icon={<DeleteOutlined />}
                    onClick={() => onDelete(account)}
                  >
                    删除账号
                  </Button>
                ]}
              >
                <List.Item.Meta
                  title={(
                    <Space size={8} wrap>
                      <Tag>{providerNames[account.provider] || account.provider}</Tag>
                      <span>{getAccountPrimaryLabel(account)}</span>
                    </Space>
                  )}
                  description={(
                    <div className="account-recovery-view__description">
                      {secondaryLabel ? (
                        <span className="account-recovery-view__secondary">{secondaryLabel}</span>
                      ) : null}
                      <Badge status="warning" text="已移出当前账号池，等待恢复" />
                      {reason ? <span className="account-recovery-view__reason">{reason}</span> : null}
                    </div>
                  )}
                />
              </List.Item>
            );
          }}
        />
      </SectionCard>
    </div>
  );
}
