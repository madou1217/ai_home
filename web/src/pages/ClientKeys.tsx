import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Form, Input, InputNumber, Modal, Space, Switch, Table, Tag, Tooltip, message } from 'antd';
import { DeleteOutlined, PlusOutlined, ReloadOutlined, SettingOutlined, SyncOutlined } from '@ant-design/icons';
import type { ClientKeyRow } from '@/types';
import { clientKeysAPI } from '@/services/api';
import { writeClipboardText } from '@/utils/clipboard';
import Button from '@/components/ui/AppButton';
import SettingSection, { SettingRow } from '@/components/ui/SettingSection';
import SettingStatusTag, { type SettingStatusState } from '@/components/ui/SettingStatusTag';
import SaveActionBar from '@/components/ui/SaveActionBar';
import '@/components/settings/gateway-settings.css';

type LimitFormValues = {
  maxConcurrency: number;
  rpmLimit: number;
  tpmLimit: number;
  dailyTokenLimit: number;
};

type InlineFeedback = {
  tone: 'success' | 'error';
  text: string;
};

function readLimitValues(row: ClientKeyRow | null): LimitFormValues {
  return {
    maxConcurrency: Number(row?.limits?.maxConcurrency || 0),
    rpmLimit: Number(row?.limits?.rpmLimit || 0),
    tpmLimit: Number(row?.limits?.tpmLimit || 0),
    dailyTokenLimit: Number(row?.limits?.dailyTokenLimit || 0)
  };
}

function limitsEqual(left: LimitFormValues, right: LimitFormValues) {
  return left.maxConcurrency === right.maxConcurrency
    && left.rpmLimit === right.rpmLimit
    && left.tpmLimit === right.tpmLimit
    && left.dailyTokenLimit === right.dailyTokenLimit;
}

function formatLimitText(limits?: ClientKeyRow['limits']) {
  return `并发 ${limits?.maxConcurrency || '不限'} · RPM ${limits?.rpmLimit || '不限'} · TPM ${limits?.tpmLimit || '不限'} · 日 Tokens ${limits?.dailyTokenLimit || '不限'}`;
}

/**
 * 客户端 API Key 管理。
 *
 * - 总 key（master）由 server 配置提供，这里只展示与统计；
 * - 托管 Key 可创建/停用/轮换/撤销与调整限额，secret 只在创建与轮换时展示一次。
 */
