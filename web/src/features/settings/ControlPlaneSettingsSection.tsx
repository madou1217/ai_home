import { useEffect, useState } from 'react';
import { Form, Input, Modal, Select, Space, Tabs, message } from 'antd';
import { StatisticCard } from '@ant-design/pro-components';
import { CopyOutlined, LinkOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import SettingSection from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import ManagementKeyInput from '@/components/control-plane/ManagementKeyInput';
import ControlPlaneServerList from '@/components/settings/ControlPlaneServerList';
import {
  formatEndpointHintLabel,
  resolveDefaultControlEndpoint
} from '@/services/control-plane-endpoints';
import {
  isControlPlaneManagementKeyConfigured,
  summarizeControlPlaneProfiles
} from '@/services/control-plane-profiles';
import type { ServerRouteRow } from '@/services/server-route-presentation';
import { writeClipboardText } from '@/utils/clipboard';
import type { ControlPlaneEndpointHint, ControlPlaneProfile } from '@/types';

export interface ControlPlaneSettingsSectionProps {
  profiles: ControlPlaneProfile[];
  logicalProfiles: ControlPlaneProfile[];
  serverRouteRows: ServerRouteRow[];
  activeControlPlaneId: string;
  activeControlPlaneProfile: ControlPlaneProfile | null;
  endpointHints: ControlPlaneEndpointHint[];
  endpointWarnings: string[];
  saving: boolean;
  checkingId: string;
  addModalOpen: boolean;
  authorizingId: string;
  onOpenAddModal: () => void;
  onOpenAuthorizeModal: (profile: ControlPlaneProfile) => void;
  onCloseModal: () => void;
  onSaveProfile: (values: { endpoint?: string; name?: string; managementKey?: string }) => Promise<ControlPlaneProfile>;
  onRefreshProfile: (profile: ControlPlaneProfile) => Promise<void>;
  onRemoveProfile: (profileId: string) => Promise<void>;
  onSelectProfile: (profileId: string) => Promise<void>;
}

const formatActiveLabel = (profile: ControlPlaneProfile | null) => {
  if (!profile) return '未选择 Server';
  return profile.name || profile.endpoint || profile.id;
};

const formatActiveEndpoint = (profile: ControlPlaneProfile | null) => {
  if (!profile) return '请先添加 Server';
  return profile.endpoint;
};

function renderEndpointHints(
  hints: ControlPlaneEndpointHint[],
  warnings: string[],
  onSelect: (endpoint: string) => void
) {
  if (hints.length === 0) return null;
  return (
    <div className="settings-endpoint-hints">
      <Space size={[6, 6]} wrap>
        {hints.map((hint) => (
          <Button
            key={`${hint.source}:${hint.endpoint}`}
            size="small"
            type={hint.recommended ? 'primary' : 'default'}
            icon={<LinkOutlined />}
            htmlType="button"
            onClick={() => onSelect(hint.endpoint)}
          >
            {formatEndpointHintLabel(hint)}
          </Button>
        ))}
      </Space>
      {warnings.length > 0 && (
        <div className="settings-endpoint-warning">
          {warnings.slice(0, 2).map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 「Server 管理」区块：默认 Server 切换、运行概览、已保存列表与添加/授权弹窗。
 */
export default function ControlPlaneSettingsSection({
  profiles,
  logicalProfiles,
  serverRouteRows,
  activeControlPlaneId,
  activeControlPlaneProfile,
  endpointHints,
  endpointWarnings,
  saving,
  checkingId,
  addModalOpen,
  authorizingId,
  onOpenAddModal,
  onOpenAuthorizeModal,
  onCloseModal,
  onSaveProfile,
  onRefreshProfile,
  onRemoveProfile,
  onSelectProfile
}: ControlPlaneSettingsSectionProps) {
  const [form] = Form.useForm();
  const [copyFeedback, setCopyFeedback] = useState(false);

  const overview = summarizeControlPlaneProfiles(logicalProfiles);
  const authorizingProfile = profiles.find((profile) => profile.id === authorizingId) || null;

  useEffect(() => {
    if (!addModalOpen) return;
    if (authorizingProfile) {
      form.setFieldsValue({
        endpoint: authorizingProfile.endpoint,
        name: authorizingProfile.name,
        managementKey: ''
      });
    } else {
      form.setFieldsValue({
        endpoint: resolveDefaultControlEndpoint(endpointHints, ''),
        name: 'AIH Server',
        managementKey: ''
      });
    }
  }, [addModalOpen, authorizingProfile, endpointHints, form]);

  const handleCopyEndpoint = async (endpoint: string) => {
    try {
      await writeClipboardText(endpoint);
      setCopyFeedback(true);
      window.setTimeout(() => setCopyFeedback(false), 1800);
      message.success('Server URL 已复制');
    } catch (error: unknown) {
      message.error(`复制失败：${error instanceof Error ? error.message : '无法写入剪贴板'}`);
    }
  };

  const handleFinish = async (values: { endpoint?: string; name?: string; managementKey?: string }) => {
    try {
      const saved = await onSaveProfile(values);
      form.setFieldsValue({
        endpoint: saved.endpoint,
        name: saved.name,
        managementKey: ''
      });
      onCloseModal();
    } catch (_error) {
      // 错误提示已由 hook 发出
    }
  };

  return (
    <div className="settings-control-plane-page">
      <SettingSection
        title="默认 Server"
        description="未指定 server 参数的页面默认连接此实例；点击列表中的“打开”可在新标签页固定单台 Server。"
        status={
          <SettingStatusTag
            status={activeControlPlaneProfile ? 'applied' : 'unset'}
            label={activeControlPlaneProfile ? '已连接默认' : '未选择'}
            compact
          />
        }
        className="settings-control-plane-shell"
      >
        <div className="settings-control-plane-current hud-panel hud-panel--sm">
          <div className="settings-control-plane-current-main">
            <span className="hud-label">当前默认</span>
            <strong>{formatActiveLabel(activeControlPlaneProfile)}</strong>
            <span className="settings-control-plane-endpoint">
              <em>{formatActiveEndpoint(activeControlPlaneProfile)}</em>
              {activeControlPlaneProfile?.endpoint ? (
                <Button
                  size="small"
                  type="text"
                  className="settings-copy-trigger"
                  icon={<CopyOutlined />}
                  aria-label="复制 Server URL"
                  onClick={() => void handleCopyEndpoint(activeControlPlaneProfile.endpoint)}
                >
                  {copyFeedback ? '已复制' : '复制'}
                </Button>
              ) : null}
            </span>
          </div>
          <div className="settings-control-plane-current-actions">
            <Select
              value={activeControlPlaneId || undefined}
              placeholder="选择 Server"
              disabled={profiles.length === 0}
              onChange={(profileId) => void onSelectProfile(profileId)}
              options={serverRouteRows.map((row) => ({
                value: row.profile.id,
                label: row.authorizationPending
                  ? `${row.profile.name || row.profile.endpoint}（待授权）`
                  : row.profile.name || row.profile.endpoint || row.profile.id,
                disabled: row.authorizationPending
              }))}
            />
            <Button
              icon={<ReloadOutlined />}
              disabled={!activeControlPlaneProfile}
              loading={checkingId === activeControlPlaneProfile?.id}
              onClick={() => activeControlPlaneProfile && void onRefreshProfile(activeControlPlaneProfile)}
            >
              同步当前
            </Button>
          </div>
        </div>

        <StatisticCard.Group direction="row" bordered={false} className="hos-kpi-strip">
          <StatisticCard statistic={{ title: '服务器', value: overview.total }} />
          <StatisticCard statistic={{ title: '可调度账号', value: overview.schedulableAccounts }} />
          <StatisticCard statistic={{ title: '会话', value: overview.sessions }} />
        </StatisticCard.Group>

        <Tabs
          className="settings-control-plane-manage-tabs"
          animated={{ inkBar: true, tabPane: true }}
          items={[
            {
              key: 'profiles',
              label: '已保存 Server',
              children: serverRouteRows.length === 0 ? (
                <div key="cp-empty" className="settings-control-plane-empty aih-fade-in">
                  <InlineNote tone="info">暂无已保存 Server</InlineNote>
                  <Button type="primary" icon={<PlusOutlined />} onClick={onOpenAddModal}>
                    添加 Server
                  </Button>
                </div>
              ) : (
                <div key="cp-list" className="aih-fade-in">
                  <ControlPlaneServerList
                    rows={serverRouteRows}
                    activeControlPlaneId={activeControlPlaneId}
                    checkingControlPlaneId={checkingId}
                    onSelect={(id) => void onSelectProfile(id)}
                    onRefresh={(profile) => void onRefreshProfile(profile)}
                    onRemove={(id) => void onRemoveProfile(id)}
                    onAuthorize={onOpenAuthorizeModal}
                  />
                </div>
              )
            }
          ]}
        />
      </SettingSection>

      <Modal
        title={authorizingId ? '授权 Server' : '添加 Server'}
        open={addModalOpen}
        width={760}
        footer={null}
        forceRender
        onCancel={onCloseModal}
      >
        <Form
          form={form}
          className="settings-form"
          layout="vertical"
          onFinish={(values) => void handleFinish(values)}
          initialValues={{ endpoint: '', name: 'AIH Server' }}
        >
          <div className="settings-form-panel hud-panel hud-panel--sm">
            <Form.Item
              name="endpoint"
              label="Server URL"
              help="支持 HTTPS、Tailscale/ZeroTier/WireGuard IP、Tunnel 或局域网地址。"
              rules={[{ required: true, message: '请输入 Server URL' }]}
            >
              <Input placeholder="https://aih.example.com" />
            </Form.Item>
            {renderEndpointHints(
              endpointHints,
              endpointWarnings,
              (endpoint) => form.setFieldsValue({ endpoint })
            )}

            <Form.Item name="name" label="显示名称">
              <Input placeholder="Home AIH" />
            </Form.Item>

            <Form.Item
              name="managementKey"
              label="Management Key"
              help="可扫码填写；编辑已保存 Server 时留空保留原 Key。"
              rules={[{
                required: !isControlPlaneManagementKeyConfigured(authorizingProfile),
                message: '请输入 Management Key'
              }]}
            >
              <ManagementKeyInput
                expectedEndpoint={authorizingProfile?.endpoint}
                onCredentials={(credentials) => form.setFieldsValue(credentials)}
              />
            </Form.Item>
          </div>

          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<LinkOutlined />} loading={saving}>
              {authorizingId ? '授权并连接' : '探测并保存'}
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
