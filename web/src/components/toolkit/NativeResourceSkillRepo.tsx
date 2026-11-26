import { useMemo, useState } from 'react';
import { Button, Switch, Table, Tag, Typography, message } from 'antd';
import { toolkitAPI } from '@/services/api';
import type {
  NativeResourceInstallCandidate,
  NativeResourceReport
} from '@/types';

interface Props {
  report: NativeResourceReport | null;
  onChanged: () => void | Promise<void>;
}

type RepoAction = 'install' | 'enable' | 'disable';

function providerState(
  report: NativeResourceReport | null,
  candidate: NativeResourceInstallCandidate,
  provider: string
) {
  return (report?.managed.skill || []).find(
    (record) => record.id === candidate.id && record.provider === provider
  );
}

export default function NativeResourceSkillRepo({ report, onChanged }: Props) {
  const [link, setLink] = useState(true);
  const [busy, setBusy] = useState('');

  const candidates = useMemo(
    () => (report?.installCandidates || []).filter((item) => item.kind === 'skill'),
    [report]
  );
  const providers = useMemo(
    () => (report?.providers || []).filter((row) => {
      const capability = row.resources.skill;
      return capability && capability.state !== '' && capability.state !== 'unsupported';
    }),
    [report]
  );

  const operate = async (
    action: RepoAction,
    candidate: NativeResourceInstallCandidate,
    provider: string
  ) => {
    const key = `${candidate.id}:${provider}:${action}`;
    setBusy(key);
    try {
      const capability = providers.find((row) => row.provider === provider)?.resources.skill;
      const useLink = action === 'install' && link && capability?.mode !== 'projection-only';
      await toolkitAPI.operateNativeResource({
        kind: 'skill',
        action,
        ...(action === 'install'
          ? { source: candidate.source, ...(useLink ? { link: true } : {}) }
          : { id: candidate.id }),
        provider
      });
      await onChanged();
      message.success(
        action === 'install'
          ? `${candidate.id} 已安装到 ${provider}`
          : `${candidate.id} · ${provider} ${action === 'enable' ? '已启用' : '已停用'}`
      );
    } catch (error) {
      message.error(error instanceof Error ? error.message : `${candidate.id} 操作失败`);
    } finally {
      setBusy('');
    }
  };

  if (!report) return null;

  if (!candidates.length) {
    return (
      <Typography.Text type="secondary" style={{ display: 'block', padding: '8px 0' }}>
        未发现可用 Skill。可把 Skill 目录放到 ~/.ai_home/skills，或使用「安装资源」导入。
      </Typography.Text>
    );
  }

  const columns = [
    {
      title: 'Skill',
      dataIndex: 'id',
      key: 'id',
      fixed: 'left' as const,
      width: 220,
      render: (_: unknown, entry: NativeResourceInstallCandidate) => (
        <div>
          <Typography.Text strong>{entry.id}</Typography.Text>
          <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
            {entry.description || '无描述'}
          </Typography.Text>
        </div>
      )
    },
    {
      title: '来源',
      dataIndex: 'origin',
      key: 'origin',
      width: 90,
      render: (origin?: string) => (
        <Tag>{origin === 'user' ? '用户仓' : '内置'}</Tag>
      )
    },
    ...providers.map((row) => ({
      title: row.provider,
      key: row.provider,
      width: 150,
      render: (_: unknown, entry: NativeResourceInstallCandidate) => {
        const record = providerState(report, entry, row.provider);
        if (!record) {
          return (
            <Button
              size="small"
              type="link"
              loading={busy === `${entry.id}:${row.provider}:install`}
              onClick={() => void operate('install', entry, row.provider)}
            >
              安装
            </Button>
          );
        }
        if (record.enabled) {
          return (
            <span>
              <Tag color="success">
                已启用{record.mode === 'link' ? ' · 链接' : ''}
              </Tag>
              <Button
                size="small"
                type="link"
                loading={busy === `${entry.id}:${row.provider}:disable`}
                onClick={() => void operate('disable', entry, row.provider)}
              >
                停用
              </Button>
            </span>
          );
        }
        return (
          <span>
            <Tag>已停用</Tag>
            <Button
              size="small"
              type="link"
              loading={busy === `${entry.id}:${row.provider}:enable`}
              onClick={() => void operate('enable', entry, row.provider)}
            >
              启用
            </Button>
          </span>
        );
      }
    }))
  ];

  return (
    <div style={{ padding: '8px 0 4px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
        <div>
          <Typography.Text strong>Skill 仓</Typography.Text>
          <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
            内置与 ~/.ai_home/skills；按 Provider 安装、启用或停用。
          </Typography.Text>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Switch size="small" checked={link} onChange={setLink} />
          <Typography.Text type="secondary">新安装使用链接投影</Typography.Text>
        </div>
      </div>
      <Table
        size="small"
        rowKey={(entry) => entry.id}
        columns={columns}
        dataSource={candidates}
        pagination={false}
        scroll={{ x: 'max-content' }}
      />
    </div>
  );
}
