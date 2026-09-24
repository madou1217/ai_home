import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Form, Input } from 'antd';
import {
  CheckCircleOutlined,
  CloudServerOutlined,
  DeleteOutlined,
  KeyOutlined,
  LoginOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
  StarOutlined
} from '@ant-design/icons';
import {
  DetailSheet,
  EmptySignal,
  HudCard,
  HudIconButton,
  HudSection,
  KeyValue,
  MobilePage,
  MobileToolbar,
  MonoList,
  SwipeRow,
  TelemetryGrid,
  TelemetryTile
} from '@/mobile/ui';
import type { SwipeAction } from '@/mobile/ui';
import type { MobilePageProps } from '@/mobile/mobile-routes';
import {
  formatServerSetupProfileDetail,
  getServerSetupProfileStatus,
  useServerSetupProfiles,
  type ServerSetupFormValues
} from '@/components/control-plane/use-server-setup-profiles';
import { isControlPlaneManagementKeyConfigured, isControlPlaneProfileReady } from '@/services/control-plane-profiles';
import { getBrowserControlEndpoint } from '@/services/control-plane-endpoints';
import {
  CLOSED_SERVER_SETUP_DIALOG,
  resolveRequiredServerSetupDialog,
  resolveServerSetupFormDefaults,
  type ServerSetupDialogState
} from '@/services/server-setup-state';
import type { ControlPlaneProfile } from '@/types';
import { confirmAction } from '@/utils/confirm-action';
import logo from '../../../../assets/brand/ai-home-app-icon.png';
import FabricFormItem from './fabric/FabricFormItem';
import fabric from './fabric/fabric.module.css';
import styles from './MobileServerSetup.module.css';

const submitLabel = (mode: ServerSetupDialogState['mode']) => (
  mode === 'authorize' ? '授权并连接' : mode === 'initial' ? '连接并进入工作台' : '探测并保存'
);

/** 连接表单：与桌面首启弹窗同样的 3 个字段、校验与说明。 */
function SetupFields({ mode }: { mode: ServerSetupDialogState['mode'] }) {
  return (
    <>
      <FabricFormItem
        name="endpoint"
        label="Server 网关地址"
        required
        hint="原生客户端要求远程 Server 使用 HTTPS；HTTP 仅允许 127.0.0.1/localhost。其他连接路径会在保存后自动发现。"
        rules={[{ required: true, message: '请输入 Server 网关地址' }]}
      >
        <Input
          disabled={mode === 'authorize'}
          placeholder="https://aih.example.com"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Server 网关地址"
        />
      </FabricFormItem>
      <FabricFormItem name="name" label="显示名称">
        <Input placeholder="Home Fabric / Company Fabric" aria-label="显示名称" />
      </FabricFormItem>
      <FabricFormItem
        name="managementKey"
        label="Management Key"
        required
        hint="可通过 aih server config --show-secrets 查看。"
        rules={[{ required: true, message: '请输入 Management Key' }]}
      >
        <Input.Password autoComplete="new-password" placeholder="Management Key" aria-label="Management Key" />
      </FabricFormItem>
    </>
  );
}

/**
 * /server-setup 移动端：首次连接闸门（无底部导航）。
 * - 需要连接（无 Server / 只有自动生成的当前 Server）：整屏 HUD 引导屏 + 连接表单，提交后进入工作台。
 * - 已有 Server：就绪计数 + 已保存 Server 列表（左滑：设为当前 / 同步或授权 / 移除），添加 / 授权表单在底部抽屉。
 * 数据与操作来自 useServerSetupProfiles（与桌面 FabricServerSetup 共用）。
 */
