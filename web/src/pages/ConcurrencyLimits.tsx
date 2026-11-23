import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, message } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { Account, AccountConcurrencyLimit, ClientKeyRow, EffectiveConcurrency, GatewayConcurrencyConfig } from '@/types';
import { accountsAPI, clientKeysAPI, concurrencyAPI, configAPI } from '@/services/api';
import { getProviderLabel, providerIds } from '@/providers/catalog';

/**
 * 限流与并发设置。
 *
 * 本轮只存储与预览：全局系统上限、Provider 默认、账号（+模型）覆盖都会保存，
 * 并发与 RPM/TPM 准入均已执行；预览返回 enforced=true。
 */

type AccountLimitRow = AccountConcurrencyLimit & { provider: string };

type GlobalFormValues = GatewayConcurrencyConfig;

type LimitFormValues = {
  provider: string;
  accountRef: string;
  modelId: string;
  maxConcurrency: number;
  rpmLimit: number;
  tpmLimit: number;
};

const DEFAULT_CONCURRENCY: GatewayConcurrencyConfig = {
  systemMax: 0,
  queueLimit: 200,
  queueWaitTimeoutMs: 30000,
  retryAfterSeconds: 1,
  accountDefault: 2,
  providerDefaults: { codex: 2, gemini: 1, claude: 2, agy: 1, opencode: 1 }
};

const chunk = <T,>(values: T[], size: number): T[][] => {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
};

