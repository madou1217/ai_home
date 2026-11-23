import { useCallback, useEffect, useMemo, useState } from 'react';
import { Space, Spin, Table, Tag, Typography } from 'antd';
import Button from '@/components/ui/AppButton';
import { InlineNote } from '@/components/ui/InlineNote';
import { accountsAPI } from '@/services/api';
import Upstream429RetrySettingCard from '@/features/settings/Upstream429RetrySettingCard';
import { formatBackoffSeconds } from '@/features/settings/BackoffScheduleInput';
import { AccountUpstream429RetryModal } from '@/features/accounts/AccountUpstream429RetryModal';
import { getAccountPrimaryLabel } from '@/features/accounts/AccountBadges';
import type { Account, AccountUpstream429RetryResponse } from '@/types';

interface Upstream429SettingsPanelProps {
  provider: string;
}

function modeLabel(mode: AccountUpstream429RetryResponse['override']['mode']): { text: string; color: string } {
  switch (mode) {
    case 'enabled':
      return { text: '自定义启用', color: 'green' };
    case 'disabled':
      return { text: '强制关闭', color: 'red' };
    default:
      return { text: '继承全局', color: 'default' };
  }
}

/**
 * Toolkit 应用高级设置里的「429 重试」：全局策略 + 当前 Provider 的账号覆盖概览。
 *
 * 全局策略沿用设置页同一张卡片（保存即热加载）；账号级覆盖仍由账号运行设置里的
 * 同一个编辑器维护，这里只做可视总览与快捷入口。
 */
export default function Upstream429SettingsPanel({ provider }: Upstream429SettingsPanelProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [policies, setPolicies] = useState<Record<string, AccountUpstream429RetryResponse>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Account | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await accountsAPI.list();
      const scoped = response.accounts.filter((account) => account.provider === provider);
      setAccounts(scoped);
      const loaded = await Promise.all(
        scoped.map(async (account) => {
          try {
            const policy = await accountsAPI.getAccountUpstream429Retry(provider, account.accountRef);
            return [account.accountRef, policy] as const;
          } catch {
            return null;
          }
        })
      );
      const next: Record<string, AccountUpstream429RetryResponse> = {};
      for (const entry of loaded) {
        if (entry) next[entry[0]] = entry[1];
      }
      setPolicies(next);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '读取账号 429 设置失败');
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns = useMemo(
    () => [
      {
        title: '账号',
        dataIndex: 'accountRef',
        key: 'account',
        render: (_value: string, account: Account) => (
          <Space direction="vertical" size={0}>
            <span>{getAccountPrimaryLabel(account)}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {account.accountRef}
            </Typography.Text>
          </Space>
        )
      },
      {
        title: '模式',
        key: 'mode',
        render: (_value: unknown, account: Account) => {
          const policy = policies[account.accountRef];
          if (!policy) return <Typography.Text type="secondary">读取中…</Typography.Text>;
          const label = modeLabel(policy.override.mode);
          return <Tag color={label.color}>{label.text}</Tag>;
        }
      },
      {
        title: '生效退避（秒）',
        key: 'schedule',
        render: (_value: unknown, account: Account) => {
          const policy = policies[account.accountRef];
          if (!policy) return <Typography.Text type="secondary">—</Typography.Text>;
          if (!policy.effective.enabled) return <Typography.Text type="secondary">未启用</Typography.Text>;
          return <code>{formatBackoffSeconds(policy.effective.backoffSeconds)}</code>;
        }
      },
      {
        title: '操作',
        key: 'actions',
        width: 110,
        render: (_value: unknown, account: Account) => (
          <Button size="small" onClick={() => setEditing(account)}>
            编辑
          </Button>
        )
      }
    ],
    [policies]
  );

  return (
    <div className="aas-config-pane">
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Upstream429RetrySettingCard />
        <section className="aas-section">
          <div className="aas-section-head aas-section-head--plain">
            <div>
              <strong>账号级覆盖（{provider}）</strong>
              <span>
                账号配置优先于全局：继承全局 / 自定义启用（必须填写非空退避队列）/ 强制关闭。
                并发受限时每个请求按各自退避重试；谁先拿到并发名额谁继续。
              </span>
            </div>
            <Button size="small" onClick={() => void load()} disabled={loading}>
              刷新
            </Button>
          </div>
          {error ? (
            <InlineNote tone="error" description={error}>
              读取账号 429 设置失败
            </InlineNote>
          ) : loading ? (
            <div className="aas-loading">
              <Spin tip="正在读取账号 429 设置" />
            </div>
          ) : accounts.length === 0 ? (
            <InlineNote tone="info">当前 Provider 还没有账号，先在「账号」页添加。</InlineNote>
          ) : (
            <Table
              size="small"
              rowKey="accountRef"
              pagination={false}
              dataSource={accounts}
              columns={columns}
            />
          )}
        </section>
        {provider === 'claude' ? (
          <InlineNote
            tone="info"
            description="Claude Code 默认 5 分钟收不到数据就断开；要让它等满重试窗口，请在「配置文件」页给 Claude 的 settings.json 设置 env.CLAUDE_STREAM_IDLE_TIMEOUT_MS=1800000、env.API_TIMEOUT_MS=2000000（或由启动器注入）。"
          >
            客户端等待上限
          </InlineNote>
        ) : null}
      </Space>
      <AccountUpstream429RetryModal
        account={editing}
        onClose={() => {
          setEditing(null);
          void load();
        }}
      />
    </div>
  );
}