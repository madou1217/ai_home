import {
  CloudServerOutlined,
  DesktopOutlined,
  PictureOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  SaveOutlined,
  ToolOutlined,
  UndoOutlined
} from '@ant-design/icons';
import { history } from '@umijs/max';
import { Form, Input, InputNumber, Switch, message } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { saveServerConfig } from '@/features/settings/save-server-config';
import {
  SERVER_FORM_DEFAULTS,
  SERVER_PORT_RULES,
  USAGE_FIELD_RULES,
  USAGE_FORM_DEFAULTS,
  toUsageConfig,
  toUsageFormValues,
  type RestartStateNote,
  type UsageFormValues
} from '@/features/settings/settings-config';
import { useAppearanceSettings } from '@/features/settings/use-appearance-settings';
import { useManagementRestart } from '@/features/settings/use-management-restart';
import { HudCard, HudIconButton, HudSection } from '@/mobile/ui';
import { configAPI } from '@/services/api';
import type { ServerConfig } from '@/types';
import { confirmAction } from '@/utils/confirm-action';
import SettingRow from './SettingRow';
import ServerPickerSheet from './ServerPickerSheet';
import styles from './MobileSettings.module.css';
import {
  SERVER_SWITCH_AVAILABLE,
  getProfileShortName,
  getProfileStateLabel,
  isControlPlaneProfileReady,
  isLocalProfileEndpoint,
  useSettingsServers
} from './use-settings-servers';

const NOTE_CLASS: Record<RestartStateNote['type'], string> = {
  info: styles.noteInfo,
  success: styles.noteSuccess,
  error: styles.noteError
};
const NOTE_LED: Record<RestartStateNote['type'], string> = {
  info: 'hud-led--info',
  success: 'hud-led--ok',
  error: 'hud-led--err'
};

