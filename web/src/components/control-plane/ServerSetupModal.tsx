import { useEffect, useMemo, useState } from 'react';
import { Form, Input, Modal } from 'antd';
import { ApiOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import SaveActionBar from '@/components/ui/SaveActionBar';
import HudCube from '@/components/hud/HudCube';
import ManagementKeyInput from './ManagementKeyInput';
import ServerConnectionFlow from './ServerConnectionFlow';
import {
  formatServerKeyPersistenceLabel,
  type ServerLifecycleState
} from './server-list-presentation';
import type { ServerSetupFormValues } from './use-server-setup-profiles';
import type { ProbeControlPlaneProfileResult } from '@/services/control-plane-profile-connection';
import type { ServerSetupDialogState } from '@/services/server-setup-state';
import { isControlPlaneManagementKeyConfigured, normalizeControlPlaneEndpoint } from '@/services/control-plane-profiles';
import type { ControlPlaneProfile } from '@/types';

export interface ServerSetupModalProps {
  dialog: ServerSetupDialogState;
  required: boolean;
  defaults: { endpoint: string; name: string };
  targetProfile: ControlPlaneProfile | null;
  activeProfileId: string;
  bootstrapIssue: 'unauthorized' | null;
  probing: boolean;
  saving: boolean;
  lastProbe: ProbeControlPlaneProfileResult | null;
  lastFeedback: { tone: 'muted' | 'success' | 'error'; text: string } | null;
  onCancel: () => void;
  onProbe: (values: ServerSetupFormValues) => Promise<ProbeControlPlaneProfileResult | null>;
  onSave: (values: ServerSetupFormValues) => Promise<void>;
  onResetProbe: () => void;
}

/**
 * Server 连接 / 探测 / 保存弹窗：
 * - 清晰呈现 4 步进度（连接地址 → 探测凭证 → 保存配置 → 当前生效）；
 * - 就近回显已持久化的地址与 Management Key 状态；
 * - 支持独立「探测连接」后再保存，状态与报错紧邻操作栏展示。
 */
export default function ServerSetupModal({
  dialog,
  required,
  defaults,
  targetProfile,
  activeProfileId,
  bootstrapIssue,
  probing,
  saving,
  lastProbe,
  lastFeedback,
  onCancel,
  onProbe,
  onSave,
  onResetProbe
}: ServerSetupModalProps) {
  const [form] = Form.useForm<ServerSetupFormValues>();
  const [draftValues, setDraftValues] = useState<ServerSetupFormValues>({
    endpoint: defaults.endpoint,
    name: defaults.name,
    managementKey: ''
  });
  const open = dialog.mode !== 'closed';

  useEffect(() => {
    if (!open) return;
    const next = {
      endpoint: defaults.endpoint,
      name: defaults.name,
      managementKey: ''
    };
    form.setFieldsValue(next);
    setDraftValues(next);
    onResetProbe();
  }, [defaults.endpoint, defaults.name, dialog.mode, dialog.profileId, form, onResetProbe, open]);

  const normalizedDraftEndpoint = normalizeControlPlaneEndpoint(String(draftValues.endpoint || ''));
  const probeMatchesDraft = Boolean(
    lastProbe && normalizedDraftEndpoint && lastProbe.endpoint === normalizedDraftEndpoint
  );
  const keyConfigured = isControlPlaneManagementKeyConfigured(targetProfile);
  const hasDraftInput = Boolean(
    normalizedDraftEndpoint
    && (String(draftValues.managementKey || '').trim() || keyConfigured)
  );
  const isFormDirty = Boolean(
    !targetProfile
    || normalizedDraftEndpoint !== targetProfile.endpoint
    || String(draftValues.name || '').trim() !== String(targetProfile.name || '').trim()
    || String(draftValues.managementKey || '').trim().length > 0
    || probeMatchesDraft
  );

  const lifecycle: ServerLifecycleState = useMemo(() => {
    if (probing || saving) return 'probing';
    if (lastFeedback?.tone === 'error') return 'failed';
    if (probeMatchesDraft) return 'probed_unsaved';
    if (targetProfile) {
      if (targetProfile.state === 'degraded' || Boolean(targetProfile.lastError)) return 'failed';
      if (targetProfile.state === 'ready') {
        return targetProfile.id === activeProfileId ? 'active' : 'saved_inactive';
      }
    }
    return 'disconnected';
  }, [activeProfileId, lastFeedback?.tone, probeMatchesDraft, probing, saving, targetProfile]);

  const handleProbeClick = async () => {
    try {
      const values = await form.validateFields(['endpoint', 'name', 'managementKey']);
      await onProbe(values);
    } catch {
      // 表单校验提示就地显示
    }
  };

  const handleFinish = async (values: ServerSetupFormValues) => {
    await onSave(values);
  };

  const modalTitle = dialog.mode === 'authorize'
    ? '授权 Server'
    : dialog.mode === 'add'
      ? '添加 Server'
      : '连接 AIH Server';

  const saveLabel = dialog.mode === 'authorize'
    ? '保存并授权'
    : dialog.mode === 'initial'
      ? '保存并进入工作台'
      : '保存并设为当前';

  const effectSummary = dialog.mode === 'initial'
    ? '保存后写入配置并进入工作台'
    : '保存后立即切换为当前生效 Server';

  return (
    <Modal
      title={modalTitle}
      open={open}
      width={720}
      rootClassName={required ? 'server-setup-boot server-setup-boot--gate' : 'server-setup-boot'}
      footer={null}
      closable={!required}
      maskClosable={!required}
      keyboard={!required}
      destroyOnClose={false}
      forceRender
      onCancel={() => {
        if (!required) onCancel();
      }}
    >
      <div className="server-setup-boot-code">
        <HudCube size={18} mode="brand" tone="cyan" interactive label="AIH Server 全息棱镜" />
        <span>SYS // SETUP</span>
        <span className="server-setup-boot-mode">{dialog.mode.toUpperCase()}</span>
      </div>

      <ServerConnectionFlow lifecycle={lifecycle} detail={lastFeedback?.text} />

      <div className="cp-persisted-strip" aria-label="已持久化连接信息">
        <span className="cp-persisted-item">
          已保存地址：<strong>{targetProfile?.endpoint || '未配置'}</strong>
        </span>
        <span className="cp-persisted-item">
          凭据状态：<strong>{formatServerKeyPersistenceLabel(targetProfile)}</strong>
        </span>
        {bootstrapIssue === 'unauthorized' ? (
          <span className="cp-persisted-item" style={{ color: 'var(--color-danger)' }}>
            鉴权失效，请更新 Management Key
          </span>
        ) : null}
      </div>

      <Form
        form={form}
        className="settings-form"
        layout="vertical"
        onValuesChange={(_changed, allValues) => {
          setDraftValues(allValues);
          if (lastProbe && normalizeControlPlaneEndpoint(String(allValues.endpoint || '')) !== lastProbe.endpoint) {
            onResetProbe();
          }
        }}
        onFinish={(values) => void handleFinish(values)}
        initialValues={{ endpoint: '', name: 'AIH Server', managementKey: '' }}
      >
        <div className="settings-form-panel hud-panel hud-panel--sm">
          <Form.Item
            name="endpoint"
            label="Server 网关地址"
            help="跨公网访问建议使用 HTTPS、VPN 或受控隧道。"
            rules={[{ required: true, message: '请输入 Server 网关地址' }]}
          >
            <Input
              disabled={dialog.mode === 'authorize'}
              placeholder="https://aih.example.com"
            />
          </Form.Item>

          <Form.Item name="name" label="显示名称">
            <Input placeholder="Home Server / Company Server" />
          </Form.Item>

          <Form.Item
            name="managementKey"
            label="Management Key"
            help={keyConfigured ? '留空将沿用已保存 Key；可通过 aih server config --show-secrets 查看。' : '可通过 aih server config --show-secrets 查看。'}
            required={!keyConfigured}
            rules={[{ required: !keyConfigured, message: '请输入 Management Key' }]}
          >
            <ManagementKeyInput
              expectedEndpoint={dialog.profileId ? defaults.endpoint : undefined}
              onCredentials={(credentials) => {
                form.setFieldsValue(credentials);
                setDraftValues((prev) => ({ ...prev, ...credentials }));
              }}
            />
          </Form.Item>
        </div>

        <div className="cp-setup-modal-footer">
          <SaveActionBar
            dirty={isFormDirty}
            saving={saving}
            disabled={probing || !hasDraftInput}
            htmlType="submit"
            saveLabel={saveLabel}
            cleanSaveLabel="当前已保存"
            status={
              saving
                ? 'saving'
                : probing
                  ? 'saving'
                  : lastFeedback?.tone === 'error'
                    ? 'error'
                    : probeMatchesDraft
                      ? 'dirty'
                      : isFormDirty
                        ? 'dirty'
                        : 'applied'
            }
            statusLabel={
              saving
                ? '保存中'
                : probing
                  ? '探测中'
                  : lastFeedback?.tone === 'error'
                    ? '失败'
                    : probeMatchesDraft
                      ? '已探测未保存'
                      : isFormDirty
                        ? '未保存'
                        : '当前生效'
            }
            effectSummary={effectSummary}
            feedback={lastFeedback?.text}
            feedbackTone={lastFeedback?.tone || 'muted'}
            extraActions={
              <Button
                htmlType="button"
                icon={<ApiOutlined />}
                loading={probing}
                disabled={saving || !hasDraftInput}
                onClick={() => void handleProbeClick()}
              >
                探测连接
              </Button>
            }
          />
        </div>
      </Form>
    </Modal>
  );
}
