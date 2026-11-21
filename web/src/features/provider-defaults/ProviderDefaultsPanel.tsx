import { useCallback, useEffect, useMemo, useState } from 'react';
import { AutoComplete, Form, Select, Space, Switch, message } from 'antd';
import { ProCard } from '@ant-design/pro-components';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import { providerDefaultsAPI, type ProviderDefaultsResponse } from '@/services/api';

const EFFORT_LABELS: Record<string, string> = {
  none: 'none（关闭推理）',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'ultra'
};

function describeError(error: unknown): string {
  const response = (error as { response?: { data?: { message?: string } } })?.response;
  return response?.data?.message || (error instanceof Error ? error.message : '请求失败');
}

/**
 * Provider CLI 启动默认值的结构化配置。
 *
 * 与 CLI `aih codex model|effort` 写同一份宿主 config.toml：WebUI 改完，
 * 宿主机与账号投影里的 `aih codex` 都会在下次启动时使用。
 */
export default function ProviderDefaultsPanel() {
  const [data, setData] = useState<ProviderDefaultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [fast, setFast] = useState(false);
  const [status, setStatus] = useState('');
  const [statusTone, setStatusTone] = useState<'info' | 'success' | 'error'>('info');

  const applyResponse = useCallback((next: ProviderDefaultsResponse) => {
    setData(next);
    setModel(next.model || '');
    setEffort(next.reasoningEffort || '');
    setFast(next.serviceTier === 'fast');
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await providerDefaultsAPI.get('codex');
      applyResponse(next);
      setStatusTone('info');
      setStatus(next.configPath ? `配置文件：${next.configPath}` : '');
    } catch (error) {
      setStatusTone('error');
      setStatus(describeError(error));
    } finally {
      setLoading(false);
    }
  }, [applyResponse]);

  useEffect(() => {
    void load();
  }, [load]);

  const modelOptions = useMemo(
    () => (data?.models || []).map((id) => ({ value: id, label: id })),
    [data]
  );

  const effortOptions = useMemo(() => {
    const byModel = model ? data?.reasoningEffortsByModel?.[model] : undefined;
    const levels = byModel?.length ? byModel : data?.reasoningEfforts || [];
    return levels.map((level) => ({ value: level, label: EFFORT_LABELS[level] || level }));
  }, [data, model]);

  const save = async () => {
    const trimmed = model.trim();
    if (!trimmed) {
      message.warning('请选择或输入默认模型');
      return;
    }
    setSaving(true);
    try {
      const next = await providerDefaultsAPI.update({
        provider: 'codex',
        model: trimmed,
        ...(effort ? { reasoningEffort: effort } : {}),
        serviceTier: fast ? 'fast' : 'default'
      });
      applyResponse(next);
      setStatusTone('success');
      setStatus('已保存；新启动的 aih codex 会话生效。');
      message.success('启动默认值已保存');
    } catch (error) {
      setStatusTone('error');
      setStatus(describeError(error));
      message.error(describeError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-grid settings-grid--single">
      <ProCard className="settings-panel hud-panel" bordered bodyStyle={{ padding: 16 }}>
        <div className="settings-panel-head">
          <div>
            <h2>Codex 启动默认</h2>
            <p>新启动的 aih codex 会话使用这里的模型与推理强度，与 CLI 写同一份配置。</p>
          </div>
        </div>
        <Form layout="vertical" disabled={loading}>
          <Form.Item
            label="默认模型"
            help="候选来自宿主模型目录；目录尚未探测时可直接输入模型 ID。"
          >
            <AutoComplete
              value={model}
              options={modelOptions}
              onChange={(value) => setModel(value)}
              placeholder="gpt-6.1-sol"
              allowClear
              filterOption={(input, option) =>
                String(option?.value || '').toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>
          <Form.Item
            label="推理强度"
            help="档位由所选模型的目录声明；实际可用性仍取决于模型和账号。"
          >
            <Select
              value={effort || undefined}
              options={effortOptions}
              onChange={(value) => setEffort(value)}
              placeholder="未设置"
              allowClear
            />
          </Form.Item>
          <Form.Item label="Fast 服务档" help="开启后写入 service_tier = fast。">
            <Switch checked={fast} onChange={setFast} checkedChildren="Fast" unCheckedChildren="默认" />
          </Form.Item>
          <Form.Item>
            <Space className="settings-actions">
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
                保存启动默认
              </Button>
              <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
                重新读取
              </Button>
            </Space>
          </Form.Item>
        </Form>
        {status ? (
          <InlineNote tone={statusTone === 'success' ? 'success' : statusTone === 'error' ? 'error' : 'info'}>
            {status}
          </InlineNote>
        ) : null}
      </ProCard>
    </div>
  );
}