const ConcurrencyLimitsPanel: React.FC = () => {
  const [globalForm] = Form.useForm<GlobalFormValues>();
  const [editorForm] = Form.useForm<LimitFormValues>();
  const [previewForm] = Form.useForm<{ provider: string; account: string; model: string; key: string }>();
  const [loading, setLoading] = useState(false);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [rows, setRows] = useState<AccountLimitRow[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [keys, setKeys] = useState<ClientKeyRow[]>([]);
  const [globalConfig, setGlobalConfig] = useState<GatewayConcurrencyConfig>(DEFAULT_CONCURRENCY);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<AccountLimitRow | null>(null);
  const [savingLimit, setSavingLimit] = useState(false);
  const [preview, setPreview] = useState<EffectiveConcurrency | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const editorProvider = Form.useWatch('provider', editorForm);
  const previewProvider = Form.useWatch('provider', previewForm);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [server, accountList, keyList] = await Promise.all([
        configAPI.getServer(),
        accountsAPI.list().then((result) => result.accounts || []).catch(() => [] as Account[]),
        clientKeysAPI.list().catch(() => [] as ClientKeyRow[])
      ]);
      const config = { ...DEFAULT_CONCURRENCY, ...(server.concurrency || {}) };
      config.providerDefaults = { ...DEFAULT_CONCURRENCY.providerDefaults, ...(server.concurrency?.providerDefaults || {}) };
      setGlobalConfig(config);
      globalForm.setFieldsValue(config);
      setAccounts(accountList);
      setKeys(keyList);

      const groups = await Promise.all(
        chunk(accountList, 6).map(async (group) => {
          const loaded = await Promise.all(
            group.map(async (account) => {
              try {
                const limits = await concurrencyAPI.listAccountLimits(account.provider, account.accountRef);
                return limits.map((limit) => ({ ...limit, provider: account.provider }));
              } catch {
                return [] as AccountLimitRow[];
              }
            })
          );
          return loaded;
        })
      );
      setRows(groups.flat(2));
    } catch {
      message.error('读取限流配置失败');
    } finally {
      setLoading(false);
    }
  }, [globalForm]);

  useEffect(() => {
    void load();
  }, [load]);

  const providerOptions = useMemo(() => {
    const seen = new Set<string>();
    providerIds.forEach((provider) => seen.add(provider));
    accounts.forEach((account) => seen.add(account.provider));
    Object.keys(globalConfig.providerDefaults || {}).forEach((provider) => seen.add(provider));
    return [...seen].sort().map((provider) => ({ value: provider, label: `${getProviderLabel(provider)} (${provider})` }));
  }, [accounts, globalConfig.providerDefaults]);

  const accountOptions = useMemo(
    () => accounts.map((account) => ({
      value: account.accountRef,
      provider: account.provider,
      label: `${account.displayName || account.accountRef} · ${account.accountRef}`
    })),
    [accounts]
  );

  const accountOptionsFor = (provider: string) =>
    accountOptions.filter((option) => !provider || option.provider === provider);

  const saveGlobal = async () => {
    let values: GlobalFormValues;
    try {
      values = await globalForm.validateFields();
    } catch {
      return;
    }
    setSavingGlobal(true);
    try {
      const payload: GatewayConcurrencyConfig = {
        systemMax: Number(values.systemMax || 0),
        queueLimit: Number(values.queueLimit || 0),
        queueWaitTimeoutMs: Number(values.queueWaitTimeoutMs || 0),
        retryAfterSeconds: Number(values.retryAfterSeconds || 0),
        accountDefault: Number(values.accountDefault || 0),
        providerDefaults: Object.fromEntries(
          Object.entries(values.providerDefaults || {})
            .map(([provider, value]) => [provider, Number(value || 0)] as const)
            .filter(([, value]) => value > 0)
        )
      };
      await configAPI.updateServer({ concurrency: payload });
      setGlobalConfig({ ...DEFAULT_CONCURRENCY, ...payload });
      message.success('并发配置已保存并热生效');
    } catch (error: unknown) {
      message.error((error as { message?: string })?.message || '保存失败');
    } finally {
      setSavingGlobal(false);
    }
  };

  const openCreate = () => {
    setEditingRow(null);
    editorForm.resetFields();
    editorForm.setFieldsValue({ provider: providerOptions[0]?.value || '', accountRef: '', modelId: '', maxConcurrency: 0, rpmLimit: 0, tpmLimit: 0 });
    setEditorOpen(true);
  };

  const openEdit = (row: AccountLimitRow) => {
    setEditingRow(row);
    editorForm.setFieldsValue({
      provider: row.provider,
      accountRef: row.accountRef,
      modelId: row.modelId || '',
      maxConcurrency: row.maxConcurrency,
      rpmLimit: row.rpmLimit,
      tpmLimit: row.tpmLimit
    });
    setEditorOpen(true);
  };

  const saveLimit = async () => {
    let values: LimitFormValues;
    try {
      values = await editorForm.validateFields();
    } catch {
      return;
    }
    setSavingLimit(true);
    try {
      await concurrencyAPI.setAccountLimit(values.provider, values.accountRef, {
        modelId: values.modelId || '',
        maxConcurrency: Number(values.maxConcurrency || 0),
        rpmLimit: Number(values.rpmLimit || 0),
        tpmLimit: Number(values.tpmLimit || 0)
      });
      message.success('账号覆盖已保存并热生效');
      setEditorOpen(false);
      await load();
    } catch (error: unknown) {
      message.error((error as { message?: string })?.message || '保存失败');
    } finally {
      setSavingLimit(false);
    }
  };

  const deleteLimit = (row: AccountLimitRow) => {
    Modal.confirm({
      title: `删除 ${row.accountRef}${row.modelId ? ` / ${row.modelId}` : ''} 的并发覆盖？`,
      content: '删除后该账号回落到 Provider 默认或全局账号默认。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await concurrencyAPI.deleteAccountLimit(row.provider, row.accountRef, row.modelId || '');
          message.success('已删除');
          await load();
        } catch {
          message.error('删除失败');
        }
      }
    });
  };

  const runPreview = async () => {
    const values = previewForm.getFieldsValue();
    setPreviewing(true);
    try {
      const result = await clientKeysAPI.effectiveConcurrency({
        provider: values.provider || undefined,
        account: values.account || undefined,
        model: values.model || undefined,
        key: values.key || undefined
      });
      setPreview(result);
    } catch {
      message.error('预览失败');
    } finally {
      setPreviewing(false);
    }
  };

  const columns = [
    {
      title: 'Provider',
      dataIndex: 'provider',
      width: 120,
      render: (value: string) => getProviderLabel(value)
    },
    { title: '账号', dataIndex: 'accountRef', render: (value: string) => <span className="aih-mono">{value}</span> },
    {
      title: '模型',
      dataIndex: 'modelId',
      render: (value: string) => (value ? <span className="aih-mono">{value}</span> : <span className="aih-muted">账号总量</span>)
    },
    { title: '并发', dataIndex: 'maxConcurrency', width: 80, render: (value: number) => value || '不限' },
    { title: 'RPM', dataIndex: 'rpmLimit', width: 80, render: (value: number) => value || '不限' },
    { title: 'TPM', dataIndex: 'tpmLimit', width: 80, render: (value: number) => value || '不限' },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_: unknown, row: AccountLimitRow) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>编辑</Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => deleteLimit(row)}>删除</Button>
        </Space>
      )
    }
  ];

  return (
    <div className="settings-form">
      <Card size="small" title="全局并发" className="hud-panel hud-panel--sm" style={{ marginBottom: 12 }}>
        <span className="aih-muted">
          系统上限、队列与默认值写入 server 配置的 concurrency 对象；Provider 默认 0 表示回落到账号默认。
        </span>
        <Form form={globalForm} layout="vertical" style={{ marginTop: 12 }}>
          <Space size={12} wrap align="start">
            <Form.Item name="systemMax" label="系统最大并发" initialValue={0}>
              <InputNumber min={0} max={10000} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="queueLimit" label="队列长度" initialValue={200}>
              <InputNumber min={0} max={100000} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="queueWaitTimeoutMs" label="排队等待 (ms)" initialValue={30000}>
              <InputNumber min={0} max={600000} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="retryAfterSeconds" label="Retry-After (s)" initialValue={1}>
              <InputNumber min={0} max={3600} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="accountDefault" label="账号默认并发" initialValue={2}>
              <InputNumber min={0} max={1024} style={{ width: 160 }} />
            </Form.Item>
          </Space>
          <div>
            <span className="aih-muted">Provider 默认并发</span>
            <Space size={12} wrap style={{ marginTop: 8 }}>
              {providerOptions.map((option) => (
                <Form.Item key={option.value} name={['providerDefaults', option.value]} label={option.label} style={{ marginBottom: 8 }}>
                  <InputNumber min={0} max={1024} style={{ width: 120 }} />
                </Form.Item>
              ))}
            </Space>
          </div>
          <Space>
            <Button type="primary" loading={savingGlobal} onClick={() => void saveGlobal()}>保存全局配置</Button>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>
            <Tag>已生效</Tag>
          </Space>
        </Form>
      </Card>

      <Card
        size="small"
        title="账号覆盖"
        className="hud-panel hud-panel--sm"
        style={{ marginBottom: 12 }}
        extra={<Button size="small" type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增覆盖</Button>}
      >
        <Table
          size="small"
          rowKey={(row) => `${row.provider}/${row.accountRef}/${row.modelId}`}
          loading={loading}
          pagination={false}
          dataSource={rows}
          columns={columns}
        />
        {rows.length === 0 && !loading ? (
          <div className="aih-muted" style={{ marginTop: 8 }}>还没有账号覆盖；账号会回落到 Provider 默认或账号默认。</div>
        ) : null}
      </Card>

      <Card size="small" title="生效值预览" className="hud-panel hud-panel--sm">
        <Form form={previewForm} layout="inline">
          <Form.Item name="provider" label="Provider">
            <Select allowClear style={{ width: 180 }} options={providerOptions} placeholder="全部" />
          </Form.Item>
          <Form.Item name="account" label="账号">
            <Select allowClear showSearch optionFilterProp="label" style={{ width: 220 }} options={accountOptionsFor(previewProvider || '')} placeholder="任意账号" />
          </Form.Item>
          <Form.Item name="model" label="模型">
            <Input allowClear style={{ width: 200 }} placeholder="可选" />
          </Form.Item>
          <Form.Item name="key" label="Key">
            <Select
              allowClear
              style={{ width: 200 }}
              placeholder="总 key / 任意"
              options={keys.map((key) => ({ value: key.id, label: key.master ? '总 key' : `${key.name} (${key.prefix})` }))}
            />
          </Form.Item>
          <Form.Item>
            <Button loading={previewing} onClick={() => void runPreview()}>预览</Button>
          </Form.Item>
        </Form>
        {preview ? (
          <Space size={16} wrap style={{ marginTop: 12 }}>
            <span>systemMax: <strong>{preview.systemMax || '不限'}</strong></span>
            <span>accountMax: <strong>{preview.accountMax || '不限'}</strong></span>
            <span>keyMax: <strong>{preview.keyMax || '不限'}</strong></span>
            <span>effective: <strong>{preview.effective || '不限'}</strong></span>
            <span>providerDefault: {preview.providerDefault || '—'}</span>
            <span>accountDefault: {preview.accountDefault}</span>
            <Tag>{preview.enforced ? '已生效' : '未生效'}</Tag>
          </Space>
        ) : (
          <div className="aih-muted" style={{ marginTop: 12 }}>选择 Provider/账号/模型/Key 后查看上限解析结果；本轮只预览，不拦截请求。</div>
        )}
      </Card>

      <Modal
        open={editorOpen}
        title={editingRow ? '编辑账号并发覆盖' : '新增账号并发覆盖'}
        okText="保存"
        cancelText="取消"
        confirmLoading={savingLimit}
        onOk={() => void saveLimit()}
        onCancel={() => setEditorOpen(false)}
        destroyOnClose
      >
        <Form form={editorForm} layout="vertical">
          <Form.Item name="provider" label="Provider" rules={[{ required: true, message: '请选择 Provider' }]}>
            <Select disabled={Boolean(editingRow)} options={providerOptions} />
          </Form.Item>
          <Form.Item name="accountRef" label="账号" rules={[{ required: true, message: '请选择账号' }]}>
            <Select
              disabled={Boolean(editingRow)}
              showSearch
              optionFilterProp="label"
              options={accountOptionsFor(editorProvider || '')}
              placeholder={editorProvider ? '选择账号' : '先选择 Provider'}
            />
          </Form.Item>
          <Form.Item name="modelId" label="模型（留空 = 账号总量）">
            <Input disabled={Boolean(editingRow)} placeholder="例如 gpt-5.1-codex" />
          </Form.Item>
          <Form.Item name="maxConcurrency" label="最大并发" initialValue={0}>
            <InputNumber min={0} max={1024} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="rpmLimit" label="RPM 上限" initialValue={0}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="tpmLimit" label="TPM 上限" initialValue={0}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default ConcurrencyLimitsPanel;