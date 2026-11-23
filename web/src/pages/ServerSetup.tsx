import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Space, Tag, Typography } from 'antd';
import { StatisticCard } from '@ant-design/pro-components';
import {
  DeleteOutlined,
  LoginOutlined,
  PlusOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import PageHeaderActions from '@/components/ui/PageHeaderActions';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import SettingSection, { SettingRow } from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import ListTable from '@/components/ui/ListTable';
import DistributionUpdatePanel from '@/components/settings/DistributionUpdatePanel';
import ServerConnectionFlow from '@/components/control-plane/ServerConnectionFlow';
import ServerSetupModal from '@/components/control-plane/ServerSetupModal';
import {
  formatServerKeyPersistenceLabel,
  resolveProfileLifecycle
} from '@/components/control-plane/server-list-presentation';
import {
  formatServerSetupProfileDetail as formatProfileDetail,
  useServerSetupProfiles,
  type ServerSetupFormValues as SaveFormValues
} from '@/components/control-plane/use-server-setup-profiles';
import {
  isControlPlaneManagementKeyConfigured,
  isControlPlaneProfileReady
} from '@/services/control-plane-profiles';
import { getBrowserControlEndpoint } from '@/services/control-plane-endpoints';
import {
  CLOSED_SERVER_SETUP_DIALOG,
  resolveAutoAuthorizeDialog,
  resolveRequiredServerSetupDialog,
  resolveServerSetupFormDefaults,
  type ServerSetupDialogState
} from '@/services/server-setup-state';
import type { ControlPlaneProfile } from '@/types';
import '@/components/settings/settings-shared.css';
import '@/components/ui/kpi-strip.css';

type ProfileRow = ControlPlaneProfile & { __key: string };

export default function ServerSetup() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    profiles,
    activeProfileId,
    activeProfile,
    readyProfiles,
    hasReadyServer,
    checkingId,
    saving,
    probing,
    lastProbe,
    lastFeedback,
    bootstrapIssue,
    clearProbeState,
    probeServer,
    saveServer,
    refreshProfile: handleRefreshProfile,
    removeProfile: handleRemoveProfile,
    selectProfile: handleSelectProfile
  } = useServerSetupProfiles();

  const [setupDialog, setSetupDialog] = useState<ServerSetupDialogState>(
    () => resolveRequiredServerSetupDialog(profiles, activeProfileId) || CLOSED_SERVER_SETUP_DIALOG
  );
  const autoAuthorizeOpened = useRef(false);

  useEffect(() => {
    if (autoAuthorizeOpened.current) return;
    const dialog = resolveAutoAuthorizeDialog({
      activeProfile,
      gateRequested: new URLSearchParams(location.search).get('gate') === '1',
      bootstrapIssue
    });
    if (!dialog) return;
    autoAuthorizeOpened.current = true;
    setSetupDialog(dialog);
  }, [activeProfile, bootstrapIssue, location.search]);

  const requiredDialog = resolveRequiredServerSetupDialog(profiles, activeProfileId);
  const effectiveDialog = setupDialog.mode === 'closed' && requiredDialog
    ? requiredDialog
    : setupDialog;
  const setupModalRequired = Boolean(requiredDialog);
  const dialogDefaults = resolveServerSetupFormDefaults({
    dialog: effectiveDialog,
    profiles,
    browserEndpoint: getBrowserControlEndpoint()
  });
  const targetDialogProfile = useMemo(
    () => profiles.find((item) => item.id === effectiveDialog.profileId) || null,
    [effectiveDialog.profileId, profiles]
  );

  const handleSaveServer = async (values: SaveFormValues) => {
    const completingInitialSetup = !hasReadyServer;
    const saved = await saveServer(effectiveDialog.profileId, values);
    if (!saved) return;
    setSetupDialog(CLOSED_SERVER_SETUP_DIALOG);
    if (completingInitialSetup) navigate('/dashboard', { replace: true });
  };

  const handleProbeServer = useCallback(
    (values: SaveFormValues) => probeServer(effectiveDialog.profileId, values),
    [effectiveDialog.profileId, probeServer]
  );

  const openAddServer = () => {
    setSetupDialog({ mode: 'add', profileId: '' });
  };

  const openServerAuthorization = useCallback((profile: ControlPlaneProfile) => {
    setSetupDialog({ mode: 'authorize', profileId: profile.id });
  }, []);

  const activeLifecycle = resolveProfileLifecycle(activeProfile, {
    active: Boolean(activeProfile),
    probing: Boolean(activeProfile && checkingId === activeProfile.id)
  });

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
        <Space direction="vertical" size={2} className="server-setup-cell">
          <strong className="server-setup-name">
            {record.name || record.endpoint}
          </strong>
          <Typography.Text type="secondary" className="server-setup-endpoint">{record.endpoint}</Typography.Text>
          {record.lastError ? (
            <Typography.Text type="danger" className="server-setup-error">{record.lastError}</Typography.Text>
          ) : null}
        </Space>
      )
    },
    {
      title: '生效状态 / 摘要',
      width: 340,
      render: (_, record) => {
        const active = record.id === activeProfileId;
        const lifecycle = resolveProfileLifecycle(record, {
          active,
          probing: checkingId === record.id
        });
        return (
          <Space wrap size={[6, 6]}>
            <SettingStatusTag
              status={lifecycle.tagStatus}
              label={lifecycle.label}
              detail={record.lastError || undefined}
              compact
            />
            <Tag className="server-setup-detail-tag">
              {isControlPlaneManagementKeyConfigured(record) ? 'Key 已保存' : '未配置 Key'}
            </Tag>
            <Tag className="server-setup-detail-tag">{formatProfileDetail(record)}</Tag>
          </Space>
        );
      }
    },
    {
      title: '操作',
      width: 220,
      render: (_, record) => {
        const active = record.id === activeProfileId;
        return (
          <Space size={6} wrap>
            <Button size="small" disabled={active} onClick={() => handleSelectProfile(record.id)}>
              {active ? '当前生效' : '设为当前'}
            </Button>
            {isControlPlaneManagementKeyConfigured(record) ? (
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={checkingId === record.id}
                onClick={() => handleRefreshProfile(record)}
              >
                探测同步
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
  ], [activeProfileId, checkingId, handleRefreshProfile, handleRemoveProfile, handleSelectProfile, openServerAuthorization]);

  return (
    <PageScaffold
      ghost
      code="SETUP"
      className="server-setup-page"
      title={setupModalRequired
        ? '连接 AIH Server'
        : hasReadyServer
          ? 'Server 连接与切换'
          : '授权或切换 Server'}
      subTitle="按 连接 → 探测 → 保存 → 当前生效 完成 Server 配置。"
      extra={
        <PageHeaderActions
          actions={[
            {
              key: 'add-server',
              label: '添加 Server',
              icon: <PlusOutlined />,
              onClick: openAddServer
            },
            {
              key: 'enter',
              label: '进入工作台',
              icon: <LoginOutlined />,
              primary: true,
              disabled: !activeProfile || !isControlPlaneProfileReady(activeProfile),
              onClick: () => navigate('/')
            }
          ]}
        />
      }
    >
      <SettingSection
        title="当前连接状态"
        description="明确区分已保存配置与当前生效实例；切换后立即作用于后续请求。"
        status={
          <SettingStatusTag
            status={activeLifecycle.tagStatus}
            label={activeLifecycle.label}
            detail={activeProfile?.lastError || undefined}
            compact
          />
        }
      >
        <div style={{ paddingTop: 'var(--space-4)' }}>
          <ServerConnectionFlow
            lifecycle={activeLifecycle.state}
            detail={activeProfile?.lastError || lastFeedback?.text}
          />
        </div>
        <SettingRow
          title="已持久化连接"
          description={activeProfile?.lastError ? `最近失败：${activeProfile.lastError}` : '当前默认实例的已保存地址与凭据状态。'}
          persistedValue={
            activeProfile
              ? `${activeProfile.endpoint} · ${formatServerKeyPersistenceLabel(activeProfile)}`
              : '未保存 Server 地址与凭据'
          }
          control={
            <Space size={6} wrap>
              {activeProfile ? (
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  loading={checkingId === activeProfile.id}
                  onClick={() => void handleRefreshProfile(activeProfile)}
                >
                  重新探测
                </Button>
              ) : null}
              <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openAddServer}>
                连接新 Server
              </Button>
            </Space>
          }
        />
      </SettingSection>

      <StatisticCard.Group direction="row" bordered={false} className="hos-kpi-strip">
        <StatisticCard
          statistic={{
            title: '可用 Server',
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

      <SettingSection
        title="已保存 Server"
        description="点击「设为当前」将已保存配置切换为当前生效目标。"
        extra={
          hasReadyServer ? (
            <Button type="link" className="server-setup-footer-link" onClick={() => navigate('/servers')}>
              打开高级 Server 设置
            </Button>
          ) : null
        }
      >
        <ListTable<ProfileRow>
          rowKey="__key"
          columns={profileColumns}
          dataSource={profileRows}
          loading={false}
        />
      </SettingSection>

      {hasReadyServer ? <DistributionUpdatePanel /> : null}

      <ServerSetupModal
        dialog={effectiveDialog}
        required={setupModalRequired}
        defaults={dialogDefaults}
        targetProfile={targetDialogProfile}
        activeProfileId={activeProfileId}
        bootstrapIssue={bootstrapIssue}
        probing={probing}
        saving={saving}
        lastProbe={lastProbe}
        lastFeedback={lastFeedback}
        onCancel={() => setSetupDialog(CLOSED_SERVER_SETUP_DIALOG)}
        onProbe={handleProbeServer}
        onSave={handleSaveServer}
        onResetProbe={clearProbeState}
      />
    </PageScaffold>
  );
}