const ClientKeysPanel: React.FC = () => {
  const [rows, setRows] = useState<ClientKeyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [panelFeedback, setPanelFeedback] = useState<InlineFeedback | null>(null);
  const [togglingKeyId, setTogglingKeyId] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createFeedback, setCreateFeedback] = useState<InlineFeedback | null>(null);
  const [secret, setSecret] = useState('');
  const [secretTitle, setSecretTitle] = useState('');

  const [editingKey, setEditingKey] = useState<ClientKeyRow | null>(null);
  const [savingLimits, setSavingLimits] = useState(false);
  const [limitFeedback, setLimitFeedback] = useState<InlineFeedback | null>(null);

  const [form] = Form.useForm<{ name: string } & LimitFormValues>();
  const [limitForm] = Form.useForm<LimitFormValues>();

  const watchedCreateName = Form.useWatch('name', form);
  const watchedLimits = Form.useWatch([], limitForm) as Partial<LimitFormValues> | undefined;

  const load = useCallback(async (quiet = true) => {
    setLoading(true);
    try {
      setRows(await clientKeysAPI.list());
      if (!quiet) {
        setPanelFeedback({ tone: 'success', text: '已同步最新 API Key 列表' });
      }
    } catch (error: unknown) {
      const errorText = (error as { message?: string })?.message || '读取 API Key 列表失败';
      setPanelFeedback({ tone: 'error', text: errorText });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const managed = useMemo(() => rows.filter((row) => !row.master), [rows]);
  const persistedLimits = useMemo(() => readLimitValues(editingKey), [editingKey]);
  const draftLimits = useMemo<LimitFormValues>(() => ({
    maxConcurrency: Number(watchedLimits?.maxConcurrency ?? persistedLimits.maxConcurrency),
    rpmLimit: Number(watchedLimits?.rpmLimit ?? persistedLimits.rpmLimit),
    tpmLimit: Number(watchedLimits?.tpmLimit ?? persistedLimits.tpmLimit),
    dailyTokenLimit: Number(watchedLimits?.dailyTokenLimit ?? persistedLimits.dailyTokenLimit)
  }), [persistedLimits, watchedLimits]);

  const limitsDirty = Boolean(editingKey) && !limitsEqual(draftLimits, persistedLimits);
  const createDirty = Boolean(String(watchedCreateName || '').trim());

  const panelStatus: { status: SettingStatusState; label: string } = loading
    ? { status: 'saving', label: '同步中' }
    : panelFeedback?.tone === 'error'
      ? { status: 'error', label: '操作失败' }
      : { status: 'applied', label: `已生效 · ${managed.length} 个托管 Key` };

  const openCreateModal = () => {
    form.resetFields();
    form.setFieldsValue({
      name: '',
      maxConcurrency: 0,
      rpmLimit: 0,
      tpmLimit: 0,
      dailyTokenLimit: 0
    });
    setCreateFeedback(null);
    setCreateOpen(true);
  };

  const create = async () => {
    let values: { name: string } & LimitFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setCreating(true);
    setCreateFeedback(null);
    try {
      const result = await clientKeysAPI.create({
        name: values.name.trim(),
        limits: {
          maxConcurrency: Number(values.maxConcurrency || 0),
          rpmLimit: Number(values.rpmLimit || 0),
          tpmLimit: Number(values.tpmLimit || 0),
          dailyTokenLimit: Number(values.dailyTokenLimit || 0)
        }
      });
      setCreateOpen(false);
      form.resetFields();
      setSecretTitle(`已创建 ${result.key.name}（${result.key.prefix}）`);
      setSecret(result.secret);
      setPanelFeedback({ tone: 'success', text: `已创建 ${result.key.name} 并立即生效` });
      await load(true);
    } catch (error: unknown) {
      setCreateFeedback({
        tone: 'error',
        text: (error as { message?: string })?.message || '创建失败'
      });
    } finally {
      setCreating(false);
    }
  };

  const toggle = async (row: ClientKeyRow, enabled: boolean) => {
    setTogglingKeyId(row.id);
    setPanelFeedback(null);
    try {
      await clientKeysAPI.update(row.id, { enabled });
      setPanelFeedback({
        tone: 'success',
        text: `${row.name} 已${enabled ? '启用' : '停用'}并立即生效`
      });
      await load(true);
    } catch (error: unknown) {
      setPanelFeedback({
        tone: 'error',
        text: (error as { message?: string })?.message || `更新 ${row.name} 状态失败`
      });
    } finally {
      setTogglingKeyId('');
    }
  };

  const openLimits = (row: ClientKeyRow) => {
    setEditingKey(row);
    setLimitFeedback(null);
    limitForm.setFieldsValue(readLimitValues(row));
  };

  const saveLimits = async () => {
    if (!editingKey || !limitsDirty) return;
    let values: LimitFormValues;
    try {
      values = await limitForm.validateFields();
    } catch {
      return;
    }
    setSavingLimits(true);
    setLimitFeedback(null);
    try {
      const nextLimits: LimitFormValues = {
        maxConcurrency: Number(values.maxConcurrency || 0),
        rpmLimit: Number(values.rpmLimit || 0),
        tpmLimit: Number(values.tpmLimit || 0),
        dailyTokenLimit: Number(values.dailyTokenLimit || 0)
      };
      await clientKeysAPI.update(editingKey.id, { limits: nextLimits });
      setEditingKey({ ...editingKey, limits: nextLimits });
      setLimitFeedback({ tone: 'success', text: '限额已保存并立即生效' });
      setPanelFeedback({ tone: 'success', text: `已更新 ${editingKey.name} 的限额并立即生效` });
      await load(true);
    } catch (error: unknown) {
      setLimitFeedback({
        tone: 'error',
        text: (error as { message?: string })?.message || '保存失败'
      });
    } finally {
      setSavingLimits(false);
    }
  };

  const rotate = (row: ClientKeyRow) => {
    Modal.confirm({
      title: `轮换 ${row.name} 的密钥？`,
      content: '旧密钥会立即失效；正在进行的请求不受影响。',
      okText: '轮换',
      cancelText: '取消',
      onOk: async () => {
        try {
          const next = await clientKeysAPI.rotate(row.id);
          setSecretTitle(`已轮换 ${row.name}（${row.prefix}）`);
          setSecret(next);
          setPanelFeedback({ tone: 'success', text: `已轮换 ${row.name} 的密钥` });
          await load(true);
        } catch (error: unknown) {
          setPanelFeedback({
            tone: 'error',
            text: (error as { message?: string })?.message || '轮换失败'
          });
        }
      }
    });
  };

  const remove = (row: ClientKeyRow) => {
    Modal.confirm({
      title: `撤销 ${row.name}？`,
      content: '撤销后该 Key 立即无法鉴权，历史统计保留。',
      okText: '撤销',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await clientKeysAPI.revoke(row.id);
          setPanelFeedback({ tone: 'success', text: `已撤销 ${row.name}` });
          await load(true);
        } catch (error: unknown) {
          setPanelFeedback({
            tone: 'error',
            text: (error as { message?: string })?.message || '撤销失败'
          });
        }
      }
    });
  };

  const copySecret = async () => {
    if (!secret) return;
    try {
      await writeClipboardText(secret);
      message.success('密钥已复制');
      setSecret('');
    } catch {
      message.error('复制失败，请手动复制');
    }
  };

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      width: 160,
      render: (value: string, row: ClientKeyRow) => (
        <Space size={6} className="gateway-nowrap">
          <span>{value}</span>
          {row.master ? <Tag bordered={false}>总 key</Tag> : null}
        </Space>
      )
    },
    {
      title: '前缀',
      dataIndex: 'prefix',
      width: 110,
      render: (value: string) => <span className="aih-mono gateway-nowrap">{value || '—'}</span>
    },
    {
      title: '状态',
      key: 'enabled',
      width: 140,
      render: (_: unknown, row: ClientKeyRow) =>
        row.master ? (
          <SettingStatusTag status="applied" label="系统总 key" compact live="off" />
        ) : (
          <Space size={6}>
            <Switch
              size="small"
              loading={togglingKeyId === row.id}
              checked={row.enabled !== false}
              onChange={(next) => void toggle(row, next)}
            />
            <SettingStatusTag
              status={row.enabled === false ? 'unset' : 'applied'}
              label={row.enabled === false ? '已停用' : '已启用'}
              compact
              live="off"
            />
          </Space>
        )
    },
    {
      title: '已生效限额',
      key: 'limits',
      width: 300,
      render: (_: unknown, row: ClientKeyRow) => {
        const text = formatLimitText(row.limits);
        return (
          <Tooltip title={text}>
            <span className="gateway-limit-summary gateway-ellipsis">{text}</span>
          </Tooltip>
        );
      }
    },
    {
      title: '在途',
      key: 'inFlight',
      width: 70,
      align: 'right' as const,
      render: (_: unknown, row: ClientKeyRow) => row.live?.inFlight ?? 0
    },
    {
      title: 'RPM (1m)',
      key: 'rpm',
      width: 90,
      align: 'right' as const,
      render: (_: unknown, row: ClientKeyRow) => Math.round(row.live?.rpm1m || 0)
    },
    {
      title: 'TPM (1m)',
      key: 'tpm',
      width: 100,
      align: 'right' as const,
      render: (_: unknown, row: ClientKeyRow) => Math.round(row.live?.tpm1m || 0)
    },
    {
      title: '24h 请求',
      key: 'requests',
      width: 90,
      align: 'right' as const,
      render: (_: unknown, row: ClientKeyRow) => row.totals?.requests ?? 0
    },
    {
      title: '24h Tokens',
      key: 'tokens',
      width: 100,
      align: 'right' as const,
      render: (_: unknown, row: ClientKeyRow) => row.totals?.totalTokens ?? 0
    },
    {
      title: '最后使用',
      key: 'lastUsed',
      width: 140,
      render: (_: unknown, row: ClientKeyRow) =>
        row.lastUsedAtMs ? (
          <span className="gateway-nowrap">
            {new Date(row.lastUsedAtMs).toLocaleString('zh-CN', {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit'
            })}
          </span>
        ) : (
          <span className="aih-muted">—</span>
        )
    },
    {
      title: '操作',
      key: 'actions',
      width: 230,
      render: (_: unknown, row: ClientKeyRow) =>
        row.master ? null : (
          <Space size={4}>
            <Button size="small" icon={<SettingOutlined />} onClick={() => openLimits(row)}>限额</Button>
            <Button size="small" icon={<SyncOutlined />} onClick={() => rotate(row)}>轮换</Button>
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => remove(row)}>撤销</Button>
          </Space>
        )
    }
  ];

  const limitStatus: SettingStatusState = savingLimits
    ? 'saving'
    : limitFeedback?.tone === 'error'
      ? 'error'
      : limitsDirty
        ? 'dirty'
        : 'applied';

  return (
    <div className="client-keys-panel gateway-settings-stack">
      <SettingSection
        title="客户端 API Key"
        description="管理分发给客户端的独立密钥与限额；密钥仅在创建和轮换时展示一次。"
        status={<SettingStatusTag status={panelStatus.status} label={panelStatus.label} compact />}
        extra={(
          <Space size={8} wrap>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load(false)}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>
              新建 API Key
            </Button>
          </Space>
        )}
      >
        {panelFeedback ? (
          <div
            className={`gateway-inline-feedback gateway-inline-feedback--${panelFeedback.tone}`}
            role={panelFeedback.tone === 'error' ? 'alert' : 'status'}
            aria-live={panelFeedback.tone === 'error' ? 'assertive' : 'polite'}
          >
            <SettingStatusTag
              status={panelFeedback.tone === 'error' ? 'error' : 'applied'}
              label={panelFeedback.tone === 'error' ? '失败' : '已生效'}
              compact
              live="off"
            />
            <span>{panelFeedback.text}</span>
          </div>
        ) : null}

        <Table
          size="small"
          rowKey="id"
          loading={loading}
          pagination={false}
          dataSource={rows}
          columns={columns}
          scroll={{ x: 1530 }}
        />

        {managed.length === 0 && !loading ? (
          <p className="gateway-empty-note">暂无托管 API Key；服务总 key 仍可直接鉴权。</p>
        ) : null}
      </SettingSection>

      <Modal
        open={createOpen}
        title="新建客户端 API Key"
        onCancel={() => setCreateOpen(false)}
        footer={null}
        destroyOnClose
      >
        <p className="gateway-modal-hint">0 表示不限；创建后立即生效，密钥明文仅展示一次。</p>
        <Form
          form={form}
          layout="vertical"
          onValuesChange={() => {
            if (createFeedback) setCreateFeedback(null);
          }}
        >
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：laptop / build-server" maxLength={80} />
          </Form.Item>
          <Form.Item name="maxConcurrency" label="最大并发" initialValue={0}>
            <InputNumber min={0} max={64} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="rpmLimit" label="RPM 上限" initialValue={0}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="tpmLimit" label="TPM 上限" initialValue={0}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="dailyTokenLimit" label="每日 Tokens 上限" initialValue={0}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
        <div className="gateway-modal-footer">
          <SaveActionBar
            dirty={createDirty}
            saving={creating}
            status={creating ? 'saving' : createFeedback?.tone === 'error' ? 'error' : createDirty ? 'dirty' : 'unset'}
            statusLabel={createDirty ? '待创建' : '待填写名称'}
            saveLabel="创建 Key"
            cleanSaveLabel="请填写名称"
            effectSummary="创建后立即生效并展示一次性密钥"
            feedback={createFeedback?.text}
            feedbackTone={createFeedback?.tone ?? 'muted'}
            onSave={() => void create()}
            extraActions={(
              <Button disabled={creating} onClick={() => setCreateOpen(false)}>
                取消
              </Button>
            )}
          />
        </div>
      </Modal>

      <Modal
        open={Boolean(editingKey)}
        title={editingKey ? `编辑 ${editingKey.name} 的限额` : '编辑限额'}
        onCancel={() => setEditingKey(null)}
        footer={null}
        destroyOnClose
      >
        <Form
          form={limitForm}
          layout="vertical"
          onValuesChange={() => {
            if (limitFeedback) setLimitFeedback(null);
          }}
        >
          <SettingRow
            title="最大并发"
            description="0 表示不限。"
            persistedValue={`已应用：${persistedLimits.maxConcurrency || '不限'}`}
            control={(
              <Form.Item name="maxConcurrency" initialValue={0}>
                <InputNumber min={0} max={64} style={{ width: 160 }} />
              </Form.Item>
            )}
          />
          <SettingRow
            title="RPM 上限"
            description="每分钟请求数限制，0 表示不限。"
            persistedValue={`已应用：${persistedLimits.rpmLimit || '不限'}`}
            control={(
              <Form.Item name="rpmLimit" initialValue={0}>
                <InputNumber min={0} style={{ width: 160 }} />
              </Form.Item>
            )}
          />
          <SettingRow
            title="TPM 上限"
            description="每分钟 Tokens 限制，0 表示不限。"
            persistedValue={`已应用：${persistedLimits.tpmLimit || '不限'}`}
            control={(
              <Form.Item name="tpmLimit" initialValue={0}>
                <InputNumber min={0} style={{ width: 160 }} />
              </Form.Item>
            )}
          />
          <SettingRow
            title="每日 Tokens 上限"
            description="自然日累计 Tokens 限制，0 表示不限。"
            persistedValue={`已应用：${persistedLimits.dailyTokenLimit || '不限'}`}
            control={(
              <Form.Item name="dailyTokenLimit" initialValue={0}>
                <InputNumber min={0} style={{ width: 160 }} />
              </Form.Item>
            )}
          />
        </Form>
        <div className="gateway-modal-footer">
          <SaveActionBar
            dirty={limitsDirty}
            saving={savingLimits}
            status={limitStatus}
            saveLabel="保存限额"
            cleanSaveLabel="已应用"
            effectSummary="保存后立即生效，无需重启"
            feedback={limitFeedback?.text}
            feedbackTone={limitFeedback?.tone ?? 'muted'}
            onSave={() => void saveLimits()}
            onReset={() => {
              limitForm.setFieldsValue(persistedLimits);
              setLimitFeedback(null);
            }}
            extraActions={(
              <Button disabled={savingLimits} onClick={() => setEditingKey(null)}>
                关闭
              </Button>
            )}
          />
        </div>
      </Modal>

      <Modal
        open={Boolean(secret)}
        title={secretTitle || '一次性密钥'}
        onCancel={() => setSecret('')}
        footer={(
          <Space>
            <Button onClick={() => setSecret('')}>关闭</Button>
            <Button type="primary" onClick={() => void copySecret()}>复制并关闭</Button>
          </Space>
        )}
        destroyOnClose
      >
        <p className="gateway-modal-hint">此密钥只显示一次，关闭后无法再次查看，请妥善保存。</p>
        <Input.TextArea
          className="gateway-secret-textarea"
          value={secret}
          readOnly
          autoSize={{ minRows: 2, maxRows: 4 }}
        />
      </Modal>
    </div>
  );
};

export default ClientKeysPanel;
