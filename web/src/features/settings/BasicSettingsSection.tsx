import { Switch } from 'antd';
import SettingSection, { SettingRow } from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import ControlPlaneProfileSelect from '@/components/control-plane/ControlPlaneProfileSelect';
import LargePasteSettingCard from '@/features/chat-runtime/LargePasteSettingCard';
import { useAppearanceSettings } from './use-appearance-settings';

/**
 * 「基础设置」区块：当前 Server 选择、会话大段粘贴阈值与本机 HUD 外观开关。
 * 外观开关均为即时持久化（localStorage），显式展示“已应用”而非待保存状态。
 */
export default function BasicSettingsSection() {
  const {
    hudPrefs,
    setHudPrefs,
    themeMode,
    handleThemeModeChange
  } = useAppearanceSettings();

  return (
    <div className="settings-grid">
      <SettingSection
        title="当前 Server"
        description="切换当前标签页与默认操作的 AIH Server。"
        status={<SettingStatusTag status="applied" label="即时切换" compact />}
      >
        <SettingRow
          title="连接实例"
          description="选择后立即切换后续操作目标。"
          layout="stacked"
          control={
            <div className="settings-server-select-row">
              <ControlPlaneProfileSelect className="settings-server-select-trigger" />
            </div>
          }
        />
      </SettingSection>

      <LargePasteSettingCard />

      <SettingSection
        title="外观与反馈"
        description="本机浏览器的 HUD 视觉效果与主题，切换后立即生效。"
        status={<SettingStatusTag status="applied" label="实时生效" compact />}
      >
        <SettingRow
          title="CRT 扫描线"
          description="在界面表层叠加扫描线纹理。"
          status={<SettingStatusTag status={hudPrefs.crt ? 'applied' : 'unset'} label={hudPrefs.crt ? '已开启' : '已关闭'} compact />}
          control={
            <Switch
              size="small"
              checked={hudPrefs.crt}
              checkedChildren="开"
              unCheckedChildren="关"
              aria-label="CRT 扫描线"
              onChange={(checked) => setHudPrefs({ crt: checked })}
            />
          }
        />
        <SettingRow
          title="交互音效"
          description="点击控件与收到提示时播放轻微提示音。"
          status={<SettingStatusTag status={hudPrefs.sfx ? 'applied' : 'unset'} label={hudPrefs.sfx ? '已开启' : '已静音'} compact />}
          control={
            <Switch
              size="small"
              checked={hudPrefs.sfx}
              checkedChildren="开"
              unCheckedChildren="静音"
              aria-label="交互音效"
              onChange={(checked) => setHudPrefs({ sfx: checked })}
            />
          }
        />
        <SettingRow
          title="界面主题"
          description="切换深色 HUD 与日光 HUD 配色。"
          status={<SettingStatusTag status="applied" label={themeMode === 'dark' ? '深色 HUD' : '日光 HUD'} compact />}
          control={
            <Switch
              size="small"
              checked={themeMode === 'dark'}
              checkedChildren="深色"
              unCheckedChildren="日光"
              aria-label="界面主题 深色/日光"
              onChange={handleThemeModeChange}
            />
          }
        />
      </SettingSection>
    </div>
  );
}
