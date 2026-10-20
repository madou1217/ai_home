import { useEffect, useMemo, useState } from 'react';
import { Modal, Spin, Switch, Tabs, message } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  FileTextOutlined,
  SafetyCertificateOutlined,
  WarningOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { toolkitAPI } from '@/services/api';
import type {
  ManagedAppItem,
  ToolPermissionCapability,
  ToolPermissionSettings
} from '@/types';
import ProviderConfigPanel from '@/features/provider-config/ProviderConfigPanel';
import './app-advanced-settings.css';

function errorText(error: unknown, fallback: string): string {
  const candidate = error as {
    response?: { data?: { message?: string; error?: string } };
    message?: string;
  };
  return candidate?.response?.data?.message
    || candidate?.response?.data?.error
    || candidate?.message
    || fallback;
}

function hostStateText(capability: ToolPermissionCapability): string {
  if (!capability.hostSupported) {
    return capability.hostReason
      ? `不可写入宿主配置（${capability.hostReason}）`
      : '不可写入宿主配置';
  }
  if (!capability.hostExists) return '宿主配置文件尚未创建，保存时会自动创建';
  if (!capability.hostWritable) return '宿主配置文件当前不可写，保存会失败';
  return '宿主配置文件已存在，保存前会自动备份';
}

export interface AppAdvancedSettingsModalProps {
  open: boolean;
  app: ManagedAppItem | null;
  onClose: () => void;
}

