import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Form, Input, InputNumber, Modal, Select, Space, Table } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { Account, AccountConcurrencyLimit, ClientKeyRow, EffectiveConcurrency, GatewayConcurrencyConfig } from '@/types';
import { accountsAPI, clientKeysAPI, concurrencyAPI, configAPI } from '@/services/api';
import { getProviderLabel, providerIds } from '@/providers/catalog';
import Button from '@/components/ui/AppButton';
import SettingSection, { SettingRow } from '@/components/ui/SettingSection';
import SettingStatusTag, { type SettingStatusState } from '@/components/ui/SettingStatusTag';
import SaveActionBar from '@/components/ui/SaveActionBar';
import '@/components/settings/gateway-settings.css';

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

type InlineFeedback = {
  tone: 'success' | 'error';
  text: string;
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

function normalizeGlobalConfig(
  values: Partial<GlobalFormValues> | undefined,
  providerKeys: string[]
): GatewayConcurrencyConfig {
  const providerDefaults: Record<string, number> = {};
  providerKeys.forEach((provider) => {
    const raw = Number(values?.providerDefaults?.[provider] || 0);
    if (raw > 0) providerDefaults[provider] = raw;
  });
  return {
    systemMax: Number(values?.systemMax || 0),
    queueLimit: Number(values?.queueLimit || 0),
    queueWaitTimeoutMs: Number(values?.queueWaitTimeoutMs || 0),
    retryAfterSeconds: Number(values?.retryAfterSeconds || 0),
    accountDefault: Number(values?.accountDefault || 0),
    providerDefaults
  };
}

function globalConfigsEqual(
  left: GatewayConcurrencyConfig,
  right: GatewayConcurrencyConfig,
  providerKeys: string[]
) {
  if (
    left.systemMax !== right.systemMax
    || left.queueLimit !== right.queueLimit
    || left.queueWaitTimeoutMs !== right.queueWaitTimeoutMs
    || left.retryAfterSeconds !== right.retryAfterSeconds
    || left.accountDefault !== right.accountDefault
  ) {
    return false;
  }
  return providerKeys.every(
    (provider) => Number(left.providerDefaults?.[provider] || 0) === Number(right.providerDefaults?.[provider] || 0)
  );
}

function normalizeLimitForm(values: Partial<LimitFormValues> | undefined): LimitFormValues {
  return {
    provider: String(values?.provider || ''),
    accountRef: String(values?.accountRef || ''),
    modelId: String(values?.modelId || '').trim(),
    maxConcurrency: Number(values?.maxConcurrency || 0),
    rpmLimit: Number(values?.rpmLimit || 0),
    tpmLimit: Number(values?.tpmLimit || 0)
  };
}

function limitFormsEqual(left: LimitFormValues, right: LimitFormValues) {
  return left.provider === right.provider
    && left.accountRef === right.accountRef
    && left.modelId === right.modelId
    && left.maxConcurrency === right.maxConcurrency
    && left.rpmLimit === right.rpmLimit
    && left.tpmLimit === right.tpmLimit;
}

/**
 * 限流与并发设置：全局系统上限、Provider 默认、账号/模型覆盖与生效值预览。
 */
const ConcurrencyLimitsPanel: React.FC = () => {
  const [globalForm] = Form.useForm<GlobalFormValues>();
  const [editorForm] = Form.useForm<LimitFormValues>();
  const [previewForm] = Form.useForm<{ provider: string; account: string; model: string; key: string }>();

  const [loading, setLoading] = useState(false);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [globalFeedback, setGlobalFeedback] = useState<InlineFeedback | null>(null);
  const [overridesFeedback, setOverridesFeedback] = useState<InlineFeedback | null>(null);

  const [rows, setRows] = useState<AccountLimitRow[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [keys, setKeys] = useState<ClientKeyRow[]>([]);
  const [globalConfig, setGlobalConfig] = useState<GatewayConcurrencyConfig>(DEFAULT_CONCURRENCY);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<AccountLimitRow | null>(null);
  const [savingLimit, setSavingLimit] = useState(false);
  const [editorFeedback, setEditorFeedback] = useState<InlineFeedback | null>(null);

  const [preview, setPreview] = useState<EffectiveConcurrency | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');

  const watchedGlobal = Form.useWatch([], globalForm) as Partial<GlobalFormValues> | undefined;
  const watchedEditor = Form.useWatch([], editorForm) as Partial<LimitFormValues> | undefined;
  const editorProvider = Form.useWatch('provider', editorForm);
  const previewProvider = Form.useWatch('provider', previewForm);

  const load = useCallback(async (quiet = true) => {
    setLoading(true);
    try {
      const [server, accountList, keyList] = await Promise.all([
        configAPI.getServer(),
        accountsAPI.list().then((result) => result.accounts || []).catch(() => [] as Account[]),
        clientKeysAPI.list().catch(() => [] as ClientKeyRow[])
      ]);
      const config: GatewayConcurrencyConfig = {
        ...DEFAULT_CONCURRENCY,
        ...(server.concurrency || {}),
        providerDefaults: {
          ...DEFAULT_CONCURRENCY.providerDefaults,
          ...(server.concurrency?.providerDefaults || {})
        }
      };
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
      if (!quiet) {
        setGlobalFeedback({ tone: 'success', text: '已重新读取服务端并发配置' });
      }
    } catch (error: unknown) {
      setGlobalFeedback({
        tone: 'error',
        text: (error as { message?: string })?.message || '读取限流配置失败'
      });
    } finally {
      setLoading(false);
    }
  }, [globalForm]);

  useEffect(() => {
    void load(true);
  }, [load]);

  const providerOptions = useMemo(() => {
    const seen = new Set<string>();
    providerIds.forEach((provider) => seen.add(provider));
    accounts.forEach((account) => seen.add(account.provider));
    Object.keys(globalConfig.providerDefaults || {}).forEach((provider) => seen.add(provider));
    return [...seen].sort().map((provider) => ({ value: provider, label: `${getProviderLabel(provider)} (${provider})` }));
  }, [accounts, globalConfig.providerDefaults]);

  const providerKeys = useMemo(() => providerOptions.map((item) => item.value), [providerOptions]);

  const normalizedPersistedGlobal = useMemo(
    () => normalizeGlobalConfig(globalConfig, providerKeys),
    [globalConfig, providerKeys]
  );
  const normalizedDraftGlobal = useMemo(
    () => normalizeGlobalConfig(watchedGlobal ?? globalConfig, providerKeys),
    [globalConfig, providerKeys, watchedGlobal]
  );
  const globalDirty = !globalConfigsEqual(normalizedDraftGlobal, normalizedPersistedGlobal, providerKeys);

  const globalStatus: SettingStatusState = savingGlobal
    ? 'saving'
    : globalFeedback?.tone === 'error'
      ? 'error'
      : globalDirty
        ? 'dirty'
        : 'applied';

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
    if (!globalDirty) return;
    let values: GlobalFormValues;
    try {
      values = await globalForm.validateFields();
    } catch {
      return;
    }
    setSavingGlobal(true);
    setGlobalFeedback(null);
    try {
      const payload = normalizeGlobalConfig(values, providerKeys);
      await configAPI.updateServer({ concurrency: payload });
      const nextPersisted: GatewayConcurrencyConfig = {
        ...DEFAULT_CONCURRENCY,
        ...payload,
        providerDefaults: payload.providerDefaults
      };
      setGlobalConfig(nextPersisted);
      globalForm.setFieldsValue(nextPersisted);
      setGlobalFeedback({ tone: 'success', text: '全局并发配置已保存并立即生效' });
    } catch (error: unknown) {
      setGlobalFeedback({
        tone: 'error',
        text: (error as { message?: string })?.message || '保存失败'
      });
    } finally {
      setSavingGlobal(false);
    }
  };

  const resetGlobal = () => {
    globalForm.setFieldsValue(globalConfig);
    setGlobalFeedback(null);
  };

  const persistedEditorValues = useMemo<LimitFormValues>(() => (
    editingRow
      ? {
        provider: editingRow.provider,
        accountRef: editingRow.accountRef,
        modelId: editingRow.modelId || '',
        maxConcurrency: Number(editingRow.maxConcurrency || 0),
        rpmLimit: Number(editingRow.rpmLimit || 0),
        tpmLimit: Number(editingRow.tpmLimit || 0)
      }
      : {
        provider: providerOptions[0]?.value || '',
        accountRef: '',
        modelId: '',
        maxConcurrency: 0,
        rpmLimit: 0,
        tpmLimit: 0
      }
  ), [editingRow, providerOptions]);

  const draftEditorValues = useMemo(
    () => normalizeLimitForm(watchedEditor ?? persistedEditorValues),
    [persistedEditorValues, watchedEditor]
  );

  const editorDirty = editingRow
    ? !limitFormsEqual(draftEditorValues, persistedEditorValues)
    : Boolean(draftEditorValues.provider && draftEditorValues.accountRef);

  const openCreate = () => {
    setEditingRow(null);
    setEditorFeedback(null);
    editorForm.resetFields();
    editorForm.setFieldsValue({
      provider: providerOptions[0]?.value || '',
      accountRef: '',
      modelId: '',
      maxConcurrency: 0,
      rpmLimit: 0,
      tpmLimit: 0
    });
    setEditorOpen(true);
  };

  const openEdit = (row: AccountLimitRow) => {
    setEditingRow(row);
    setEditorFeedback(null);
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
    if (!editorDirty) return;
    let values: LimitFormValues;
    try {
      values = await editorForm.validateFields();
    } catch {
      return;
    }
    setSavingLimit(true);
    setEditorFeedback(null);
    try {
      await concurrencyAPI.setAccountLimit(values.provider, values.accountRef, {
        modelId: values.modelId || '',
        maxConcurrency: Number(values.maxConcurrency || 0),
        rpmLimit: Number(values.rpmLimit || 0),
        tpmLimit: Number(values.tpmLimit || 0)
      });
      setEditorOpen(false);
      setOverridesFeedback({
        tone: 'success',
        text: `已保存 ${values.accountRef}${values.modelId ? ` / ${values.modelId}` : ''} 的并发覆盖并立即生效`
      });
      await load(true);
    } catch (error: unknown) {
      setEditorFeedback({
        tone: 'error',
        text: (error as { message?: string })?.message || '保存失败'
      });
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
          setOverridesFeedback({
            tone: 'success',
            text: `已删除 ${row.accountRef}${row.modelId ? ` / ${row.modelId}` : ''} 的并发覆盖`
          });
          await load(true);
        } catch (error: unknown) {
          setOverridesFeedback({
            tone: 'error',
            text: (error as { message?: string })?.message || '删除失败'
          });
        }
      }
    });
  };

  const runPreview = async () => {
    const values = previewForm.getFieldsValue();
    setPreviewing(true);
    setPreviewError('');
    try {
      const result = await clientKeysAPI.effectiveConcurrency({
        provider: values.provider || undefined,
        account: values.account || undefined,
        model: values.model || undefined,
        key: values.key || undefined
      });
      setPreview(result);
    } catch (error: unknown) {
      setPreviewError((error as { message?: string })?.message || '预览查询失败');
    } finally {
      setPreviewing(false);
    }
  };

  const columns = [
    {
      title: 'Provider',
      dataIndex: 'provider',
      width: 130,
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

  const editorStatus: SettingStatusState = savingLimit
    ? 'saving'
    : editorFeedback?.tone === 'error'
      ? 'error'
      : editorDirty
        ? 'dirty'
        : editingRow
          ? 'applied'
          : 'unset';

  return (
    <div className="settings-form gateway-settings-stack">
      <Form
        form={globalForm}
        layout="vertical"
        onValuesChange={() => {
          if (globalFeedback) setGlobalFeedback(null);
        }}
      >
        <SettingSection
          title="全局并发与排队"
          description="配置网关并发上限、排队等待与 Provider 默认值；0 表示不限或回落到上级默认。"
          status={<SettingStatusTag status={globalStatus} compact />}
          extra={(
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load(false)}>
              刷新
            </Button>
          )}
          footer={(
            <SaveActionBar
              dirty={globalDirty}
              saving={savingGlobal}
              status={globalStatus}
              saveLabel="保存全局配置"
              cleanSaveLabel="已应用"
              effectSummary="保存后立即作用于网关准入与排队，无需重启"
              feedback={globalFeedback?.text}
              feedbackTone={globalFeedback?.tone ?? 'muted'}
              onSave={() => void saveGlobal()}
              onReset={resetGlobal}
            />
          )}
        >
          <SettingRow
            title="系统最大并发"
            description="整个网关同时在途请求上限，0 表示不限。"
            persistedValue={`已应用：${normalizedPersistedGlobal.systemMax || '不限'}`}
            control={(
              <Form.Item name="systemMax" initialValue={0}>
                <InputNumber min={0} max={10000} style={{ width: 160 }} />
              </Form.Item>
            )}
          />
          <SettingRow
            title="排队上限与等待"
            description="并发满载时最多排队的请求数、最大等待时长与 429 重试建议。"
            persistedValue={`已应用：队列 ${normalizedPersistedGlobal.queueLimit} · 等待 ${normalizedPersistedGlobal.queueWaitTimeoutMs}ms · Retry-After ${normalizedPersistedGlobal.retryAfterSeconds}s`}
            layout="stacked"
            control={(
              <Space size={12} wrap>
                <Form.Item name="queueLimit" label="队列长度" initialValue={200}>
                  <InputNumber min={0} max={100000} style={{ width: 150 }} />
                </Form.Item>
                <Form.Item name="queueWaitTimeoutMs" label="排队等待 (ms)" initialValue={30000}>
                  <InputNumber min={0} max={600000} style={{ width: 160 }} />
                </Form.Item>
                <Form.Item name="retryAfterSeconds" label="Retry-After (s)" initialValue={1}>
                  <InputNumber min={0} max={3600} style={{ width: 150 }} />
                </Form.Item>
              </Space>
            )}
          />
          <SettingRow
            title="账号默认并发"
            description="未设置 Provider 默认或账号覆盖时的兜底单账号并发。"
            persistedValue={`已应用：${normalizedPersistedGlobal.accountDefault || '不限'}`}
            control={(
              <Form.Item name="accountDefault" initialValue={2}>
                <InputNumber min={0} max={1024} style={{ width: 160 }} />
              </Form.Item>
            )}
          />
          <SettingRow
            title="Provider 默认并发"
            description="按供应商覆盖单账号默认并发，填 0 表示回落到账号默认并发。"
            layout="stacked"
            control={(
              <div className="gateway-provider-grid">
                {providerOptions.map((option) => (
                  <div key={option.value} className="gateway-provider-field">
                    <span className="gateway-provider-field-label" title={option.label}>
                      {option.label}
                    </span>
                    <Form.Item name={['providerDefaults', option.value]}>
                      <InputNumber min={0} max={1024} style={{ width: '100%' }} placeholder="回落默认" />
                    </Form.Item>
                  </div>
                ))}
              </div>
            )}
          />
        </SettingSection>
      </Form>

      <SettingSection
        title="账号并发覆盖"
        description="针对单个账号或指定模型覆写并发、RPM、TPM；优先级高于全局与 Provider 默认。"
        status={(
          <SettingStatusTag
            status={overridesFeedback?.tone === 'error' ? 'error' : rows.length > 0 ? 'applied' : 'unset'}
            label={rows.length > 0 ? `已生效 · ${rows.length} 条覆盖` : '未配置覆盖'}
            compact
            live="off"
          />
        )}
        extra={(
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增覆盖
          </Button>
        )}
      >
        {overridesFeedback ? (
          <div
            className={`gateway-inline-feedback gateway-inline-feedback--${overridesFeedback.tone}`}
            role={overridesFeedback.tone === 'error' ? 'alert' : 'status'}
          >
            <SettingStatusTag
              status={overridesFeedback.tone === 'error' ? 'error' : 'applied'}
              label={overridesFeedback.tone === 'error' ? '操作失败' : '已生效'}
              compact
              live="off"
            />
            <span>{overridesFeedback.text}</span>
          </div>
        ) : null}

        <Table
          size="small"
          rowKey={(row) => `${row.provider}/${row.accountRef}/${row.modelId}`}
          loading={loading}
          pagination={false}
          dataSource={rows}
          columns={columns}
          scroll={{ x: 760 }}
        />

        {rows.length === 0 && !loading ? (
          <p className="gateway-empty-note">暂无账号覆盖，当前全部账号按 Provider 默认或账号默认并发执行。</p>
        ) : null}
      </SettingSection>

      <SettingSection
        title="生效上限预览"
        description="按 Provider、账号、模型与客户端 Key 计算当前实际生效的并发准入值。"
        status={preview ? (
          <SettingStatusTag
            status={preview.enforced ? 'applied' : 'unset'}
            label={preview.enforced ? '已生效' : '未生效'}
            compact
            live="off"
          />
        ) : undefined}
      >
        <Form form={previewForm} layout="vertical" className="gateway-preview-form">
          <Form.Item name="provider" label="Provider">
            <Select allowClear style={{ width: 180 }} options={providerOptions} placeholder="全部" />
          </Form.Item>
          <Form.Item name="account" label="账号">
            <Select allowClear showSearch optionFilterProp="label" style={{ width: 220 }} options={accountOptionsFor(previewProvider || '')} placeholder="任意账号" />
          </Form.Item>
          <Form.Item name="model" label="模型">
            <Input allowClear style={{ width: 190 }} placeholder="可选" />
          </Form.Item>
          <Form.Item name="key" label="客户端 Key">
            <Select
              allowClear
              style={{ width: 190 }}
              placeholder="总 key / 任意"
              options={keys.map((key) => ({ value: key.id, label: key.master ? '总 key' : `${key.name} (${key.prefix})` }))}
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" loading={previewing} onClick={() => void runPreview()}>
              计算生效值
            </Button>
          </Form.Item>
        </Form>

        {previewError ? (
          <div className="gateway-inline-feedback gateway-inline-feedback--error" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
            <SettingStatusTag status="error" label="查询失败" compact live="off" />
            <span>{previewError}</span>
          </div>
        ) : null}

        {preview ? (
          <div className="gateway-preview-result">
            <span className="gateway-preview-metric">最终生效：<strong>{preview.effective || '不限'}</strong></span>
            <span className="gateway-preview-metric">系统上限：<strong>{preview.systemMax || '不限'}</strong></span>
            <span className="gateway-preview-metric">账号上限：<strong>{preview.accountMax || '不限'}</strong></span>
            <span className="gateway-preview-metric">Key 上限：<strong>{preview.keyMax || '不限'}</strong></span>
            <span className="gateway-preview-metric">Provider 默认：{preview.providerDefault || '—'}</span>
            <span className="gateway-preview-metric">账号默认：{preview.accountDefault}</span>
          </div>
        ) : (
          <p className="gateway-empty-note">选择条件后点击「计算生效值」，可验证多级限额叠加后的真实准入结果。</p>
        )}
      </SettingSection>

      <Modal
        open={editorOpen}
        title={editingRow ? '编辑账号并发覆盖' : '新增账号并发覆盖'}
        onCancel={() => setEditorOpen(false)}
        footer={null}
        destroyOnClose
      >
        <p className="gateway-modal-hint">留空模型表示作用于该账号总量；0 表示不限。</p>
        <Form
          form={editorForm}
          layout="vertical"
          onValuesChange={() => {
            if (editorFeedback) setEditorFeedback(null);
          }}
        >
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
          <Form.Item name="modelId" label="模型（可选）">
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
        <div className="gateway-modal-footer">
          <SaveActionBar
            dirty={editorDirty}
            saving={savingLimit}
            status={editorStatus}
            statusLabel={!editingRow && !editorDirty ? '待选择账号' : undefined}
            saveLabel={editingRow ? '保存覆盖' : '添加覆盖'}
            cleanSaveLabel={editingRow ? '已应用' : '请选择账号'}
            effectSummary="保存后立即生效，无需重启"
            feedback={editorFeedback?.text}
            feedbackTone={editorFeedback?.tone ?? 'muted'}
            onSave={() => void saveLimit()}
            onReset={editingRow ? () => {
              editorForm.setFieldsValue(persistedEditorValues);
              setEditorFeedback(null);
            } : undefined}
            extraActions={(
              <Button disabled={savingLimit} onClick={() => setEditorOpen(false)}>
                取消
              </Button>
            )}
          />
        </div>
      </Modal>
    </div>
  );
};

export default ConcurrencyLimitsPanel;
