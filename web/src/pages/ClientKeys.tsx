import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Form, Grid, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, Tooltip, message } from 'antd';
import type { DefaultOptionType } from 'antd/es/select';
import type { ColumnsType } from 'antd/es/table';
import { CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import type { ClientKeyRow } from '@/types';
import { clientKeysAPI } from '@/services/api';
import { writeClipboardText } from '@/utils/clipboard';
import Button from '@/components/ui/AppButton';
import SettingSection, { SettingRow } from '@/components/ui/SettingSection';
import SettingStatusTag, { type SettingStatusState } from '@/components/ui/SettingStatusTag';
import SaveActionBar from '@/components/ui/SaveActionBar';
import {
  EMPTY_CLIENT_KEY_FORM,
  ORPHAN_MODEL_GROUP_KEY,
  buildAccountPoolSelectOptions,
  buildAllowedModelGroups,
  buildClientKeyLimitsPayload,
  clientKeyFormsEqual,
  extractApiErrorMessage,
  formatLimitText,
  formatPersistedModelPool,
  formatPersistedProviderPool,
  getClientKeyModelLabel,
  normalizeClientKeyForm,
  normalizeStringList,
  pruneInvalidModelsForProviders,
  readClientKeyFormValues,
  summarizeModelPool,
  summarizeProviderPool,
  type AllowedModelGroup,
  type ClientKeyFormValues,
  type PoolCellSummary
} from '@/features/client-keys/client-key-presentation';
import { useClientKeyModelCatalog } from '@/features/client-keys/use-client-key-catalog';
import '@/components/settings/gateway-settings.css';
import './ClientKeys.css';

type InlineFeedback = {
  tone: 'success' | 'error';
  text: string;
};

const NAME_RULES = [
  { required: true, message: '请输入名称' },
  {
    validator: (_: unknown, value: unknown) => {
      const trimmed = String(value || '').trim();
      if (!trimmed) return Promise.reject(new Error('名称不能为空白字符'));
      if (trimmed.length > 80) return Promise.reject(new Error('名称最多 80 个字符'));
      return Promise.resolve();
    }
  }
];

function renderPoolTooltip(summary: PoolCellSummary) {
  return (
    <div className="client-keys-tooltip-list">
      <div className="client-keys-tooltip-title">{summary.tooltipTitle}</div>
      {summary.tooltipItems.map((item, index) => (
        <div key={`${item}-${index}`} className="client-keys-tooltip-item">
          {item}
        </div>
      ))}
    </div>
  );
}

function renderPoolCell(summary: PoolCellSummary, mono = false) {
  return (
    <Tooltip title={renderPoolTooltip(summary)}>
      <div className="client-keys-pool-cell">
        {summary.restricted ? (
          <>
            <Tag
              bordered={false}
              className={`client-keys-pool-tag${mono ? ' client-keys-pool-tag--mono' : ''}`}
            >
              {summary.primaryLabel}
            </Tag>
            {summary.overflowCount > 0 ? (
              <span className="client-keys-pool-count">+{summary.overflowCount}</span>
            ) : null}
          </>
        ) : (
          <span className="client-keys-pool-unrestricted">{summary.primaryLabel}</span>
        )}
      </div>
    </Tooltip>
  );
}

function renderModelOptionGroups(
  groups: readonly AllowedModelGroup[],
  modelLabels: Record<string, Record<string, string>>
) {
  return groups.map((group) => (
    <Select.OptGroup key={group.provider} label={group.label}>
      {group.models.map((model) => {
        const displayLabel = group.provider === ORPHAN_MODEL_GROUP_KEY
          ? ''
          : getClientKeyModelLabel(modelLabels, group.provider, model);
        const searchTitle = displayLabel && displayLabel !== model
          ? `${model} — ${displayLabel} (${group.label})`
          : `${model} (${group.label})`;
        return (
          <Select.Option
            key={`${group.provider}:${model}`}
            value={model}
            label={model}
            title={searchTitle}
          >
            <div className="client-keys-model-option">
              <span className="client-keys-model-option-id">{model}</span>
              {displayLabel && displayLabel !== model ? (
                <span className="client-keys-model-option-label">— {displayLabel}</span>
              ) : null}
            </div>
          </Select.Option>
        );
      })}
    </Select.OptGroup>
  ));
}

function filterProviderOption(input: string, option?: DefaultOptionType) {
  const needle = input.trim().toLowerCase();
  if (!needle) return true;
  const label = typeof option?.label === 'string' ? option.label.toLowerCase() : '';
  const value = String(option?.value || '').toLowerCase();
  return label.includes(needle) || value.includes(needle);
}

function filterModelOption(input: string, option?: DefaultOptionType) {
  const needle = input.trim().toLowerCase();
  if (!needle) return true;
  const title = typeof option?.title === 'string' ? option.title.toLowerCase() : '';
  const value = String(option?.value || '').toLowerCase();
  return title.includes(needle) || value.includes(needle);
}

/**
 * 客户端 API Key 管理。
 *
 * - 总 key（master）由 server 配置提供，这里只展示与统计；
 * - 托管 Key 可创建/编辑（名称、账号池、模型池与四项数值限额）/停用/轮换/删除，secret 只在创建与轮换时展示一次。
 */
const ClientKeysPanel: React.FC = () => {
  const screens = Grid.useBreakpoint();
  const pinLeftColumn = screens.md ?? true;
  const pinRightColumn = screens.lg ?? true;

  const [rows, setRows] = useState<ClientKeyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [panelFeedback, setPanelFeedback] = useState<InlineFeedback | null>(null);
  const [togglingKeyId, setTogglingKeyId] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createFeedback, setCreateFeedback] = useState<InlineFeedback | null>(null);
  const [createPrunedNotice, setCreatePrunedNotice] = useState('');
  const [secret, setSecret] = useState('');
  const [secretTitle, setSecretTitle] = useState('');
  const [secretCopied, setSecretCopied] = useState(false);

  const [editingKey, setEditingKey] = useState<ClientKeyRow | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editFeedback, setEditFeedback] = useState<InlineFeedback | null>(null);
  const [editPrunedNotice, setEditPrunedNotice] = useState('');

  const [createForm] = Form.useForm<ClientKeyFormValues>();
  const [editForm] = Form.useForm<ClientKeyFormValues>();

  const {
    modelsByProvider,
    modelLabels,
    modelsLoading,
    modelsLoaded,
    modelsError,
    refreshModels
  } = useClientKeyModelCatalog();

  const watchedCreateName = Form.useWatch('name', createForm);
  const watchedCreateProviders = Form.useWatch('allowedProviders', createForm);
  const watchedCreateModels = Form.useWatch('allowedModels', createForm);

  const watchedEdit = Form.useWatch([], editForm) as Partial<ClientKeyFormValues> | undefined;

  const load = useCallback(async (quiet = true) => {
    setLoading(true);
    try {
      setRows(await clientKeysAPI.list());
      if (!quiet) {
        setPanelFeedback({ tone: 'success', text: '已同步最新 API Key 列表' });
      }
    } catch (error: unknown) {
      setPanelFeedback({
        tone: 'error',
        text: extractApiErrorMessage(error, '读取 API Key 列表失败')
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const managed = useMemo(() => rows.filter((row) => !row.master), [rows]);

  const createProviders = useMemo(
    () => normalizeStringList(watchedCreateProviders, 'provider'),
    [watchedCreateProviders]
  );
  const createModels = useMemo(
    () => normalizeStringList(watchedCreateModels, 'alpha'),
    [watchedCreateModels]
  );

  const persistedEdit = useMemo(() => readClientKeyFormValues(editingKey), [editingKey]);
  const draftEdit = useMemo(
    () => normalizeClientKeyForm(watchedEdit ?? persistedEdit),
    [persistedEdit, watchedEdit]
  );

  useEffect(() => {
    if (!editingKey) return;
    editForm.setFieldsValue(persistedEdit);
  }, [editingKey, editForm, persistedEdit]);

  const editDirty = Boolean(editingKey) && !clientKeyFormsEqual(draftEdit, persistedEdit);
  const editNameValid = Boolean(draftEdit.name);
  const createDirty = Boolean(String(watchedCreateName || '').trim());

  const createProviderOptions = useMemo(() => buildAccountPoolSelectOptions(), []);
  const editProviderOptions = useMemo(
    () => buildAccountPoolSelectOptions(persistedEdit.allowedProviders),
    [persistedEdit.allowedProviders]
  );

  const createModelGroups = useMemo(
    () => buildAllowedModelGroups(modelsByProvider, createProviders, createModels, modelsLoaded),
    [createModels, createProviders, modelsByProvider, modelsLoaded]
  );
  const editModelGroups = useMemo(
    () => buildAllowedModelGroups(
      modelsByProvider,
      draftEdit.allowedProviders,
      draftEdit.allowedModels,
      modelsLoaded
    ),
    [draftEdit.allowedModels, draftEdit.allowedProviders, modelsByProvider, modelsLoaded]
  );

  const panelStatus: { status: SettingStatusState; label: string } = loading
    ? { status: 'saving', label: '同步中' }
    : panelFeedback?.tone === 'error'
      ? { status: 'error', label: '操作失败' }
      : { status: 'applied', label: `已生效 · ${managed.length} 个托管 Key` };

  const handleAccountPoolChange = (
    targetForm: typeof createForm,
    nextProvidersRaw: string[],
    setPrunedNotice: (notice: string) => void
  ) => {
    const nextProviders = normalizeStringList(nextProvidersRaw, 'provider');
    const selectedModels = normalizeStringList(targetForm.getFieldValue('allowedModels'), 'alpha');
    const { kept, removedCount } = pruneInvalidModelsForProviders(
      selectedModels,
      nextProviders,
      modelsByProvider,
      modelsLoaded
    );
    if (removedCount > 0) {
      targetForm.setFieldValue('allowedModels', kept);
      setPrunedNotice(`已自动移除 ${removedCount} 个不属于所选账号池的模型`);
    } else {
      setPrunedNotice('');
    }
  };

  const openCreateModal = () => {
    createForm.resetFields();
    createForm.setFieldsValue({
      ...EMPTY_CLIENT_KEY_FORM,
      allowedProviders: [],
      allowedModels: []
    });
    setCreateFeedback(null);
    setCreatePrunedNotice('');
    setCreateOpen(true);
    if (!modelsLoaded && !modelsLoading) {
      void refreshModels();
    }
  };

  const create = async () => {
    let rawValues: ClientKeyFormValues;
    try {
      rawValues = await createForm.validateFields();
    } catch {
      return;
    }
    const normalized = normalizeClientKeyForm(rawValues);
    const { kept } = pruneInvalidModelsForProviders(
      normalized.allowedModels,
      normalized.allowedProviders,
      modelsByProvider,
      modelsLoaded
    );
    const finalValues: ClientKeyFormValues = { ...normalized, allowedModels: kept };

    setCreating(true);
    setCreateFeedback(null);
    try {
      const result = await clientKeysAPI.create({
        name: finalValues.name,
        limits: buildClientKeyLimitsPayload(finalValues)
      });
      setCreateOpen(false);
      createForm.resetFields();
      setCreatePrunedNotice('');
      setSecretTitle(`已创建 ${result.key.name}（${result.key.prefix}）`);
      setSecretCopied(false);
      setSecret(result.secret);
      setPanelFeedback({ tone: 'success', text: `已创建 ${result.key.name} 并立即生效` });
      await load(true);
    } catch (error: unknown) {
      setCreateFeedback({
        tone: 'error',
        text: extractApiErrorMessage(error, '创建失败')
      });
    } finally {
      setCreating(false);
    }
  };

  const toggle = useCallback(async (row: ClientKeyRow, enabled: boolean) => {
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
        text: extractApiErrorMessage(error, `更新 ${row.name} 状态失败`)
      });
    } finally {
      setTogglingKeyId('');
    }
  }, [load]);

  const openEditModal = useCallback((row: ClientKeyRow) => {
    setEditingKey(row);
    setEditFeedback(null);
    setEditPrunedNotice('');
    editForm.setFieldsValue(readClientKeyFormValues(row));
    if (!modelsLoaded && !modelsLoading) {
      void refreshModels();
    }
  }, [editForm, modelsLoaded, modelsLoading, refreshModels]);

  const saveEdit = async () => {
    if (!editingKey || !editDirty) return;
    let rawValues: ClientKeyFormValues;
    try {
      rawValues = await editForm.validateFields();
    } catch {
      return;
    }
    const normalized = normalizeClientKeyForm(rawValues);
    const { kept } = pruneInvalidModelsForProviders(
      normalized.allowedModels,
      normalized.allowedProviders,
      modelsByProvider,
      modelsLoaded
    );
    const finalValues: ClientKeyFormValues = { ...normalized, allowedModels: kept };
    const nextLimits = buildClientKeyLimitsPayload(finalValues);

    setSavingEdit(true);
    setEditFeedback(null);
    try {
      const updated = await clientKeysAPI.update(editingKey.id, {
        name: finalValues.name,
        limits: nextLimits
      });
      const mergedRow: ClientKeyRow = {
        ...editingKey,
        ...(updated || {}),
        name: updated?.name || finalValues.name,
        limits: updated?.limits ? { ...nextLimits, ...updated.limits } : nextLimits
      };
      setEditingKey(mergedRow);
      editForm.setFieldsValue(readClientKeyFormValues(mergedRow));
      setEditPrunedNotice('');
      setEditFeedback({ tone: 'success', text: '配置已保存并立即生效' });
      setPanelFeedback({ tone: 'success', text: `已更新 ${mergedRow.name} 的配置并立即生效` });
      await load(true);
    } catch (error: unknown) {
      setEditFeedback({
        tone: 'error',
        text: extractApiErrorMessage(error, '保存失败')
      });
    } finally {
      setSavingEdit(false);
    }
  };

  const rotate = useCallback((row: ClientKeyRow) => {
    Modal.confirm({
      title: `轮换 ${row.name} 的密钥？`,
      content: '只更换密钥内容，Key ID、账号池、模型池与限额保持不变；旧密钥立即失效，在途请求不受影响。',
      okText: '轮换',
      cancelText: '取消',
      onOk: async () => {
        try {
          const next = await clientKeysAPI.rotate(row.id);
          setSecretTitle(`已轮换 ${row.name}（${row.prefix}）`);
          setSecretCopied(false);
          setSecret(next);
          setPanelFeedback({ tone: 'success', text: `已轮换 ${row.name} 的密钥` });
          await load(true);
        } catch (error: unknown) {
          setPanelFeedback({
            tone: 'error',
            text: extractApiErrorMessage(error, '轮换失败')
          });
        }
      }
    });
  }, [load]);

  const remove = useCallback((row: ClientKeyRow) => {
    Modal.confirm({
      title: `删除 ${row.name}？`,
      content: '删除后该 Key 立即失效并从列表移除，无法恢复；历史调用统计保留。只想暂时停用请用状态开关。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await clientKeysAPI.deleteKey(row.id);
          setPanelFeedback({ tone: 'success', text: `已删除 ${row.name}` });
          await load(true);
        } catch (error: unknown) {
          setPanelFeedback({
            tone: 'error',
            text: extractApiErrorMessage(error, '删除失败')
          });
        }
      }
    });
  }, [load]);

  // 复制后保持弹窗打开：secret 只显示一次，关闭即不可恢复，不能让一次复制
  // 失败或误触销毁唯一明文。
  const copySecret = async () => {
    if (!secret) return;
    try {
      await writeClipboardText(secret);
      setSecretCopied(true);
      message.success('密钥已复制');
    } catch {
      message.error('复制失败，请手动选中文本复制');
    }
  };

  const copyKeyID = useCallback(async (row: ClientKeyRow) => {
    try {
      await writeClipboardText(row.id);
      message.success(`已复制 Key ID：${row.id}`);
    } catch {
      message.error('复制失败，请手动选中文本复制');
    }
  }, []);

  const columns = useMemo<ColumnsType<ClientKeyRow>>(() => [
    {
      title: '名称',
      dataIndex: 'name',
      width: 192,
      fixed: pinLeftColumn ? 'left' : undefined,
      ellipsis: { showTitle: false },
      render: (value: string, row: ClientKeyRow) => (
        <div className="client-keys-name-cell">
          <Tooltip title={value}>
            <span className="client-keys-name-text">{value}</span>
          </Tooltip>
          {row.master ? (
            <Tag bordered={false} className="client-keys-master-tag">
              总 key
            </Tag>
          ) : null}
        </div>
      )
    },
    {
      title: '前缀',
      dataIndex: 'prefix',
      width: 208,
      ellipsis: { showTitle: false },
      render: (value: string, row: ClientKeyRow) =>
        value ? (
          <div className="client-keys-prefix-row">
            <Tooltip title={value}>
              <span className="client-keys-prefix-cell">{value}</span>
            </Tooltip>
            <Tooltip title="复制 Key ID（CLI 与管理接口使用）">
              <Button
                type="text"
                size="small"
                className="client-keys-copy-button"
                icon={<CopyOutlined />}
                aria-label="复制 Key ID"
                onClick={() => void copyKeyID(row)}
              />
            </Tooltip>
          </div>
        ) : (
          <span className="aih-muted">—</span>
        )
    },
    {
      title: '状态',
      key: 'enabled',
      width: 136,
      render: (_: unknown, row: ClientKeyRow) =>
        row.master ? (
          <div className="client-keys-status-cell">
            <SettingStatusTag status="applied" label="系统总 key" compact live="off" />
          </div>
        ) : (
          <div className="client-keys-status-cell">
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
          </div>
        )
    },
    {
      title: '账号池',
      key: 'allowedProviders',
      width: 164,
      ellipsis: { showTitle: false },
      render: (_: unknown, row: ClientKeyRow) =>
        renderPoolCell(summarizeProviderPool(row.limits?.allowedProviders, row.master), false)
    },
    {
      title: '模型池',
      key: 'allowedModels',
      width: 192,
      ellipsis: { showTitle: false },
      render: (_: unknown, row: ClientKeyRow) =>
        renderPoolCell(summarizeModelPool(row.limits?.allowedModels, modelLabels, row.master), true)
    },
    {
      title: '已生效限额',
      key: 'limits',
      width: 252,
      ellipsis: { showTitle: false },
      render: (_: unknown, row: ClientKeyRow) => {
        const text = formatLimitText(row.limits);
        return (
          <div className="client-keys-limit-cell">
            <Tooltip title={text}>
              <span className="gateway-limit-summary gateway-ellipsis">{text}</span>
            </Tooltip>
          </div>
        );
      }
    },
    {
      title: '在途',
      key: 'inFlight',
      width: 68,
      align: 'right',
      render: (_: unknown, row: ClientKeyRow) => (
        <span className="client-keys-metric-cell">{row.live?.inFlight ?? 0}</span>
      )
    },
    {
      title: 'RPM (1m)',
      key: 'rpm',
      width: 92,
      align: 'right',
      render: (_: unknown, row: ClientKeyRow) => (
        <span className="client-keys-metric-cell">{Math.round(row.live?.rpm1m || 0)}</span>
      )
    },
    {
      title: 'TPM (1m)',
      key: 'tpm',
      width: 96,
      align: 'right',
      render: (_: unknown, row: ClientKeyRow) => (
        <span className="client-keys-metric-cell">{Math.round(row.live?.tpm1m || 0)}</span>
      )
    },
    {
      title: '24h 请求',
      key: 'requests',
      width: 92,
      align: 'right',
      render: (_: unknown, row: ClientKeyRow) => (
        <span className="client-keys-metric-cell">{row.totals?.requests ?? 0}</span>
      )
    },
    {
      title: '24h Tokens',
      key: 'tokens',
      width: 108,
      align: 'right',
      render: (_: unknown, row: ClientKeyRow) => {
        const tokens = row.totals?.totalTokens ?? 0;
        return (
          <Tooltip title={tokens.toLocaleString('zh-CN')}>
            <span className="client-keys-metric-cell">{tokens}</span>
          </Tooltip>
        );
      }
    },
    {
      title: '最后使用',
      key: 'lastUsed',
      width: 128,
      render: (_: unknown, row: ClientKeyRow) =>
        row.lastUsedAtMs ? (
          <span className="client-keys-metric-cell">
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
      width: 216,
      fixed: pinRightColumn ? 'right' : undefined,
      render: (_: unknown, row: ClientKeyRow) =>
        row.master ? null : (
          <div className="client-keys-actions">
            <Button size="small" icon={<EditOutlined />} onClick={() => openEditModal(row)}>
              编辑
            </Button>
            <Button size="small" icon={<SyncOutlined />} onClick={() => rotate(row)}>
              轮换
            </Button>
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => remove(row)}>
              删除
            </Button>
          </div>
        )
    }
  ], [copyKeyID, modelLabels, openEditModal, pinLeftColumn, pinRightColumn, remove, rotate, toggle, togglingKeyId]);

  const tableScrollX = useMemo(
    () => columns.reduce((sum, column) => sum + (typeof column.width === 'number' ? column.width : 120), 0),
    [columns]
  );

  const editStatus: SettingStatusState = savingEdit
    ? 'saving'
    : editFeedback?.tone === 'error'
      ? 'error'
      : editDirty
        ? 'dirty'
        : 'applied';

  const getModelSelectPlaceholder = (
    selectedProviders: readonly string[],
    groups: readonly AllowedModelGroup[]
  ) => {
    if (modelsLoading && groups.length === 0) return '正在加载模型目录…';
    if (groups.length === 0) {
      return selectedProviders.length > 0
        ? '所选账号池暂无可选模型（留空表示不限制模型）'
        : '暂无目录模型（留空表示不限制模型）';
    }
    return selectedProviders.length > 0
      ? '留空不限（仅限上方已选账号池的模型）'
      : '留空不限（允许全部可用模型）';
  };

  return (
    <div className="client-keys-panel gateway-settings-stack">
      <SettingSection
        title="客户端 API Key"
        description="管理分发给客户端的独立密钥、账号池/模型池白名单与限额；密钥仅在创建和轮换时展示一次。"
        status={<SettingStatusTag status={panelStatus.status} label={panelStatus.label} compact />}
        extra={(
          <Space size={8} wrap>
            <Button
              icon={<ReloadOutlined />}
              loading={loading || modelsLoading}
              onClick={() => {
                void load(false);
                void refreshModels();
              }}
            >
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

        <Table<ClientKeyRow>
          className="client-keys-table"
          size="small"
          tableLayout="fixed"
          rowKey="id"
          loading={loading}
          pagination={false}
          dataSource={rows}
          columns={columns}
          scroll={{ x: tableScrollX }}
        />

        {managed.length === 0 && !loading ? (
          <p className="gateway-empty-note">暂无托管 API Key；服务总 key 仍可直接鉴权。</p>
        ) : null}
      </SettingSection>

      <Modal
        open={createOpen}
        title="新建客户端 API Key"
        width={600}
        onCancel={() => setCreateOpen(false)}
        footer={null}
        destroyOnClose
      >
        <p className="gateway-modal-hint">
          账号池与模型池留空表示不限；限额填 0 表示不限。创建后立即生效，密钥明文仅展示一次。
        </p>
        <Form
          form={createForm}
          layout="vertical"
          onValuesChange={() => {
            if (createFeedback) setCreateFeedback(null);
          }}
        >
          <Form.Item name="name" label="名称" rules={NAME_RULES}>
            <Input placeholder="例如：laptop / build-server" maxLength={80} />
          </Form.Item>

          <Form.Item
            name="allowedProviders"
            label={(
              <span className="client-keys-modal-label">
                <span>账号池</span>
                <SettingStatusTag
                  status={createProviders.length > 0 ? 'applied' : 'unset'}
                  label={createProviders.length > 0 ? `已限定 ${createProviders.length} 个账号池` : '不限 · 全部账号池'}
                  compact
                  live="off"
                />
              </span>
            )}
            extra={(
              <div className="client-keys-field-extra">
                <span>留空表示不限制，可使用全部供应商账号池；选择后下方模型池将自动收窄。</span>
              </div>
            )}
          >
            <Select
              mode="multiple"
              allowClear
              showSearch
              maxTagCount="responsive"
              placeholder="留空不限（允许全部供应商账号池）"
              options={createProviderOptions}
              filterOption={filterProviderOption}
              onChange={(next: string[]) => handleAccountPoolChange(createForm, next, setCreatePrunedNotice)}
            />
          </Form.Item>

          <Form.Item
            name="allowedModels"
            label={(
              <span className="client-keys-modal-label">
                <span>模型池</span>
                <SettingStatusTag
                  status={createModels.length > 0 ? 'applied' : 'unset'}
                  label={
                    createModels.length > 0
                      ? `已限定 ${createModels.length} 个模型`
                      : createProviders.length > 0
                        ? '不限 · 池内全部模型'
                        : '不限 · 全部模型'
                  }
                  compact
                  live="off"
                />
              </span>
            )}
            extra={(
              <div>
                <div className="client-keys-field-extra">
                  <span>
                    {createProviders.length > 0
                      ? '留空表示不限制模型（仅受上方所选账号池约束）。'
                      : '留空表示不限制，可请求网关全部可用模型。'}
                  </span>
                  <Button
                    type="text"
                    size="small"
                    icon={<ReloadOutlined />}
                    loading={modelsLoading}
                    onClick={() => void refreshModels()}
                  >
                    刷新目录
                  </Button>
                </div>
                {createPrunedNotice ? (
                  <div className="client-keys-pruned-note" role="status">
                    {createPrunedNotice}
                  </div>
                ) : null}
                {modelsError ? (
                  <div className="client-keys-catalog-error" role="alert">
                    模型目录加载失败：{modelsError}
                  </div>
                ) : null}
              </div>
            )}
          >
            <Select
              mode="multiple"
              allowClear
              showSearch
              loading={modelsLoading}
              maxTagCount="responsive"
              optionLabelProp="label"
              filterOption={filterModelOption}
              placeholder={getModelSelectPlaceholder(createProviders, createModelGroups)}
              onChange={() => {
                if (createPrunedNotice) setCreatePrunedNotice('');
              }}
            >
              {renderModelOptionGroups(createModelGroups, modelLabels)}
            </Select>
          </Form.Item>

          <div className="client-keys-limit-grid">
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
          </div>
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
        className="client-keys-edit-modal"
        open={Boolean(editingKey)}
        title={editingKey ? `编辑 API Key · ${editingKey.name}` : '编辑 API Key'}
        width={640}
        onCancel={() => setEditingKey(null)}
        footer={null}
        destroyOnClose
      >
        <p className="gateway-modal-hint">
          账号池与模型池留空表示不限；数值限额填 0 表示不限。保存后立即作用于鉴权与路由，无需重启。
        </p>
        <Form
          form={editForm}
          layout="vertical"
          onValuesChange={() => {
            if (editFeedback) setEditFeedback(null);
          }}
        >
          <SettingRow
            title="名称"
            description="用于识别该客户端密钥（最多 80 个字符）。"
            persistedValue={`已应用：${persistedEdit.name}`}
            layout="stacked"
            control={(
              <Form.Item name="name" rules={NAME_RULES}>
                <Input placeholder="例如：laptop / build-server" maxLength={80} />
              </Form.Item>
            )}
          />

          <SettingRow
            title="账号池"
            description="留空表示不限制，可使用全部供应商账号池；选中后将自动收窄下方模型池选项。"
            persistedValue={`已应用：${formatPersistedProviderPool(persistedEdit.allowedProviders)}`}
            status={(
              <SettingStatusTag
                status={draftEdit.allowedProviders.length > 0 ? 'applied' : 'unset'}
                label={
                  draftEdit.allowedProviders.length > 0
                    ? `已限定 ${draftEdit.allowedProviders.length} 个账号池`
                    : '不限 · 全部账号池'
                }
                compact
                live="off"
              />
            )}
            layout="stacked"
            control={(
              <Form.Item name="allowedProviders">
                <Select
                  mode="multiple"
                  allowClear
                  showSearch
                  maxTagCount="responsive"
                  placeholder="留空不限（允许全部供应商账号池）"
                  options={editProviderOptions}
                  filterOption={filterProviderOption}
                  onChange={(next: string[]) => handleAccountPoolChange(editForm, next, setEditPrunedNotice)}
                />
              </Form.Item>
            )}
          />

          <SettingRow
            title="模型池"
            description={
              draftEdit.allowedProviders.length > 0
                ? '留空表示不限制模型（仅受上方所选账号池约束）。'
                : '留空表示不限制，可请求网关全部可用模型。'
            }
            persistedValue={`已应用：${formatPersistedModelPool(persistedEdit.allowedModels)}`}
            status={(
              <SettingStatusTag
                status={draftEdit.allowedModels.length > 0 ? 'applied' : 'unset'}
                label={
                  draftEdit.allowedModels.length > 0
                    ? `已限定 ${draftEdit.allowedModels.length} 个模型`
                    : draftEdit.allowedProviders.length > 0
                      ? '不限 · 池内全部模型'
                      : '不限 · 全部模型'
                }
                compact
                live="off"
              />
            )}
            layout="stacked"
            control={(
              <div>
                <Form.Item name="allowedModels">
                  <Select
                    mode="multiple"
                    allowClear
                    showSearch
                    loading={modelsLoading}
                    maxTagCount="responsive"
                    optionLabelProp="label"
                    filterOption={filterModelOption}
                    placeholder={getModelSelectPlaceholder(draftEdit.allowedProviders, editModelGroups)}
                    onChange={() => {
                      if (editPrunedNotice) setEditPrunedNotice('');
                    }}
                  >
                    {renderModelOptionGroups(editModelGroups, modelLabels)}
                  </Select>
                </Form.Item>
                <div className="client-keys-field-extra">
                  <span>按供应商分组展示当前网关模型目录。</span>
                  <Button
                    type="text"
                    size="small"
                    icon={<ReloadOutlined />}
                    loading={modelsLoading}
                    onClick={() => void refreshModels()}
                  >
                    刷新目录
                  </Button>
                </div>
                {editPrunedNotice ? (
                  <div className="client-keys-pruned-note" role="status">
                    {editPrunedNotice}
                  </div>
                ) : null}
                {modelsError ? (
                  <div className="client-keys-catalog-error" role="alert">
                    模型目录加载失败：{modelsError}
                  </div>
                ) : null}
              </div>
            )}
          />

          <SettingRow
            title="最大并发"
            description="0 表示不限。"
            persistedValue={`已应用：${persistedEdit.maxConcurrency || '不限'}`}
            control={(
              <Form.Item name="maxConcurrency" initialValue={0}>
                <InputNumber min={0} max={64} style={{ width: 160 }} />
              </Form.Item>
            )}
          />
          <SettingRow
            title="RPM 上限"
            description="每分钟请求数限制，0 表示不限。"
            persistedValue={`已应用：${persistedEdit.rpmLimit || '不限'}`}
            control={(
              <Form.Item name="rpmLimit" initialValue={0}>
                <InputNumber min={0} style={{ width: 160 }} />
              </Form.Item>
            )}
          />
          <SettingRow
            title="TPM 上限"
            description="每分钟 Tokens 限制，0 表示不限。"
            persistedValue={`已应用：${persistedEdit.tpmLimit || '不限'}`}
            control={(
              <Form.Item name="tpmLimit" initialValue={0}>
                <InputNumber min={0} style={{ width: 160 }} />
              </Form.Item>
            )}
          />
          <SettingRow
            title="每日 Tokens 上限"
            description="自然日累计 Tokens 限制，0 表示不限。"
            persistedValue={`已应用：${persistedEdit.dailyTokenLimit || '不限'}`}
            control={(
              <Form.Item name="dailyTokenLimit" initialValue={0}>
                <InputNumber min={0} style={{ width: 160 }} />
              </Form.Item>
            )}
          />
        </Form>

        <div className="gateway-modal-footer">
          <SaveActionBar
            dirty={editDirty}
            saving={savingEdit}
            disabled={!editNameValid}
            status={editStatus}
            saveLabel={editNameValid ? '保存更改' : '请填写名称'}
            cleanSaveLabel="已应用"
            effectSummary="保存后立即生效，无需重启"
            feedback={editFeedback?.text}
            feedbackTone={editFeedback?.tone ?? 'muted'}
            onSave={() => void saveEdit()}
            onReset={() => {
              editForm.setFieldsValue(persistedEdit);
              setEditFeedback(null);
              setEditPrunedNotice('');
            }}
            extraActions={(
              <Button disabled={savingEdit} onClick={() => setEditingKey(null)}>
                关闭
              </Button>
            )}
          />
        </div>
      </Modal>

      <Modal
        open={Boolean(secret)}
        title={secretTitle || '一次性密钥'}
        onCancel={() => {
          setSecret('');
          setSecretCopied(false);
        }}
        footer={(
          <Space>
            <Button
              onClick={() => {
                setSecret('');
                setSecretCopied(false);
              }}
            >
              关闭
            </Button>
            <Button type="primary" icon={<CopyOutlined />} onClick={() => void copySecret()}>
              {secretCopied ? '再次复制' : '复制密钥'}
            </Button>
          </Space>
        )}
        destroyOnClose
      >
        <p className="gateway-modal-hint">
          此密钥只显示一次，关闭后无法再次查看，请先复制并妥善保存；复制不会关闭弹窗。
        </p>
        <Input.TextArea
          className="gateway-secret-textarea"
          value={secret}
          readOnly
          autoSize={{ minRows: 2, maxRows: 4 }}
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.currentTarget.select()}
        />
      </Modal>
    </div>
  );
};

export default ClientKeysPanel;
