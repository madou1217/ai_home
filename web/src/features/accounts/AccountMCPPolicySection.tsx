import { useEffect, useState } from 'react';
import { Button, Checkbox, Select, Space, Spin, Typography } from 'antd';

import type { Account, AccountMCPPolicy, AccountMCPPolicyResolvedEntry } from '@/types';
import { accountsAPI } from '@/services/api';

const MCP_OPTIONS = [{ id: 'aih_remote', label: 'Remote Workspace Tools' }];

export function AccountMCPPolicySection({ account }: { account: Account | null }) {
  const [mode, setMode] = useState<AccountMCPPolicy['mode']>('auto');
  const [allow, setAllow] = useState<string[]>([]);
  const [resolved, setResolved] = useState<AccountMCPPolicyResolvedEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!account) return;
    let alive = true;
    setLoading(true);
    setMessage('');
    setError('');
    accountsAPI
      .getAccountMCPPolicy(account.provider, account.accountRef)
      .then((response) => {
        if (!alive) return;
        setMode(response.policy.mode);
        setAllow(response.policy.allow ?? []);
        setResolved(response.resolved ?? []);
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [account?.provider, account?.accountRef]);

  if (!account) return null;

  const save = async () => {
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const response = await accountsAPI.saveAccountMCPPolicy(account.provider, account.accountRef, {
        mode,
        allow
      });
      setMode(response.policy.mode);
      setAllow(response.policy.allow ?? []);
      setResolved(response.resolved ?? []);
      setMessage('已保存；新会话启动时生效。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Spin spinning={loading}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space align="center" size={12}>
          <Typography.Text strong>启用模式</Typography.Text>
          <Select
            value={mode}
            style={{ width: 260 }}
            onChange={(value) => setMode(value)}
            options={[
              { value: 'auto', label: '自动（按账号与 workspace 推导）' },
              { value: 'allowlist', label: '手动选择' },
              { value: 'disabled', label: '全部关闭' }
            ]}
          />
        </Space>

        {mode === 'allowlist' ? (
          <Space direction="vertical" size={8}>
            <Typography.Text strong>允许的 MCP</Typography.Text>
            {MCP_OPTIONS.map((item) => (
              <Checkbox
                key={item.id}
                checked={allow.includes(item.id)}
                onChange={(event) => {
                  setAllow((current) =>
                    event.target.checked
                      ? Array.from(new Set([...current, item.id]))
                      : current.filter((id) => id !== item.id)
                  );
                }}
              >
                {item.label}
              </Checkbox>
            ))}
          </Space>
        ) : null}

        <div>
          <Typography.Text strong>生效的 MCP</Typography.Text>
          <div style={{ marginTop: 8 }}>
            {resolved.length === 0 ? (
              <Typography.Text type="secondary">当前没有启用的 MCP</Typography.Text>
            ) : (
              <Space direction="vertical" size={6}>
                {resolved.map((item) => (
                  <div key={item.id}>
                    <Typography.Text>{item.displayName || item.id}</Typography.Text>
                    <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                      {item.source} · {item.reason}
                    </Typography.Text>
                  </div>
                ))}
              </Space>
            )}
          </div>
        </div>

        {message ? <Typography.Text type="success">{message}</Typography.Text> : null}
        {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}

        <Button type="primary" loading={saving} onClick={() => void save()}>
          保存
        </Button>
      </Space>
    </Spin>
  );
}