export default function MobileServerSetup(_props: MobilePageProps) {
  const navigate = useNavigate();
  const [form] = Form.useForm<ServerSetupFormValues>();
  const setup = useServerSetupProfiles();
  const { profiles, activeProfileId, activeProfile, readyProfiles, hasReadyServer, checkingId } = setup;
  const [setupDialog, setSetupDialog] = useState<ServerSetupDialogState>(
    () => resolveRequiredServerSetupDialog(profiles, activeProfileId) || CLOSED_SERVER_SETUP_DIALOG
  );
  const [detailId, setDetailId] = useState('');

  const requiredDialog = resolveRequiredServerSetupDialog(profiles, activeProfileId);
  const effectiveDialog = setupDialog.mode === 'closed' && requiredDialog ? requiredDialog : setupDialog;
  const setupRequired = Boolean(requiredDialog);
  const dialogDefaults = resolveServerSetupFormDefaults({
    dialog: effectiveDialog,
    profiles,
    browserEndpoint: getBrowserControlEndpoint()
  });
  // 默认值变化（共享 Server 列表同步回来 / 切换弹窗模式）时重建表单，与桌面「打开即回填」一致
  const formKey = `${effectiveDialog.mode}:${effectiveDialog.profileId}:${dialogDefaults.endpoint}:${dialogDefaults.name}`;
  const detailProfile = profiles.find((profile) => profile.id === detailId) || null;

  const handleSaveServer = async (values: ServerSetupFormValues) => {
    const completingInitialSetup = !hasReadyServer;
    const saved = await setup.saveServer(effectiveDialog.profileId, values);
    if (!saved) return;
    form.setFieldValue('managementKey', '');
    setSetupDialog(CLOSED_SERVER_SETUP_DIALOG);
    if (completingInitialSetup) navigate('/dashboard', { replace: true });
  };

  const openAddServer = () => setSetupDialog({ mode: 'add', profileId: '' });

  const openServerAuthorization = (profile: ControlPlaneProfile) => {
    setDetailId('');
    setSetupDialog({ mode: 'authorize', profileId: profile.id });
  };

  const handleRemove = async (profile: ControlPlaneProfile) => {
    const confirmed = await confirmAction({
      title: '移除 Server',
      content: `从本机移除「${profile.name || profile.endpoint}」的连接配置？`,
      okText: '移除',
      danger: true
    });
    if (!confirmed) return;
    if (detailId === profile.id) setDetailId('');
    await setup.removeProfile(profile.id);
  };

  const setupForm = (
    <Form
      key={formKey}
      form={form}
      layout="vertical"
      className={fabric.form}
      initialValues={{ ...dialogDefaults, managementKey: '' }}
      clearOnDestroy
      onFinish={handleSaveServer}
    >
      <SetupFields mode={effectiveDialog.mode} />
    </Form>
  );

  if (setupRequired) {
    return (
      <div className={styles.boot}>
        <div className={styles.brand}>
          <span className={styles.brandMark}><img src={logo} alt="" /></span>
          <span className={styles.brandText}>
            <span className={styles.brandTitle}>AI_HOME</span>
            <span className={styles.brandTag}>ACCOUNTS · GATEWAY</span>
          </span>
        </div>
        <div className={styles.bootCode} aria-hidden="true">
          <span className="hud-led hud-led--info" />
          <span>SYS // SETUP</span>
          <span className={styles.bootMode}>{effectiveDialog.mode.toUpperCase()}</span>
        </div>
        {effectiveDialog.mode === 'initial' ? (
          <p className={styles.bootIntro}>
            首次使用需要连接一台 AIH Server。验证 Server 网关地址和 Management Key 后才能进入工作台。
          </p>
        ) : null}
        <HudCard code="LINK" title="Server 凭据">
          {setupForm}
        </HudCard>
        <div className={styles.bootSubmit}>
          <Button
            type="primary"
            block
            size="large"
            icon={<CheckCircleOutlined />}
            loading={setup.saving}
            onClick={() => form.submit()}
          >
            {submitLabel(effectiveDialog.mode)}
          </Button>
        </div>
      </div>
    );
  }

  const rowActions = (profile: ControlPlaneProfile): SwipeAction[] => {
    const active = profile.id === activeProfileId;
    return [
      {
        key: 'select',
        label: '设为当前',
        icon: <StarOutlined />,
        tone: 'primary',
        disabled: active,
        onAction: () => setup.selectProfile(profile.id)
      },
      isControlPlaneManagementKeyConfigured(profile)
        ? {
            key: 'refresh',
            label: '同步',
            icon: <ReloadOutlined />,
            disabled: checkingId === profile.id,
            onAction: () => setup.refreshProfile(profile)
          }
        : { key: 'authorize', label: '授权', icon: <KeyOutlined />, onAction: () => openServerAuthorization(profile) },
      { key: 'remove', label: '移除', icon: <DeleteOutlined />, tone: 'danger', onAction: () => handleRemove(profile) }
    ];
  };

  const canEnter = Boolean(activeProfile && isControlPlaneProfileReady(activeProfile));

  return (
    <MobilePage
      lead="使用 Server 网关地址和 Management Key 连接 AIH Server"
      toolbar={(
        <MobileToolbar>
          <HudIconButton icon={<PlusOutlined />} label="添加 Server" onClick={openAddServer} />
          <HudIconButton
            icon={<LoginOutlined />}
            label="进入工作台"
            tone="primary"
            showLabel
            disabled={!canEnter}
            onClick={() => navigate('/')}
          />
        </MobileToolbar>
      )}
    >
      <TelemetryGrid>
        <TelemetryTile
          label="就绪 Server"
          value={readyProfiles.length}
          unit="个"
          led
          tone={readyProfiles.length > 0 ? 'ok' : 'warn'}
        />
        <TelemetryTile label="已保存配置" value={profiles.length} unit="个" tone="info" />
      </TelemetryGrid>

      <HudSection title="已保存 Server" code="SERVERS" count={profiles.length}>
        {profiles.length === 0 ? (
          <EmptySignal
            title="NO SERVER"
            description="暂无已保存 Server"
            action={<Button type="primary" icon={<PlusOutlined />} onClick={openAddServer}>添加 Server</Button>}
          />
        ) : (
          <MonoList ariaLabel="已保存 Server">
            {profiles.map((profile) => {
              const status = getServerSetupProfileStatus(profile);
              const active = profile.id === activeProfileId;
              return (
                <SwipeRow
                  key={profile.id}
                  actions={rowActions(profile)}
                  onTap={() => setDetailId(profile.id)}
                  ariaLabel={`${profile.name || profile.endpoint}，${status.label}${active ? '，当前' : ''}`}
                >
                  <span className={`mhud-row__icon mhud-tone--${status.tone}`} aria-hidden="true"><CloudServerOutlined /></span>
                  <span className="mhud-row__main">
                    <span className="mhud-row__title">{profile.name || profile.endpoint}</span>
                    <span className="mhud-row__meta">{profile.endpoint}</span>
                    <span className="mhud-row__meta">{formatServerSetupProfileDetail(profile)}</span>
                  </span>
                  <span className="mhud-row__side">
                    <span className={`mhud-status mhud-tone--${status.tone}`}>
                      <span className={`hud-led hud-led--${status.tone === 'muted' ? 'info' : status.tone}`} aria-hidden="true" />
                      {status.label}
                    </span>
                    {active ? <span className={fabric.badge}>当前</span> : null}
                  </span>
                </SwipeRow>
              );
            })}
          </MonoList>
        )}
        {hasReadyServer ? (
          <Button type="link" icon={<SettingOutlined />} className={styles.advanced} onClick={() => navigate('/fabric/servers')}>
            打开高级 Server 设置
          </Button>
        ) : null}
      </HudSection>

      <DetailSheet
        open={Boolean(detailProfile)}
        onClose={() => setDetailId('')}
        code="SERVER"
        title={detailProfile ? detailProfile.name || detailProfile.endpoint : ''}
        footer={detailProfile ? (
          <>
            {isControlPlaneManagementKeyConfigured(detailProfile) ? (
              <Button
                icon={<ReloadOutlined />}
                loading={checkingId === detailProfile.id}
                onClick={() => setup.refreshProfile(detailProfile)}
              >
                同步
              </Button>
            ) : (
              <Button icon={<KeyOutlined />} onClick={() => openServerAuthorization(detailProfile)}>授权</Button>
            )}
            <Button
              type="primary"
              icon={<StarOutlined />}
              disabled={detailProfile.id === activeProfileId}
              onClick={() => setup.selectProfile(detailProfile.id)}
            >
              设为当前
            </Button>
          </>
        ) : null}
      >
        {detailProfile ? (
          <div className={styles.detail}>
            <KeyValue
              rows={[
                {
                  key: 'status',
                  label: '状态',
                  value: getServerSetupProfileStatus(detailProfile).label,
                  tone: getServerSetupProfileStatus(detailProfile).tone
                },
                { key: 'endpoint', label: 'Server 地址', value: detailProfile.endpoint },
                { key: 'summary', label: '摘要', value: formatServerSetupProfileDetail(detailProfile) },
                ...(detailProfile.id === activeProfileId ? [{ key: 'current', label: '当前', value: '是', tone: 'info' as const }] : []),
                ...(detailProfile.lastError
                  ? [{ key: 'error', label: '错误', value: detailProfile.lastError, tone: 'err' as const }]
                  : [])
              ]}
            />
            <Button danger block icon={<DeleteOutlined />} onClick={() => handleRemove(detailProfile)}>
              移除
            </Button>
          </div>
        ) : null}
      </DetailSheet>

      <DetailSheet
        open={effectiveDialog.mode !== 'closed'}
        onClose={() => setSetupDialog(CLOSED_SERVER_SETUP_DIALOG)}
        code={`SYS // SETUP · ${effectiveDialog.mode.toUpperCase()}`}
        title={effectiveDialog.mode === 'authorize'
          ? '授权 Server'
          : effectiveDialog.mode === 'add'
            ? '添加 Server'
            : '连接 AIH Server'}
        maxHeight="92dvh"
        footer={(
          <Button type="primary" icon={<CheckCircleOutlined />} loading={setup.saving} onClick={() => form.submit()}>
            {submitLabel(effectiveDialog.mode)}
          </Button>
        )}
      >
        {effectiveDialog.mode !== 'closed' ? setupForm : null}
      </DetailSheet>
    </MobilePage>
  );
}
