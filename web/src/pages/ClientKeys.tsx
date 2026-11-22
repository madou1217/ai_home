import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, InputNumber, Modal, Space, Switch, Table, Tag, message } from 'antd';
import { DeleteOutlined, PlusOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import type { ClientKeyRow } from '@/types';
import { clientKeysAPI } from '@/services/api';
import { writeClipboardText } from '@/utils/clipboard';

/**
 * 客户端 API Key 管理。
 *
 * - 总 key（master）由 server 配置提供，这里只展示与统计；
 * - 托管 Key 可创建/停用/改名/轮换/撤销，secret 只在创建和轮换时显示一次；
 * - 并发/速率字段本轮只展示，标注“未生效”。
 */
const ClientKeysPanel: React.FC = () => {
  const [rows, setRows] = useState<ClientKeyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState('');
  const [secretTitle, setSecretTitle] = useState('');
  const [form] = Form.useForm<{ name: string; maxConcurrency: number; rpmLimit: number; tpmLimit: number }>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await clientKeysAPI.list());
    } catch {
      message.error('读取 API Key 列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const managed = useMemo(() => rows.filter((row) => !row.master), [rows]);

  const create = async () => {
    let values: { name: string; maxConcurrency: number; rpmLimit: number; tpmLimit: number };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setCreating(true);
    try {
      const result = await clientKeysAPI.create({
        name: values.name,
        limits: {
          maxConcurrency: Number(values.maxConcurrency || 0),
          rpmLimit: Number(values.rpmLimit || 0),
          tpmLimit: Number(values.tpmLimit || 0)
        }
      });
      setCreateOpen(false);
      form.resetFields();
      setSecretTitle(`已创建 ${result.key.name}（${result.key.prefix}）`);
      setSecret(result.secret);
      await load();
    } catch (error: unknown) {
      message.error((error as { message?: string })?.message || '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const toggle = async (row: ClientKeyRow, enabled: boolean) => {
    try {
      await clientKeysAPI.update(row.id, { enabled });
      message.success(enabled ? '已启用' : '已停用');
      await load();
    } catch {
      message.error('保存失败');
    }
  };

  const rotate = (row: ClientKeyRow) => {
    Modal.confirm({
      title: `轮换 ${row.name} 的密钥？`,
      content: '旧 secret 会立即失效；正在进行的请求不受影响。',
      okText: '轮换',
      cancelText: '取消',
      onOk: async () => {
        try {
          const next = await clientKeysAPI.rotate(row.id);
          setSecretTitle(`已轮换 ${row.name}（${row.prefix}）`);
          setSecret(next);
          await load();
        } catch {
          message.error('轮换失败');
        }
      }
    });
  };

  const remove = (row: ClientKeyRow) => {
    Modal.confirm({
      title: `撤销 ${row.name}？`,
      content: '撤销后该 Key 立即无法鉴权；历史统计保留。',
      okText: '撤销',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await clientKeysAPI.revoke(row.id);
          message.success('已撤销');
          await load();
        } catch {
          message.error('撤销失败');
        }
      }
    });
  };

  const copySecret = async () => {
    if (!secret) return;
    await writeClipboardText(secret);
    message.success('已复制');
  };

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (value: string, row: ClientKeyRow) => (
        <Space size={6}>
          <span>{value}</span>
          {row.master ? <Tag>总 key</Tag> : null}
          {!row.master && row.enabled === false ? <Tag>已停用</Tag> : null}
        </Space>
      )
    },
    {
      title: '前缀',
      dataIndex: 'prefix',
      render: (value: string) => <span className="aih-mono">{value || '—'}</span>
    },
    {
      title: '启用',
      key: 'enabled',
      width: 80,
      render: (_: unknown, row: ClientKeyRow) =>
        row.master ? <span className="aih-muted">—</span> : (
          <Switch size="small" checked={row.enabled !== false} onChange={(next) => void toggle(row, next)} />
        )
    },
    {
      title: '并发上限',
      key: 'maxConcurrency',
      width: 110,
      render: (_: unknown, row: ClientKeyRow) => (
        <Space size={4}>
          <span>{row.limits?.maxConcurrency || '不限'}</span>
          <Tag>未生效</Tag>
        </Space>
      )
    },
    {
      title: '在途',
      key: 'inFlight',
      width: 70,
      render: (_: unknown, row: ClientKeyRow) => row.live?.inFlight ?? 0
    },
    {
      title: 'RPM (1m)',
      key: 'rpm',
      width: 90,
      render: (_: unknown, row: ClientKeyRow) => Math.round(row.live?.rpm1m || 0)
    },
    {
      title: 'TPM (1m)',
      key: 'tpm',
      width: 110,
      render: (_: unknown, row: ClientKeyRow) => Math.round(row.live?.tpm1m || 0)
    },
    {
      title: '24h 请求',
      key: 'requests',
      width: 100,
      render: (_: unknown, row: ClientKeyRow) => row.totals?.requests ?? 0
    },
    {
      title: '24h Tokens',
      key: 'tokens',
      width: 110,
      render: (_: unknown, row: ClientKeyRow) => row.totals?.totalTokens ?? 0
    },
    {
      title: '最后使用',
      key: 'lastUsed',
      width: 130,
      render: (_: unknown, row: ClientKeyRow) =>
        row.lastUsedAtMs ? new Date(row.lastUsedAtMs).toLocaleString() : <span className="aih-muted">—</span>
    },
    {
      title: '操作',
      key: 'actions',
      width: 180,
      render: (_: unknown, row: ClientKeyRow) =>
        row.master ? null : (
          <Space size={4}>
            <Button size="small" icon={<SyncOutlined />} onClick={() => rotate(row)}>轮换</Button>
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => remove(row)}>撤销</Button>
          </Space>
        )
    }
  ];

  return (
    <div className="client-keys-panel">
      <Space style={{ marginBottom: 12 }} wrap>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建 API Key</Button>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>
        <span className="aih-muted">并发/速率字段本轮只存储与展示，尚未执行；创建与轮换的 secret 只显示一次。</span>
      </Space>
      <Table
        size="small"
        rowKey="id"
        loading={loading}
        pagination={false}
        dataSource={rows}
        columns={columns}
      />
      <Modal
        open={createOpen}
        title="新建客户端 API Key"
        okText="创建"
        cancelText="取消"
        confirmLoading={creating}
        onOk={() => void create()}
        onCancel={() => setCreateOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：laptop / build-server" maxLength={80} />
          </Form.Item>
          <Form.Item name="maxConcurrency" label="最大并发（未生效）" initialValue={0}>
            <InputNumber min={0} max={64} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="rpmLimit" label="RPM 上限（未生效）" initialValue={0}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="tpmLimit" label="TPM 上限（未生效）" initialValue={0}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        open={Boolean(secret)}
        title={secretTitle || 'Secret'}
        onCancel={() => setSecret('')}
        footer={<Button type="primary" onClick={() => void copySecret()}>复制并关闭</Button>}
        destroyOnClose
      >
        <p className="aih-muted">此密钥只显示一次，关闭后无法再次查看。</p>
        <Input.TextArea value={secret} readOnly autoSize={{ minRows: 2, maxRows: 4 }} />
      </Modal>
      {managed.length === 0 && !loading ? (
        <div className="aih-muted" style={{ marginTop: 8 }}>还没有托管的 API Key；总 key 仍然可用。</div>
      ) : null}
    </div>
  );
};

export default ClientKeysPanel;