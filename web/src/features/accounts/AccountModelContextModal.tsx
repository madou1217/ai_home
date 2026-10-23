import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Empty, InputNumber, Modal, Select, Space, Spin, Table, Tag, Typography, message } from 'antd';
import { accountsAPI } from '@/services/api';
import { getAccountPrimaryLabel } from '@/features/accounts/AccountBadges';
import type { Account } from '@/types';
import './account-overlays.css';

interface ModelContextRow {
  model: string;
  tokens: number;
  source: string;
  override: number;
}

interface SameTypeAccount {
  accountRef: string;
  credentialType: string;
  displayName: string;
  disabled?: boolean;
}

interface AccountModelContextModalProps {
  account: Account | null;
  /** 该账号当前可服务的模型 id（来自账号模型目录）。 */
  models?: readonly string[];
  onClose: () => void;
}

/** 来源标签：让「这个窗口值从哪来」一眼可见 —— 用户要求值必须有数据支撑。 */
const SOURCE_LABELS: Record<string, { text: string; color: string }> = {
  override: { text: '手动设置', color: 'blue' },
  probed: { text: '上游探测', color: 'green' },
  catalog: { text: 'models.dev', color: 'default' },
  unknown: { text: '未知', color: 'warning' }
};

const TYPE_LABELS: Record<string, string> = {
  oauth: 'OAuth',
  'api-key': 'API Key',
  'auth-token': 'Auth Token'
};

/**
 * 账号 × 模型的上下文窗口查看与设置。
 *
 * 维度刻意是「账号 × 模型」而不是「provider × 模型」：同一个 provider 下
 * 中转 / OAuth / API Key 账号的真实窗口不同，必须能分别设置。
 * 解析优先级（服务端）：手动设置 > 上游探测 > models.dev 目录。
 *
 * 设置时可勾选同 provider 下的**同类型账号**一并应用 —— 同套餐的 OAuth 账号通常窗口一致，
 * 逐个设置是纯重复劳动；但账号始终可选，不做「默默全改」。
 */
