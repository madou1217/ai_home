import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Form, Input, Modal, Space, Tag, Typography } from 'antd';
import PageHeaderActions from '@/components/ui/PageHeaderActions';
import { StatisticCard } from '@ant-design/pro-components';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  LoginOutlined,
  ReloadOutlined,
  PlusOutlined
} from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import { isControlPlaneManagementKeyConfigured, isControlPlaneProfileReady } from '@/services/control-plane-profiles';
import { getBrowserControlEndpoint } from '@/services/control-plane-endpoints';
import {
  CLOSED_SERVER_SETUP_DIALOG,
  resolveRequiredServerSetupDialog,
  resolveServerSetupFormDefaults,
  type ServerSetupDialogState
} from '@/services/server-setup-state';
import {
  formatServerSetupProfileDetail as formatProfileDetail,
  getServerSetupProfileStatus as getProfileStatus,
  useServerSetupProfiles,
  type ServerSetupFormValues as SaveFormValues
} from '@/components/control-plane/use-server-setup-profiles';
import type { ControlPlaneProfile } from '@/types';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import '@/components/settings/settings-shared.css';
import '@/components/ui/kpi-strip.css';
import SectionCard from '@/components/ui/SectionCard';
import ListTable from '@/components/ui/ListTable';

const PROFILE_STATUS_LED: Record<string, string> = {
  green: 'hud-led hud-led--ok',
  orange: 'hud-led hud-led--warn'
};

type ProfileRow = ControlPlaneProfile & { __key: string };

