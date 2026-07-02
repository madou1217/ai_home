import { useCallback, useEffect, useState } from 'react';
import { Alert, Space, Spin, Table, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { fetchControlPlaneDeviceAccounts } from '@/services/control-plane-profiles';
import type { ServerContext } from '@/services/server-context';

/* 远端 server 的账号只读视图（R1）。
 * 数据来自远端设备接口 /v0/node-rpc/device-accounts（只读摘要）；
 * 增删改导入等管理动作只能在该 server 本机进行，此处如实标注、不伪造。 */

interface RemoteAccountRow {
  accountRef: string;
  provider: string;
  label: string;
  status: string;
  authMode: string;
  planType: string;
  runtimeStatus: string;
  schedulableStatus: string;
  remainingPct: number | null;
}

const PROVIDER_LABEL: Record<string, string> = { codex: 'Codex', claude: 'Claude', agy: 'AGY', opencode: 'OpenCode', gemini: 'Gemini' };

function providerLabel(provider: string) {
  return PROVIDER_LABEL[String(provider || '').toLowerCase()] || provider || '未知';
}

function statusColor(status: string) {
  return status === 'up' ? 'success' : 'default';
}

// 把 schedulableStatus 的英文码翻成大白话；'schedulable' 无需额外标签。
function schedulableLabel(status: string): string | null {
  const key = String(status || '').toLowerCase();
  if (!key || key === 'schedulable') return null;
  const map: Record<string, string> = {
    cooldown: '熔断中',
    blocked_by_runtime_status: '运行时不可用',
    blocked_by_quota_status: '额度不足',
    disabled: '已停用',
    down: '离线'
  };
  return map[key] || '不可调度';
}

export default function RemoteAccountsSummary({ context }: { context: ServerContext }) {
  const [rows, setRows] = useState<RemoteAccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!context.profile || !context.deviceToken) {
      setError('当前 server 未配对（缺少设备令牌）。');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await fetchControlPlaneDeviceAccounts({
        endpoint: context.endpoint,
        deviceToken: context.deviceToken
      });
      setRows(Array.isArray(result.accounts) ? (result.accounts as RemoteAccountRow[]) : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err || '读取远端账号失败'));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [context.endpoint, context.deviceToken, context.profile]);

  // 切换 server 立刻清空到 loading，避免看串上一台的数据。
  useEffect(() => {
    setRows([]);
    setError('');
    setLoading(true);
    void load();
  }, [load]);

  const columns = [
    {
      title: '账号',
      dataIndex: 'label',
      key: 'label',
      render: (_: unknown, row: RemoteAccountRow) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{row.label || row.accountRef}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{providerLabel(row.provider)} · {row.authMode}</Typography.Text>
        </Space>
      )
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (_: unknown, row: RemoteAccountRow) => (
        <Space size={4} wrap>
          <Tag color={statusColor(row.status)}>{row.status === 'up' ? '在线' : '离线'}</Tag>
          {schedulableLabel(row.schedulableStatus) ? <Tag>{schedulableLabel(row.schedulableStatus)}</Tag> : null}
        </Space>
      )
    },
    { title: '套餐', dataIndex: 'planType', key: 'planType', render: (v: string) => v || '—' },
    {
      title: '余量',
      dataIndex: 'remainingPct',
      key: 'remainingPct',
      render: (v: number | null) => (v == null ? '未知' : `${Math.round(v)}%`)
    }
  ];

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={`正在查看远端 server「${context.displayName}」的账号（只读）`}
        description="远端账号的添加 / 编辑 / 删除 / 导入需在该 server 本机操作；此处仅展示其账号与状态。"
        action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} disabled={loading}>刷新</Button>}
      />
      {error
        ? <Alert type="error" showIcon message={error} />
        : (
          <Spin spinning={loading}>
            <Table<RemoteAccountRow>
              rowKey="accountRef"
              size="small"
              columns={columns}
              dataSource={rows}
              pagination={false}
              locale={{ emptyText: loading ? '加载中…' : '该 server 暂无账号' }}
            />
          </Spin>
        )}
    </div>
  );
}
