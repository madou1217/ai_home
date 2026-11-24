import { Modal, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ApiOutlined,
  DeleteOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import type { NativeResourceAction, NativeResourceManagedRecord } from '@/types';
import {
  KIND_LABELS,
  isEnabled,
  resourceKey,
  resourceOwner,
  resourceSummary
} from './native-resource-grouping';
import type { NativeResourceGroup } from './native-resource-grouping';

type ManagedAction = Extract<NativeResourceAction, 'enable' | 'disable' | 'remove' | 'test'>;

interface Props {
  group: NativeResourceGroup | null;
  busy: string;
  onClose: () => void;
  onAction: (record: NativeResourceManagedRecord, action: ManagedAction) => Promise<boolean>;
}

export default function NativeResourceDetailModal({ group, busy, onClose, onAction }: Props) {
  const declarations = group
    ? Array.from(new Set(group.records.flatMap((record) => record.declaration || [])))
    : [];
  const columns: ColumnsType<NativeResourceManagedRecord> = [
    {
      title: '宿主',
      key: 'owner',
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{resourceOwner(record)}</Typography.Text>
          <Typography.Text type="secondary">{resourceSummary(record)}</Typography.Text>
        </Space>
      )
    },
    {
      title: '状态',
      key: 'state',
      width: 90,
      render: (_, record) => (
        <Tag color={isEnabled(record) ? 'success' : 'default'}>{isEnabled(record) ? '已启用' : '已停用'}</Tag>
      )
    },
    {
      title: '版本 / 摘要',
      key: 'version',
      width: 130,
      render: (_, record) => (
        <Typography.Text type="secondary">
          {record.version || (record.digest ? record.digest.slice(0, 8) : '-')}
        </Typography.Text>
      )
    },
    {
      title: '投影',
      dataIndex: 'target',
      key: 'target',
      render: (value?: string) => <Typography.Text type="secondary">{value || '-'}</Typography.Text>
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      render: (_, record) => {
        const key = resourceKey(record);
        return (
          <Space wrap size={4}>
            <Button
              size="small"
              icon={isEnabled(record) ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
              disabled={Boolean(busy)}
              loading={busy === `${key}:${isEnabled(record) ? 'disable' : 'enable'}`}
              onClick={() => void onAction(record, isEnabled(record) ? 'disable' : 'enable')}
            >{isEnabled(record) ? '停用' : '启用'}</Button>
            {record.kind === 'mcp' ? (
              <Button
                size="small"
                icon={<ApiOutlined />}
                disabled={Boolean(busy)}
                loading={busy === `${key}:test`}
                onClick={() => void onAction(record, 'test')}
              >测试</Button>
            ) : null}
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              disabled={Boolean(busy)}
              loading={busy === `${key}:remove`}
              onClick={() => void onAction(record, 'remove')}
            >移除</Button>
          </Space>
        );
      }
    }
  ];

  return (
    <Modal
      open={Boolean(group)}
      title={group ? `${group.id} · ${KIND_LABELS[group.kind]}` : ''}
      footer={null}
      width={860}
      onCancel={onClose}
      destroyOnClose
    >
      {group ? (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <div>
            <Typography.Text type="secondary">它能做什么</Typography.Text>
            <Typography.Paragraph style={{ margin: '4px 0 0' }}>
              {group.description || '该资源未提供描述。插件可查看 package.json，Skill 可查看 SKILL.md。'}
            </Typography.Paragraph>
          </div>
          <Space wrap size={16}>
            <Typography.Text type="secondary">标识：{group.id}</Typography.Text>
            {group.version ? <Typography.Text type="secondary">版本：{group.version}</Typography.Text> : null}
            <Typography.Text type="secondary">宿主数：{group.records.length}</Typography.Text>
            <Typography.Text type="secondary">平面：Harness 原生资源</Typography.Text>
          </Space>
          {declarations.length ? (
            <div>
              <Typography.Text type="secondary">声明</Typography.Text>
              <Space wrap size={[6, 6]} style={{ marginTop: 4 }}>
                {declarations.map((item) => <Tag key={item}>{item}</Tag>)}
              </Space>
            </div>
          ) : null}
          <Table
            size="small"
            rowKey={resourceKey}
            columns={columns}
            dataSource={group.records}
            pagination={false}
            scroll={{ x: 720 }}
          />
          <Typography.Text type="secondary">
            同一份资源按 Provider / Harness 分别投影；此处逐行启停只影响对应宿主。
          </Typography.Text>
        </Space>
      ) : null}
    </Modal>
  );
}