export function AccountModelContextModal({ account, models = [], onClose }: AccountModelContextModalProps) {
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [rows, setRows] = useState<ModelContextRow[]>([]);
  const [sameTypeAccounts, setSameTypeAccounts] = useState<SameTypeAccount[]>([]);
  const [credentialType, setCredentialType] = useState('');
  const [limits, setLimits] = useState<{ min: number; max: number }>({ min: 1024, max: 2000000 });
  const [editingModel, setEditingModel] = useState<string>('');
  const [draftTokens, setDraftTokens] = useState<number | null>(null);
  const [applyToSameType, setApplyToSameType] = useState(false);
  const [selectedPeers, setSelectedPeers] = useState<string[]>([]);

  const modelOptions = useMemo(() => {
    const ids = new Set<string>(models.filter(Boolean));
    rows.forEach((row) => ids.add(row.model));
    return [...ids].sort().map((id) => ({ label: id, value: id }));
  }, [models, rows]);

  const load = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    try {
      const response = await accountsAPI.getAccountModelContext(account.provider, account.accountRef, [...models]);
      setRows(Array.isArray(response.models) ? response.models : []);
      setSameTypeAccounts(Array.isArray(response.sameTypeAccounts) ? response.sameTypeAccounts : []);
      setCredentialType(String(response.credentialType || ''));
      if (response.limits?.min && response.limits?.max) setLimits(response.limits);
    } catch {
      message.error('读取上下文窗口失败');
    } finally {
      setLoading(false);
    }
  }, [account, models]);

  useEffect(() => {
    if (!account) return undefined;
    setEditingModel('');
    setDraftTokens(null);
    setApplyToSameType(false);
    setSelectedPeers([]);
    void load();
    return undefined;
  }, [account, load]);

  const save = async () => {
    if (!account || submitting || !editingModel) return;
    setSubmitting(true);
    try {
      const peers = applyToSameType ? selectedPeers : [];
      if (peers.length > 0) {
        await accountsAPI.saveAccountModelContextBulk(account.provider, {
          model: editingModel,
          tokens: draftTokens,
          accountRefs: [account.accountRef, ...peers]
        });
        message.success(`已设置 ${editingModel} 的上下文窗口（含 ${peers.length} 个同类型账��）`);
      } else {
        await accountsAPI.saveAccountModelContext(account.provider, account.accountRef, {
          model: editingModel,
          tokens: draftTokens
        });
        message.success(`已设置 ${editingModel} 的上下文窗口`);
      }
      setEditingModel('');
      setDraftTokens(null);
      setApplyToSameType(false);
      setSelectedPeers([]);
      await load();
    } catch (error: any) {
      const code = error?.response?.data?.error;
      message.error(code ? `保存失败：${code}` : error?.message || '保��失败');
    } finally {
      setSubmitting(false);
    }
  };

  const pickForEdit = (row: ModelContextRow) => {
    setEditingModel(row.model);
    setDraftTokens(row.override > 0 ? row.override : (row.tokens > 0 ? row.tokens : null));
  };

  return (
    <Modal
      open={Boolean(account)}
      title={account ? `上下文窗口 · ${getAccountPrimaryLabel(account)}` : '上下文窗口'}
      width={760}
      destroyOnHidden
      maskClosable={!submitting}
      onCancel={onClose}
      footer={[
        <Button key="close" disabled={submitting} onClick={onClose}>关闭</Button>
      ]}
    >
      <Spin spinning={loading}>
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Space size={8} wrap>
            <Typography.Text type="secondary">
              窗口按「账号 × 模型」保存，优先于自动探测与 models.dev 目���。
            </Typography.Text>
            {credentialType ? <Tag>{TYPE_LABELS[credentialType] || credentialType}</Tag> : null}
          </Space>

          {rows.length === 0 ? (
            <Empty description="该账号暂无已知模型" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <Table<ModelContextRow>
              size="small"
              rowKey="model"
              pagination={rows.length > 8 ? { pageSize: 8 } : false}
              dataSource={rows}
              columns={[
                { title: '模型', dataIndex: 'model', ellipsis: true },
                {
                  title: '生效窗口',
                  dataIndex: 'tokens',
                  width: 140,
                  render: (tokens: number, row) => (
                    <Space size={6}>
                      <span>{tokens > 0 ? tokens.toLocaleString() : '未知'}</span>
                      <Tag color={SOURCE_LABELS[row.source]?.color || 'default'} style={{ marginInlineEnd: 0 }}>
                        {SOURCE_LABELS[row.source]?.text || row.source}
                      </Tag>
                    </Space>
                  )
                },
                {
                  title: '',
                  key: 'action',
                  width: 90,
                  render: (_, row) => (
                    <Button type="link" size="small" onClick={() => pickForEdit(row)}>设置</Button>
                  )
                }
              ]}
            />
          )}

          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text strong>设置窗口</Typography.Text>
            <Space size={8} wrap>
              <Select
                style={{ minWidth: 260 }}
                placeholder="选择模型"
                value={editingModel || undefined}
                options={modelOptions}
                showSearch
                onChange={(value) => {
                  setEditingModel(value);
                  const row = rows.find((item) => item.model === value);
                  setDraftTokens(row && row.override > 0 ? row.override : null);
                }}
              />
              <InputNumber
                style={{ width: 180 }}
                min={limits.min}
                max={limits.max}
                step={1024}
                placeholder="tokens"
                value={draftTokens ?? undefined}
                onChange={(value) => setDraftTokens(typeof value === 'number' ? value : null)}
              />
              <Button type="primary" loading={submitting} disabled={!editingModel} onClick={() => void save()}>
                保存
              </Button>
              <Button
                disabled={!editingModel}
                onClick={() => {
                  setDraftTokens(null);
                  void save();
                }}
              >
                清除设置
              </Button>
            </Space>
            <Typography.Text type="secondary">
              留空并保存 = 清除手动设置，回落到自动探测或目录值。范围 {limits.min.toLocaleString()} – {limits.max.toLocaleString()} tokens。
            </Typography.Text>
          </Space>

          {sameTypeAccounts.length > 0 ? (
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Checkbox
                checked={applyToSameType}
                onChange={(event) => {
                  setApplyToSameType(event.target.checked);
                  if (event.target.checked) setSelectedPeers(sameTypeAccounts.map((item) => item.accountRef));
                  else setSelectedPeers([]);
                }}
              >
                同时设置其它 {TYPE_LABELS[credentialType] || credentialType} 账号（{sameTypeAccounts.length} 个）
              </Checkbox>
              {applyToSameType ? (
                <Checkbox.Group
                  style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 24 }}
                  value={selectedPeers}
                  onChange={(values) => setSelectedPeers(values as string[])}
                  options={sameTypeAccounts.map((item) => ({
                    label: `${item.displayName || item.accountRef}${item.disabled ? '（已关闭）' : ''}`,
                    value: item.accountRef
                  }))}
                />
              ) : null}
            </Space>
          ) : null}

          <Alert
            type="info"
            showIcon
            message="上游不声明窗口时无法自动获取"
            description="此时请以实测为准（例如二分探测请求直到被拒），不要凭经验填写 —— 填小了会误拦合法请求，填大了超限请求会挂到超时。"
          />
        </Space>
      </Spin>
    </Modal>
  );
}
