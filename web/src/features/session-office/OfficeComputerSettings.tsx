import { useMemo, type CSSProperties } from 'react';
import {
  ArrowLeftOutlined,
  BgColorsOutlined,
  BulbOutlined,
  CheckOutlined,
  CloseOutlined,
  CodeOutlined,
  ControlOutlined,
  CopyOutlined,
  DeleteOutlined,
  DesktopOutlined,
  MailOutlined,
  MinusOutlined,
  PoweroffOutlined,
  SettingOutlined,
  SplitCellsOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { OfficeComputerPreferences } from './office-computer-state';
import {
  buildOfficeComputerConfigModel,
  OFFICE_DESKTOP_RGB_SWATCHES,
  OFFICE_DESKTOP_WALLPAPERS,
  sanitizeRgbHexColor,
  type OfficeDesktopWallpaperId,
} from './office-computer-config';
import {
  isSessionServerScopeAdmitted,
  OFFICE_DESKTOP_ACTION_SEMANTICS,
  type DesktopActionSemanticItem,
  type SessionDurabilityNote,
} from './office-computer-power';
import type { OfficeProjectRoom, OfficeSessionItem } from './session-office-types';
import './OfficeComputerSettings.css';

export type ComputerSettingsTab = 'settings' | 'config';

export interface OfficeComputerSettingsProps {
  open: boolean;
  activeTab: ComputerSettingsTab;
  onTabChange: (tab: ComputerSettingsTab) => void;
  onCloseWindow: () => void;
  onFocusTerminal?: () => void;
  onFocusMail?: () => void;
  serverId: string;
  session: OfficeSessionItem | null;
  room: OfficeProjectRoom | null;
  preferences: OfficeComputerPreferences;
  loadedWallpaperAssetUrl: string | null;
  terminalReadyObserved?: boolean;
  durabilityNote: SessionDurabilityNote;
  isTerminating: boolean;
  onPowerOffComputer: () => void;
  onBootComputer: () => void;
  onUpdateAppearance: (
    patch: Partial<Pick<OfficeComputerPreferences, 'wallpaper' | 'dualMonitor' | 'rgbEnabled' | 'rgbColor'>>,
  ) => void;
  onCopyIdentity: (session: OfficeSessionItem) => void;
  onReturnToRoom: () => void;
}

function renderActionSemanticIcon(id: DesktopActionSemanticItem['id']) {
  switch (id) {
    case 'minimize':
      return <MinusOutlined aria-hidden="true" />;
    case 'return-room':
      return <ArrowLeftOutlined aria-hidden="true" />;
    case 'virtual-power':
      return <PoweroffOutlined aria-hidden="true" />;
    case 'terminate-session':
      return <DeleteOutlined aria-hidden="true" />;
  }
}

export default function OfficeComputerSettings({
  open,
  activeTab,
  onTabChange,
  onCloseWindow,
  onFocusTerminal,
  onFocusMail,
  serverId,
  session,
  room,
  preferences,
  loadedWallpaperAssetUrl,
  terminalReadyObserved = false,
  durabilityNote,
  isTerminating,
  onPowerOffComputer,
  onBootComputer,
  onUpdateAppearance,
  onCopyIdentity,
  onReturnToRoom,
}: OfficeComputerSettingsProps) {
  const configModel = useMemo(
    () => buildOfficeComputerConfigModel({
      serverId,
      session,
      room,
      preferences,
      loadedWallpaperAssetUrl,
      terminalReadyObserved,
    }),
    [loadedWallpaperAssetUrl, preferences, room, serverId, session, terminalReadyObserved],
  );

  if (!open) return null;

  const canEditPrefs = Boolean(isSessionServerScopeAdmitted(serverId, session) && !isTerminating);
  const isPoweredOn = preferences.power === 'on';
  const sessionTitle = session?.shortLabel || session?.label || '未选定工位';

  const handleSelectWallpaper = (wallpaper: OfficeDesktopWallpaperId) => {
    if (!canEditPrefs) return;
    onUpdateAppearance({ wallpaper });
  };

  return (
    <section
      className="session-desktop-window office-computer-settings-window"
      aria-label={`电脑设置与配置 — ${sessionTitle}`}
    >
      <div className="session-desktop-window-bar">
        <div className="session-desktop-window-title">
          {activeTab === 'settings' ? <SettingOutlined /> : <ControlOutlined />}
          <span className="session-desktop-window-name">
            {activeTab === 'settings' ? '电脑设置' : '电脑配置'} — {sessionTitle}
          </span>
          <span className="office-cs-scope-tag">
            {isPoweredOn ? '电源开启' : '虚拟关机'}
          </span>
        </div>

        <div className="session-desktop-window-controls">
          {onFocusTerminal ? (
            <button
              type="button"
              className="session-desktop-win-btn"
              onClick={onFocusTerminal}
              title="查看会话终端窗口"
              aria-label="查看会话终端窗口"
            >
              <CodeOutlined />
            </button>
          ) : null}
          {onFocusMail ? (
            <button
              type="button"
              className="session-desktop-win-btn"
              onClick={onFocusMail}
              title="查看协作邮箱窗口"
              aria-label="查看协作邮箱窗口"
            >
              <MailOutlined />
            </button>
          ) : null}
          <button
            type="button"
            className="session-desktop-win-btn"
            onClick={onCloseWindow}
            title="收起电脑设置与配置窗口"
            aria-label="关闭电脑设置与配置窗口"
          >
            <CloseOutlined />
          </button>
        </div>
      </div>

      <div className="office-cs-toolbar">
        <div className="office-cs-tabs" role="tablist" aria-label="电脑设置与配置视图切换">
          <button
            type="button"
            role="tab"
            id="office-cs-tab-settings"
            aria-controls="office-cs-panel-settings"
            aria-selected={activeTab === 'settings'}
            className="office-cs-tab"
            data-active={activeTab === 'settings' ? 'true' : undefined}
            onClick={() => onTabChange('settings')}
          >
            <SettingOutlined />
            <span>显示与操作设置</span>
          </button>
          <button
            type="button"
            role="tab"
            id="office-cs-tab-config"
            aria-controls="office-cs-panel-config"
            aria-selected={activeTab === 'config'}
            className="office-cs-tab"
            data-active={activeTab === 'config' ? 'true' : undefined}
            onClick={() => onTabChange('config')}
          >
            <ControlOutlined />
            <span>电脑配置与会话事实</span>
          </button>
        </div>

        {!session ? (
          <span className="office-cs-inline-hint">
            请先选定工位以保存该会话专属设置
          </span>
        ) : null}
      </div>

      <div className="office-cs-body">
        {activeTab === 'settings' ? (
          <div
            id="office-cs-panel-settings"
            role="tabpanel"
            aria-labelledby="office-cs-tab-settings"
            className="office-cs-panel"
          >
            {/* 1. Virtual Power & Lifecycle Distinction */}
            <section className="office-cs-section" aria-label="虚拟电脑电源控制">
              <div className="office-cs-section-head">
                <div className="office-cs-section-heading">
                  <PoweroffOutlined />
                  <h4>虚拟电脑电源</h4>
                  <span className={`office-cs-pill ${isPoweredOn ? 'office-cs-pill--ok' : 'office-cs-pill--muted'}`}>
                    <span className={`hud-led ${isPoweredOn ? 'hud-led--ok hud-led--live' : ''}`} aria-hidden="true" />
                    <span>{isPoweredOn ? '已开机' : '已虚拟关机'}</span>
                  </span>
                  <span className="office-cs-pill">{durabilityNote.badge}</span>
                </div>

                {session ? (
                  isPoweredOn ? (
                    <button
                      type="button"
                      className="session-desktop-btn session-desktop-btn--power-off"
                      disabled={!canEditPrefs}
                      onClick={onPowerOffComputer}
                      title="仅关闭虚拟显示器并断开前端终端附着，不终止后台会话进程"
                    >
                      <PoweroffOutlined />
                      <span>虚拟电脑关机</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="session-desktop-btn session-desktop-btn--power-on"
                      disabled={!canEditPrefs}
                      onClick={onBootComputer}
                      title="点亮虚拟电脑并按原会话标识重新接入后台会话"
                    >
                      <ThunderboltOutlined />
                      <span>开机并恢复原会话</span>
                    </button>
                  )
                ) : null}
              </div>

              <p className="office-cs-caption">{durabilityNote.summary}</p>

              <ul className="office-cs-semantics-grid" aria-label="四种桌面操作语义对照">
                {OFFICE_DESKTOP_ACTION_SEMANTICS.map((item) => (
                  <li
                    key={item.id}
                    className={`office-cs-semantic-item${item.destructive ? ' is-destructive' : ''}`}
                  >
                    <span className="office-cs-semantic-title">
                      {renderActionSemanticIcon(item.id)}
                      <strong>{item.label}</strong>
                    </span>
                    <span className="office-cs-semantic-desc">{item.summary}</span>
                  </li>
                ))}
              </ul>
            </section>

            {/* 2. Single / Dual Monitor Setup */}
            <section className="office-cs-section" aria-label="显示器数量设置">
              <div className="office-cs-section-head">
                <div className="office-cs-section-heading">
                  <DesktopOutlined />
                  <h4>单屏 / 双显示器工作台</h4>
                </div>
                <button
                  type="button"
                  className="session-desktop-btn session-desktop-btn--subtle"
                  disabled={isTerminating}
                  onClick={onReturnToRoom}
                  title="返回 3D 办公室场景以拖拽调节显示器空间位置与偏航角度"
                >
                  <ArrowLeftOutlined />
                  <span>返回房间调节 3D 屏位</span>
                </button>
              </div>

              <div className="office-cs-monitor-choices" role="group" aria-label="显示器布局模式">
                <button
                  type="button"
                  className="office-cs-choice-card"
                  data-selected={!preferences.dualMonitor ? 'true' : undefined}
                  aria-pressed={!preferences.dualMonitor}
                  disabled={!canEditPrefs}
                  onClick={() => onUpdateAppearance({ dualMonitor: false })}
                >
                  <div className="office-cs-choice-top">
                    <span className="office-cs-choice-title">
                      <DesktopOutlined />
                      <span>单显示器标准台</span>
                    </span>
                    {!preferences.dualMonitor ? <CheckOutlined className="office-cs-check" /> : null}
                  </div>
                  <span className="office-cs-choice-desc">
                    主屏 Display 01 独立承载终端或分屏协同，3D 桌面同步为单臂显示器。
                  </span>
                </button>

                <button
                  type="button"
                  className="office-cs-choice-card"
                  data-selected={preferences.dualMonitor ? 'true' : undefined}
                  aria-pressed={preferences.dualMonitor}
                  disabled={!canEditPrefs}
                  onClick={() => onUpdateAppearance({ dualMonitor: true })}
                >
                  <div className="office-cs-choice-top">
                    <span className="office-cs-choice-title">
                      <SplitCellsOutlined />
                      <span>双联屏扩展工作台</span>
                    </span>
                    {preferences.dualMonitor ? <CheckOutlined className="office-cs-check" /> : null}
                  </div>
                  <span className="office-cs-choice-desc">
                    同时展开 Display 01 主屏与 Display 02 扩展副屏，3D 工位同步挂载双显示器。
                  </span>
                </button>
              </div>

              <p className="office-cs-caption">{configModel.scenePoseHint}</p>
            </section>

            {/* 3. Desktop & 3D Monitor Wallpaper */}
            <section className="office-cs-section" aria-label="桌面壁纸选择">
              <div className="office-cs-section-head">
                <div className="office-cs-section-heading">
                  <BgColorsOutlined />
                  <h4>桌面与 3D 屏幕壁纸</h4>
                </div>
                <span className="office-cs-inline-hint">
                  {loadedWallpaperAssetUrl ? '当前：实景 WebP (1376×768)' : '当前：CSS 光影渐变兜底'}
                </span>
              </div>

              <div className="office-cs-wallpaper-grid" role="radiogroup" aria-label="壁纸主题">
                {OFFICE_DESKTOP_WALLPAPERS.map((wp) => {
                  const selected = preferences.wallpaper === wp.id;
                  return (
                    <button
                      key={wp.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={!canEditPrefs}
                      className="office-cs-wallpaper-card"
                      data-selected={selected ? 'true' : undefined}
                      onClick={() => handleSelectWallpaper(wp.id)}
                    >
                      <span
                        className="office-cs-wallpaper-swatch"
                        data-wallpaper={wp.id}
                        aria-hidden="true"
                      />
                      <span className="office-cs-wallpaper-meta">
                        <span className="office-cs-wallpaper-title-row">
                          <strong>{wp.label}</strong>
                          {selected ? <CheckOutlined className="office-cs-check" /> : null}
                        </span>
                        <span className="office-cs-wallpaper-sub">{wp.subtitle}</span>
                        <span className="office-cs-wallpaper-desc">{wp.description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* 4. Chassis RGB Lighting */}
            <section className="office-cs-section" aria-label="机箱灯效设置">
              <div className="office-cs-section-head">
                <div className="office-cs-section-heading">
                  <BulbOutlined />
                  <h4>侧透机箱 RGB 灯效</h4>
                  <span className="office-cs-pill">
                    {preferences.rgbEnabled ? preferences.rgbColor.toUpperCase() : '已关闭'}
                  </span>
                </div>

                <button
                  type="button"
                  className="session-desktop-btn"
                  aria-pressed={preferences.rgbEnabled}
                  disabled={!canEditPrefs}
                  onClick={() => onUpdateAppearance({ rgbEnabled: !preferences.rgbEnabled })}
                >
                  <BulbOutlined />
                  <span>{preferences.rgbEnabled ? '关闭灯效' : '开启灯效'}</span>
                </button>
              </div>

              <div className="office-cs-rgb-row">
                <div className="office-cs-rgb-swatches" role="group" aria-label="预设灯效颜色">
                  {OFFICE_DESKTOP_RGB_SWATCHES.map((swatch) => {
                    const isCurrent = preferences.rgbColor.toLowerCase() === swatch.hex;
                    return (
                      <button
                        key={swatch.hex}
                        type="button"
                        className="office-cs-rgb-swatch"
                        data-selected={isCurrent ? 'true' : undefined}
                        disabled={!canEditPrefs}
                        title={`${swatch.label} (${swatch.hex.toUpperCase()})`}
                        aria-label={`选择灯效颜色 ${swatch.label}`}
                        aria-pressed={isCurrent}
                        style={{ '--cs-swatch-color': swatch.hex } as CSSProperties}
                        onClick={() => onUpdateAppearance({ rgbEnabled: true, rgbColor: swatch.hex })}
                      >
                        <span className="office-cs-rgb-dot" aria-hidden="true" />
                        <span>{swatch.label}</span>
                      </button>
                    );
                  })}
                </div>

                <label className="office-cs-color-picker">
                  <span>自定义色值</span>
                  <input
                    type="color"
                    aria-label="自定义机箱 RGB 灯效颜色"
                    disabled={!canEditPrefs}
                    value={sanitizeRgbHexColor(preferences.rgbColor)}
                    onChange={(event) => {
                      onUpdateAppearance({
                        rgbEnabled: true,
                        rgbColor: sanitizeRgbHexColor(event.target.value, preferences.rgbColor),
                      });
                    }}
                  />
                </label>
              </div>
            </section>
          </div>
        ) : (
          <div
            id="office-cs-panel-config"
            role="tabpanel"
            aria-labelledby="office-cs-tab-config"
            className="office-cs-panel office-cs-config-layout"
          >
            {/* Card 1: Real Available Session Facts */}
            <section className="office-cs-section" aria-label={configModel.realFactsTitle}>
              <div className="office-cs-section-head">
                <div className="office-cs-section-heading">
                  <CodeOutlined />
                  <h4>{configModel.realFactsTitle}</h4>
                  <span className="office-cs-pill office-cs-pill--ok">{configModel.realFactsBadge}</span>
                </div>
                {session ? (
                  <button
                    type="button"
                    className="session-desktop-btn"
                    disabled={isTerminating}
                    onClick={() => onCopyIdentity(session)}
                  >
                    <CopyOutlined />
                    <span>复制原标识</span>
                  </button>
                ) : null}
              </div>

              <p className="office-cs-caption">{configModel.realFactsCaption}</p>

              <dl className="office-cs-kv-list">
                {configModel.realSessionFacts.map((item) => (
                  <div key={item.key} className="office-cs-kv-row">
                    <dt>{item.label}</dt>
                    <dd>{item.mono ? <code>{item.value}</code> : <span>{item.value}</span>}</dd>
                  </div>
                ))}
              </dl>
            </section>

            {/* Card 2: Explicitly Labeled Virtual Modeled Workstation */}
            <section className="office-cs-section" aria-label={configModel.virtualSpecsTitle}>
              <div className="office-cs-section-head">
                <div className="office-cs-section-heading">
                  <DesktopOutlined />
                  <h4>{configModel.virtualSpecsTitle}</h4>
                  <span className="office-cs-pill">{configModel.virtualSpecsBadge}</span>
                </div>
                <button
                  type="button"
                  className="session-desktop-btn session-desktop-btn--subtle"
                  onClick={() => onTabChange('settings')}
                >
                  <SettingOutlined />
                  <span>调整外观设置</span>
                </button>
              </div>

              <p className="office-cs-caption">{configModel.virtualDisclaimer}</p>

              <dl className="office-cs-kv-list">
                {configModel.virtualWorkstationSpecs.map((item) => (
                  <div key={item.key} className="office-cs-kv-row">
                    <dt>{item.label}</dt>
                    <dd>{item.mono ? <code>{item.value}</code> : <span>{item.value}</span>}</dd>
                  </div>
                ))}
              </dl>

              <p className="office-cs-caption">{configModel.scenePoseHint}</p>
            </section>
          </div>
        )}
      </div>
    </section>
  );
}