export default function FabricServerSetup() {
  const navigate = useNavigate();
  const [saveForm] = Form.useForm<SaveFormValues>();
  // 数据与操作（连接 / 同步 / 移除 / 设为当前）由 useServerSetupProfiles 提供，移动端首启页共用
  const {
    profiles,
    activeProfileId,
    activeProfile,
    readyProfiles,
    hasReadyServer,
    checkingId,
    saving,
    saveServer,
    refreshProfile: handleRefreshProfile,
    removeProfile: handleRemoveProfile,
    selectProfile: handleSelectProfile
  } = useServerSetupProfiles();
  const [setupDialog, setSetupDialog] = useState<ServerSetupDialogState>(
    () => resolveRequiredServerSetupDialog(profiles, activeProfileId) || CLOSED_SERVER_SETUP_DIALOG
  );

  const requiredDialog = resolveRequiredServerSetupDialog(profiles, activeProfileId);
  const effectiveDialog = setupDialog.mode === 'closed' && requiredDialog
    ? requiredDialog
    : setupDialog;
  const setupModalOpen = effectiveDialog.mode !== 'closed';
  const setupModalRequired = Boolean(requiredDialog);
  const dialogDefaults = resolveServerSetupFormDefaults({
    dialog: effectiveDialog,
    profiles,
    browserEndpoint: getBrowserControlEndpoint()
  });

  useEffect(() => {
    if (!setupModalOpen) return;
    saveForm.setFieldsValue({
      ...dialogDefaults,
      managementKey: ''
    });
  }, [
    dialogDefaults.endpoint,
    dialogDefaults.name,
    effectiveDialog.mode,
    effectiveDialog.profileId,
    saveForm,
    setupModalOpen
  ]);

  const handleSaveServer = async (values: SaveFormValues) => {
    const completingInitialSetup = !hasReadyServer;
    const saved = await saveServer(effectiveDialog.profileId, values);
    if (!saved) return;
    saveForm.setFieldValue('managementKey', '');
    setSetupDialog(CLOSED_SERVER_SETUP_DIALOG);
    if (completingInitialSetup) navigate('/dashboard', { replace: true });
  };

  const openAddServer = () => {
    setSetupDialog({ mode: 'add', profileId: '' });
  };

  const openServerAuthorization = (profile: ControlPlaneProfile) => {
    setSetupDialog({ mode: 'authorize', profileId: profile.id });
  };

  const profileRows: ProfileRow[] = useMemo(
    () => profiles.map((profile) => ({ ...profile, __key: profile.id })),
    [profiles]
  );

  const profileColumns: ProColumns<ProfileRow>[] = useMemo(() => [
    {
      title: 'Server',
      dataIndex: 'name',
      width: 240,
      ellipsis: true,
      render: (_, record) => (
        <Space direction="vertical" size={0} className="server-setup-cell">
          <strong className="server-setup-name">
            {record.name || record.endpoint}
          </strong>
          <Typography.Text type="secondary" className="server-setup-endpoint">{record.endpoint}</Typography.Text>
          {record.lastError && (
            <Typography.Text type="danger" className="server-setup-error">{record.lastError}</Typography.Text>
          )}
        </Space>
      )
    },
    {
      title: '状态 / 摘要',
      width: 320,
      render: (_, record) => {
        const status = getProfileStatus(record);
        const active = record.id === activeProfileId;
        return (
          <Space wrap size={[4, 4]}>
            {active && <Tag className="settings-current-tag">当前</Tag>}
            <Tag color={status.color} className="server-setup-status-tag">
              <span className={PROFILE_STATUS_LED[status.color] || 'hud-led'} aria-hidden="true" />
              {status.label}
            </Tag>
            <Tag className="server-setup-detail-tag">{formatProfileDetail(record)}</Tag>
          </Space>
        );
      }
    },
    {
      title: '操作',
      width: 200,
      render: (_, record) => {
        const active = record.id === activeProfileId;
        return (
          <Space size={6} wrap>
            <Button size="small" disabled={active} onClick={() => handleSelectProfile(record.id)}>
              设为当前
            </Button>
            {isControlPlaneManagementKeyConfigured(record) ? (
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={checkingId === record.id}
                onClick={() => handleRefreshProfile(record)}
              >
                同步
              </Button>
            ) : (
              <Button size="small" type="primary" onClick={() => openServerAuthorization(record)}>
                授权
              </Button>
            )}
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => handleRemoveProfile(record.id)}
            >
              移除
            </Button>
          </Space>
        );
      }
    }
  ], [activeProfileId, checkingId, profiles]);

  return (
    <PageScaffold ghost
      code="SETUP"
      className="server-setup-page"
      title={setupModalRequired
        ? '连接 AIH Server'
        : hasReadyServer
          ? '选择或添加 Server'
          : '授权或切换 Server'}
      subTitle="使用 Server 网关地址和 Management Key 连接 AIH Server"
      extra={
        <PageHeaderActions
          actions={[
            {
              key: 'add-server',
              label: '添加 Server',
              icon: <PlusOutlined />,
              onClick: openAddServer,
            },
            {
              key: 'enter',
              label: '进入工作台',
              icon: <LoginOutlined />,
              primary: true,
              disabled: !activeProfile || !isControlPlaneProfileReady(activeProfile),
              onClick: () => navigate('/'),
            },
          ]}
        />
      }
    >
      <StatisticCard.Group direction="row" bordered={false} className="hos-kpi-strip">
        <StatisticCard
          statistic={{
            title: '就绪 Server',
            value: readyProfiles.length,
            suffix: '个',
            status: readyProfiles.length > 0 ? 'success' : 'warning',
            valueStyle: { color: readyProfiles.length > 0 ? 'var(--color-success)' : 'var(--color-warning)' }
          }}
        />
        <StatisticCard
          statistic={{
            title: '已保存配置',
            value: profiles.length,
            suffix: '个'
          }}
        />
      </StatisticCard.Group>

      <SectionCard title="已保存 Server">
        <ListTable<ProfileRow>
          rowKey="__key"
          columns={profileColumns}
          dataSource={profileRows}
          loading={false}
        />
        {hasReadyServer && (
          <div className="server-setup-footer">
            <Button type="link" className="server-setup-footer-link" onClick={() => navigate('/fabric/servers')}>
              打开高级 Server 设置
            </Button>
          </div>
        )}
      </SectionCard>

      <Modal
        title={effectiveDialog.mode === 'authorize'
          ? '授权 Server'
          : effectiveDialog.mode === 'add'
            ? '添加 Server'
            : '连接 AIH Server'}
        open={setupModalOpen}
        width={760}
        rootClassName={setupModalRequired ? 'server-setup-boot server-setup-boot--gate' : 'server-setup-boot'}
        footer={null}
        closable={!setupModalRequired}
        maskClosable={!setupModalRequired}
        keyboard={!setupModalRequired}
        destroyOnClose={false}
        forceRender
        onCancel={() => {
          if (!setupModalRequired) setSetupDialog(CLOSED_SERVER_SETUP_DIALOG);
        }}
      >
        {/* HUD 引导代号行：纯展示，内容来自真实的弹窗模式（initial / add / authorize） */}
        <div className="server-setup-boot-code" aria-hidden="true">
          <span className="hud-led hud-led--info" />
          <span>SYS // SETUP</span>
          <span className="server-setup-boot-mode">{effectiveDialog.mode.toUpperCase()}</span>
        </div>
        {effectiveDialog.mode === 'initial' && (
          <Typography.Paragraph type="secondary" className="server-setup-boot-intro hud-prose">
            首次使用需要连接一台 AIH Server。验证 Server 网关地址和 Management Key 后才能进入工作台。
          </Typography.Paragraph>
        )}
        <Form
          form={saveForm}
          className="settings-form"
          layout="vertical"
          onFinish={handleSaveServer}
          initialValues={{
            endpoint: '',
            name: 'AIH Server',
            managementKey: ''
          }}
        >
          <div className="settings-form-panel hud-panel hud-panel--sm">
            <Form.Item
              name="endpoint"
              label="Server 网关地址"
              help="原生客户端要求远程 Server 使用 HTTPS；HTTP 仅允许 127.0.0.1/localhost。其他连接路径会在保存后自动发现。"
              rules={[{ required: true, message: '请输入 Server 网关地址' }]}
            >
              <Input
                disabled={effectiveDialog.mode === 'authorize'}
                placeholder="https://aih.example.com"
              />
            </Form.Item>
            <Form.Item name="name" label="显示名称">
              <Input placeholder="Home Fabric / Company Fabric" />
            </Form.Item>
            <Form.Item
              name="managementKey"
              label="Management Key"
              help="可通过 aih server config --show-secrets 查看。"
              rules={[{ required: true, message: '请输入 Management Key' }]}
            >
              <Input.Password autoComplete="new-password" placeholder="Management Key" />
            </Form.Item>
          </div>
          <Button type="primary" htmlType="submit" icon={<CheckCircleOutlined />} loading={saving}>
            {effectiveDialog.mode === 'authorize'
              ? '授权并连接'
              : effectiveDialog.mode === 'initial'
                ? '连接并进入工作台'
                : '探测并保存'}
          </Button>
        </Form>
      </Modal>
    </PageScaffold>
  );
}
