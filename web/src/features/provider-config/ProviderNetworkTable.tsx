import { Empty, Space, Table, Tag, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { SettingOutlined, ThunderboltOutlined, UndoOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import type { EgressAccountProbeResult } from '@/features/egress-upstream/types';
import {
  describeProbeResult,
  describeRowEgress,
  describeRowNetwork,
  type ProviderNetworkRow
} from './provider-network-model';

const TONE_COLOR: Record<string, 'success' | 'error' | 'default' | 'processing' | 'warning'> = {
  success: 'success',
  error: 'error',
  default: 'default',
  processing: 'processing',
  warning: 'warning'
};

interface ProviderNetworkTableProps {
  rows: ProviderNetworkRow[];
  probes: Record<string, EgressAccountProbeResult>;
  busy: string;
  sshNames: Record<string, string>;
  onOpen: (row: ProviderNetworkRow) => void;
  onProbe: (row: ProviderNetworkRow) => void;
  onRestore: (row: ProviderNetworkRow) => void;
  onOpenAll: () => void;
}

export default function ProviderNetworkTable({
  rows,
  probes,
  busy,
  sshNames,
  onOpen,
  onProbe,
  onRestore,
  onOpenAll
}: ProviderNetworkTableProps) {
  const columns: ColumnsType<ProviderNetworkRow> = [
    {
      title: '账号',
      key: 'account',
      render: (_value, row) => (
        <div className="pn-account">
          <span>{row.label}</span>
          {row.label !== row.accountRef ? <small>{row.accountRef}</small> : null}
        </div>
      )
    },
    {
      title: '出口',
      key: 'egress',
      width: 190,
      render: (_value, row) => {
        const egress = describeRowEgress(row);
        const sshName = row.entry?.egress?.mode === 'ssh'
          ? sshNames[String(row.entry.egress.proxyUrl || '')]
          : '';
        return (
          <div className="pn-cell">
            <Tag bordered={false} color={TONE_COLOR[egress.tone]}>{egress.label}</Tag>
            <small>{sshName || egress.detail}</small>
          </div>
        );
      }
    },
    {
      title: '当前网络',
      key: 'network',
      width: 220,
      render: (_value, row) => {
        const network = describeRowNetwork(row);
        return (
          <Tooltip title={network.detail}>
            <div className="pn-cell">
              <span className="pn-network-text">{network.geoText}</span>
              <Tag bordered={false} color={TONE_COLOR[network.verdictTone]}>{network.verdictLabel}</Tag>
            </div>
          </Tooltip>
        );
      }
    },
    {
      title: '最近测试',
      key: 'probe',
      width: 200,
      render: (_value, row) => {
        const result = probes[row.accountRef];
        if (!result) return <span className="pn-muted">未测试</span>;
        const summary = describeProbeResult(result);
        return (
          <Tooltip title={summary.detail}>
            <div className="pn-cell">
              <Tag bordered={false} color={TONE_COLOR[summary.tone]}>{summary.label}</Tag>
              <small className="pn-ellipsis">{summary.detail}</small>
            </div>
          </Tooltip>
        );
      }
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_value, row) => {
        const egress = describeRowEgress(row);
        return (
          <Space size={4}>
            <Tooltip title="设置这个账号的出口">
              <Button
                size="small"
                icon={<SettingOutlined />}
                onClick={() => onOpen(row)}
                aria-label={`设置 ${row.label} 的出口`}
              />
            </Tooltip>
            <Tooltip title="通过该账号当前出口真实请求一次上游">
              <Button
                size="small"
                icon={<ThunderboltOutlined />}
                loading={busy === `probe:${row.accountRef}`}
                disabled={!row.upstream}
                onClick={() => onProbe(row)}
                aria-label={`测试 ${row.label} 的网络连接`}
              />
            </Tooltip>
            {egress.bound ? (
              <Tooltip title="恢复默认（OAuth 授权网络）">
                <Button
                  size="small"
                  icon={<UndoOutlined />}
                  loading={busy === `restore:${row.accountRef}`}
                  onClick={() => onRestore(row)}
                  aria-label={`恢复 ${row.label} 的默认网络`}
                />
              </Tooltip>
            ) : null}
          </Space>
        );
      }
    }
  ];

  return (
    <>
      <div className="pn-toolbar">
        <Button size="small" icon={<SettingOutlined />} disabled={!rows.length} onClick={onOpenAll}>
          为全部账号设置出口
        </Button>
        <span className="pn-muted">
          {rows.length ? `共 ${rows.length} 个账号；未单独设置的账号跟随默认网络。` : '该 Provider 还没有账号。'}
        </span>
      </div>

      {rows.length ? (
        <Table
          className="pn-table"
          rowKey="accountRef"
          size="small"
          columns={columns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 900 }}
        />
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该 Provider 暂无账号" />
      )}
    </>
  );
}