function InlineHudNote({ type, children }: { type: RestartStateNote['type']; children: string }) {
  return (
    <p className={`${styles.note} ${NOTE_CLASS[type]}`} role={type === 'error' ? 'alert' : 'status'}>
      <span className={`hud-led ${NOTE_LED[type]} ${styles.noteLed}`} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/**
 * 基础设置：当前 Server / 开发工具入口 / 外观个性化 / 账号调度 / 服务配置。
 * 与桌面 Settings「基础设置」同一套 API（configAPI.get/update/getServer/updateServer、managementAPI.restart/watch、
 * 密钥轮换）与校验规则（features/settings）。
 */
export default function BasicSettingsPanel() {
  const [usageForm] = Form.useForm<UsageFormValues>();
  const [serverForm] = Form.useForm<ServerConfig>();
  const openNetwork = Boolean(Form.useWatch('openNetwork', serverForm));
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverSaving, setServerSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const servers = useSettingsServers();
  const { restarting, restartNote, restartServer } = useManagementRestart();
  const appearance = useAppearanceSettings();

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const [config, serverConfig] = await Promise.all([
        configAPI.get(),
        configAPI.getServer()
      ]);
      usageForm.setFieldsValue(toUsageFormValues(config));
      serverForm.setFieldsValue(serverConfig);
      setLoadError(false);
    } catch (_error) {
      setLoadError(true);
      message.error('加载配置失败');
    } finally {
      setLoading(false);
    }
  }, [serverForm, usageForm]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleSaveUsage = async () => {
    let values: UsageFormValues;
    try {
      values = await usageForm.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      await configAPI.update(toUsageConfig(values));
      message.success('保存额度配置成功');
    } catch (_error) {
      message.error('保存额度配置失败');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveServer = async () => {
    let values: ServerConfig;
    try {
      values = await serverForm.validateFields();
    } catch {
      return;
    }
    setServerSaving(true);
    try {
      const { saved, rotatedProfileId } = await saveServerConfig(values, servers.activeProfile);
      if (rotatedProfileId) servers.refresh();
      serverForm.setFieldsValue({ ...saved, apiKey: '', managementKey: '' });
      message.success('保存服务配置成功');
    } catch (error: unknown) {
      message.error((error as { message?: string } | null)?.message || '保存服务配置失败');
    } finally {
      setServerSaving(false);
    }
  };

  // 触屏上误触会直接断开当前连接：重启前走 HUD 确认框
  const handleRestart = async () => {
    const ok = await confirmAction({
      title: '一键重启服务',
      content: '监听配置保存后需要重启才会生效；重启期间连接会短暂中断。',
      okText: '重启',
      cancelText: '取消'
    });
    if (ok) await restartServer();
  };

  const current = servers.currentProfile;
  const currentReady = isControlPlaneProfileReady(current);

  return (
    <>
      {SERVER_SWITCH_AVAILABLE ? (
        <HudSection title="AIH Server" code="SERVER">
          <p className={styles.groupDesc}>选择或切换当前连接的 AIH Server。</p>
          {servers.profiles.length === 0 ? (
            <HudCard tone="warn" code="NO SERVER" title="尚未添加 Server">
              <HudIconButton
                icon={<PlusOutlined />}
                label="添加 Server"
                tone="primary"
                showLabel
                onClick={() => history.push('/fabric/servers')}
              />
            </HudCard>
          ) : (
            <HudCard
              code="CURRENT"
              title={getProfileShortName(current)}
              tone={currentReady ? 'ok' : 'warn'}
              onClick={servers.canSwitch ? () => setPickerOpen(true) : () => history.push('/fabric/servers')}
              ariaLabel={servers.canSwitch ? '切换 Server' : '配置服务器'}
              extra={current ? (
                <span className={`mhud-status ${currentReady ? 'mhud-tone--ok' : 'mhud-tone--warn'}`}>
                  <span className={`hud-led ${currentReady ? 'hud-led--ok' : 'hud-led--warn'}`} aria-hidden="true" />
                  {getProfileStateLabel(current)}
                </span>
              ) : null}
            >
              <div className={styles.serverLine}>
                {isLocalProfileEndpoint(current?.endpoint)
                  ? <DesktopOutlined className={styles.serverIcon} />
                  : <CloudServerOutlined className={styles.serverIcon} />}
                <span className={styles.serverEndpoint}>{current?.endpoint || '未连接'}</span>
                <RightOutlined className={styles.chevron} aria-hidden="true" />
              </div>
            </HudCard>
          )}
        </HudSection>
      ) : null}

      <HudSection title="开发工具与应用管理" code="TOOLKIT">
        <p className={styles.groupDesc}>已整合至全新「开发工具 (Toolkit)」页面，统一管理 AI CLI、环境、镜像源与代理。</p>
        <div className={styles.group}>
          <SettingRow
            title="开发工具箱 (Toolkit)"
            subtitle="统一管理 AI CLI、Node 环境、镜像源与代理"
            control={(
              <HudIconButton icon={<ToolOutlined />} label="进入工具箱" tone="primary" showLabel onClick={() => history.push('/toolkit')} />
            )}
          />
        </div>
      </HudSection>

      <HudSection title="外观个性化" code="DISPLAY">
        <p className={styles.groupDesc}>自定义动态壁纸（自动萃取强调色并生成全局光晕背景）与 HUD 显示效果。</p>
        <div className={styles.group}>
          <SettingRow
            title="自定义动态壁纸"
            subtitle={appearance.hasCustomWallpaper ? '已应用自定义壁纸（≤2MB 图片）' : '选择一张图片作为全局背景'}
            control={<HudIconButton icon={<PictureOutlined />} label="选择图片" showLabel onClick={appearance.openWallpaperPicker} />}
          />
          {appearance.hasCustomWallpaper ? (
            <SettingRow
              title="恢复默认背景"
              subtitle="清除自定义壁纸与萃取的强调色"
              danger
              control={<HudIconButton icon={<UndoOutlined />} label="恢复默认" tone="danger" showLabel onClick={appearance.handleWallpaperClear} />}
            />
          ) : null}
          <div className={styles.groupLabel} role="presentation">HUD 显示</div>
          <SettingRow
            title="CRT 扫描线"
            subtitle="在界面上叠加 CRT 扫描线纹理"
            control={(
              <Switch
                checked={appearance.hudPrefs.crt}
                checkedChildren="ON"
                unCheckedChildren="OFF"
                aria-label="CRT 扫描线"
                onChange={(checked) => appearance.setHudPrefs({ crt: checked })}
              />
            )}
          />
          <SettingRow
            title="交互音效 SFX"
            subtitle="点击与切换时播放 Web Audio 提示音"
            control={(
              <Switch
                checked={appearance.hudPrefs.sfx}
                checkedChildren="ON"
                unCheckedChildren="MUTE"
                aria-label="交互音效 SFX"
                onChange={(checked) => appearance.setHudPrefs({ sfx: checked })}
              />
            )}
          />
          <SettingRow
            title="主题"
            subtitle={appearance.themeMode === 'dark' ? '深色 HUD（夜间）' : '日光 HUD（白天）'}
            control={(
              <Switch
                checked={appearance.themeMode === 'dark'}
                checkedChildren="深色"
                unCheckedChildren="日光"
                aria-label="主题 深色/日光"
                onChange={appearance.handleThemeModeChange}
              />
            )}
          />
        </div>
        <input
          ref={appearance.wallpaperFileInputRef}
          type="file"
          accept="image/*"
          className={styles.hiddenInput}
          onChange={appearance.handleWallpaperFileChange}
        />
      </HudSection>

      <HudSection title="账号调度" code="QUOTA">
        <p className={styles.groupDesc}>控制额度阈值和后台刷新节奏。</p>
        <HudCard>
          {loadError ? (
            <div className={styles.errorLine} role="alert">
              <span>加载配置失败</span>
              <HudIconButton icon={<ReloadOutlined />} label="重试" showLabel loading={loading} onClick={loadConfig} />
            </div>
          ) : null}
          <Form
            form={usageForm}
            disabled={loading}
            layout="vertical"
            className={styles.form}
            initialValues={USAGE_FORM_DEFAULTS}
          >
            <Form.Item
              name="threshold_pct"
              label="自动切换阈值 (%)"
              help="当账号剩余额度低于此百分比时，自动切换到下一个可用账号"
              rules={USAGE_FIELD_RULES.threshold_pct}
            >
              <InputNumber min={0} max={100} addonAfter="%" inputMode="numeric" />
            </Form.Item>
            <Form.Item
              name="active_refresh_interval"
              label="活跃刷新间隔 (秒)"
              help="正在使用的账号额度刷新间隔时间"
              rules={USAGE_FIELD_RULES.active_refresh_interval}
            >
              <InputNumber min={10} addonAfter="秒" inputMode="numeric" />
            </Form.Item>
            <Form.Item
              name="background_refresh_interval"
              label="后台刷新间隔 (秒)"
              help="未使用账号的额度刷新间隔时间"
              rules={USAGE_FIELD_RULES.background_refresh_interval}
            >
              <InputNumber min={60} addonAfter="秒" inputMode="numeric" />
            </Form.Item>
          </Form>
          <div className={styles.actions}>
            <HudIconButton icon={<UndoOutlined />} label="重置" showLabel disabled={loading} onClick={loadConfig} />
            <HudIconButton
              icon={<SaveOutlined />}
              label="保存额度设置"
              tone="primary"
              showLabel
              loading={saving}
              disabled={loading}
              onClick={handleSaveUsage}
            />
          </div>
        </HudCard>
      </HudSection>

      <HudSection title="服务配置" code="SERVICE">
        <p className={styles.groupDesc}>管理监听地址、端口和本地接口密钥。</p>
        <HudCard>
          <InlineHudNote type="info">
            开启开放网络后，Server 会监听 0.0.0.0。监听配置保存后，需要点击“一键重启服务”才会生效。
          </InlineHudNote>
          {restartNote ? <InlineHudNote type={restartNote.type}>{restartNote.message}</InlineHudNote> : null}
          <Form
            form={serverForm}
            disabled={loading}
            layout="vertical"
            className={styles.form}
            initialValues={SERVER_FORM_DEFAULTS}
          >
            <div className={styles.inlineSwitch}>
              <span className={styles.rowTitle}>开放网络访问</span>
              <Form.Item name="openNetwork" valuePropName="checked" noStyle>
                <Switch checkedChildren="开放" unCheckedChildren="本机" aria-label="开放网络访问" />
              </Form.Item>
            </div>
            <Form.Item
              name="host"
              label="监听地址"
              help={openNetwork ? '开放网络时会自动使用 0.0.0.0' : '默认仅监听本机 127.0.0.1'}
            >
              <Input disabled={openNetwork} placeholder="127.0.0.1" inputMode="url" autoCapitalize="off" autoCorrect="off" />
            </Form.Item>
            <Form.Item name="port" label="端口" rules={SERVER_PORT_RULES}>
              <InputNumber min={1} max={65535} inputMode="numeric" />
            </Form.Item>
            <Form.Item name="apiKey" label="API Key" help="用于访问 /v1 接口的客户端密钥。留空保留当前配置。">
              <Input.Password autoComplete="new-password" placeholder="例如 sk-local-xxxx" />
            </Form.Item>
            <Form.Item name="managementKey" label="Management Key" help="用于访问 Server 管理接口的客户端密钥。留空保留当前配置。">
              <Input.Password autoComplete="new-password" placeholder="输入新的 Management Key" />
            </Form.Item>
          </Form>
          <div className={styles.actions}>
            <HudIconButton
              icon={<ReloadOutlined />}
              label="一键重启服务"
              showLabel
              loading={restarting}
              disabled={loading}
              onClick={handleRestart}
            />
            <HudIconButton
              icon={<SaveOutlined />}
              label="保存服务配置"
              tone="primary"
              showLabel
              loading={serverSaving}
              disabled={loading}
              onClick={handleSaveServer}
            />
          </div>
        </HudCard>
      </HudSection>

      {SERVER_SWITCH_AVAILABLE ? (
        <ServerPickerSheet
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          profiles={servers.profiles}
          currentProfileId={servers.currentProfileId}
          switchingId={servers.switchingId}
          onSelect={servers.selectCurrent}
        />
      ) : null}
    </>
  );
}