export default function AppAdvancedSettingsModal({ open, app, onClose }: AppAdvancedSettingsModalProps) {
  const provider = app?.provider || '';
  const [activeTab, setActiveTab] = useState('permission');
  const [settings, setSettings] = useState<ToolPermissionSettings | null>(null);
  const [capability, setCapability] = useState<ToolPermissionCapability | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const showPermissionTab = app?.type === 'cli';
  const showConfigTab = Boolean(provider && (app?.configFileCount || 0) > 0);
  const tabs = useMemo(() => {
    const items = [];
    if (showPermissionTab) {
      items.push({ key: 'permission', label: '启动权限' });
    }
    if (showConfigTab) {
      items.push({ key: 'config', label: '配置文件' });
    }
    return items;
  }, [showConfigTab, showPermissionTab]);

  useEffect(() => {
    if (!open) return;
    setActiveTab(showPermissionTab ? 'permission' : 'config');
  }, [open, provider, showPermissionTab]);

  useEffect(() => {
    if (!open || !provider || !showPermissionTab) {
      setSettings(null);
      setCapability(null);
      setError('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    toolkitAPI.getAppPermissionSettings(provider)
      .then((response) => {
        if (cancelled) return;
        setSettings(response.settings);
        setCapability(response.capability);
      })
      .catch((requestFailure: unknown) => {
        if (cancelled) return;
        setError(errorText(requestFailure, '读取启动权限设置失败'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, provider, reloadToken, showPermissionTab]);

  const savePermission = async () => {
    if (!provider || !settings) return;
    setSaving(true);
    setError('');
    try {
      const response = await toolkitAPI.saveAppPermissionSettings(provider, {
        maxPermission: settings.maxPermission,
        applyToHost: settings.applyToHost
      });
      setSettings(response.settings);
      setCapability(response.capability);
      if (response.hostApply?.applied) {
        message.success(response.hostApply.changed
          ? '启动权限已保存，并写入宿主配置文件'
          : '启动权限已保存，宿主配置已是最新');
      } else {
        message.success('启动权限已保存，新开的 aih CLI 会话会使用该设置');
      }
    } catch (requestFailure: unknown) {
      setError(errorText(requestFailure, '保存启动权限失败'));
    } finally {
      setSaving(false);
    }
  };

  const launchPreview = capability?.maxArgs?.length
    ? capability.maxArgs.join(' ')
    : '';

  return (
    <Modal
      open={open}
      title={app ? `${app.name} · 高级设置` : '高级设置'}
      width={1160}
      footer={null}
      destroyOnClose
      onCancel={onClose}
      className="app-advanced-settings-modal"
    >
      {!app ? null : (
        <div className="aas-shell">
          {tabs.length > 1 ? (
            <Tabs
              activeKey={activeTab}
              onChange={setActiveTab}
              items={tabs}
              className="aas-tabs"
            />
          ) : (
            <div className="aas-single-title">{tabs[0]?.label || '高级设置'}</div>
          )}

          {activeTab === 'permission' && showPermissionTab ? (
            <div className="aas-permission-pane">
              {loading ? (
                <div className="aas-loading"><Spin tip="正在读取启动权限设置" /></div>
              ) : error && !settings ? (
                <div className="aas-inline-state" data-tone="error" role="alert">
                  <CloseCircleOutlined />
                  <span>{error}</span>
                  <Button size="small" onClick={() => setReloadToken((value) => value + 1)}>重试</Button>
                </div>
              ) : settings && capability ? (
                <>
                  <section className="aas-section">
                    <div className="aas-section-head">
                      <SafetyCertificateOutlined />
                      <div>
                        <strong>aih 启动的 CLI 会话</strong>
                        <span>默认给新开的 aih 会话注入最大权限，不再逐次确认。</span>
                      </div>
                      <Switch
                        checked={settings.maxPermission}
                        disabled={!capability.maxSupported}
                        onChange={(checked) => setSettings({
                          ...settings,
                          maxPermission: checked,
                          applyToHost: checked ? settings.applyToHost : false
                        })}
                        aria-label="默认最大权限"
                      />
                    </div>
                    {capability.maxSupported ? (
                      <div className="aas-code-line">
                        <span>启动时自动追加</span>
                        <code>{launchPreview}</code>
                      </div>
                    ) : (
                      <div className="aas-inline-state" data-tone="muted">
                        <WarningOutlined />
                        <span>{capability.maxReason || '该应用尚未声明免确认参数，启动时保持原生确认。'}</span>
                      </div>
                    )}
                    <p className="aas-hint">
                      已经显式传入权限参数（例如 <code>--permission-mode</code>）时不会覆盖；
                      登录 / 授权流程也不会注入。
                    </p>
                  </section>

                  <section className="aas-section">
                    <div className="aas-section-head">
                      <FileTextOutlined />
                      <div>
                        <strong>应用到宿主</strong>
                        <span>同时写入 {app.name} 自己的宿主配置，非 aih 启动的应用也会使用。</span>
                      </div>
                      <Switch
                        checked={settings.applyToHost}
                        disabled={!settings.maxPermission || !capability.hostSupported}
                        onChange={(checked) => setSettings({ ...settings, applyToHost: checked })}
                        aria-label="应用到宿主"
                      />
                    </div>
                    <div className="aas-host-state" data-tone={capability.hostSupported ? 'ok' : 'muted'}>
                      {capability.hostSupported ? <CheckCircleOutlined /> : <WarningOutlined />}
                      <span>{hostStateText(capability)}</span>
                    </div>
                    {capability.hostSupported && capability.hostDisplayPath ? (
                      <code className="aas-path" title={capability.hostDisplayPath}>{capability.hostDisplayPath}</code>
                    ) : null}
                    {!capability.hostSupported ? (
                      <p className="aas-hint">
                        该应用没有登记可写入宿主的权限字段，开启后仍然只影响 aih 启动的会话。
                      </p>
                    ) : null}
                  </section>

                  {error ? (
                    <div className="aas-inline-state" data-tone="error" role="alert">
                      <CloseCircleOutlined />
                      <span>{error}</span>
                    </div>
                  ) : null}

                  <footer className="aas-footer">
                    <span>关闭开关后，新会话恢复原生权限确认；已经运行的会话不受影响。</span>
                    <Button type="primary" loading={saving} onClick={() => void savePermission()}>
                      保存设置
                    </Button>
                  </footer>
                </>
              ) : null}
            </div>
          ) : activeTab === 'config' && showConfigTab ? (
            <div className="aas-config-pane">
              <ProviderConfigPanel providerId={provider} embedded />
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
