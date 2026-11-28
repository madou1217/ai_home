import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  ArrowLeftOutlined,
  BgColorsOutlined,
  BulbOutlined,
  CheckOutlined,
  CloseOutlined,
  CodeOutlined,
  DeleteOutlined,
  MinusOutlined,
  PoweroffOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import InlineNote from '@/components/ui/InlineNote';
import SaveActionBar from '@/components/ui/SaveActionBar';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import type { OfficeComputerPreferences } from './office-computer-state';
import {
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
import type { OfficeSessionItem } from './session-office-types';
import './OfficeComputerSettings.css';

type AppearancePatch = Pick<
  OfficeComputerPreferences,
  'wallpaper' | 'rgbEnabled' | 'rgbColor'
>;

export interface OfficeComputerSettingsProps {
  open: boolean;
  onCloseWindow: () => void;
  onFocusTerminal?: () => void;
  serverId: string;
  session: OfficeSessionItem | null;
  preferences: OfficeComputerPreferences;
  loadedWallpaperAssetUrl: string | null;
  durabilityNote: SessionDurabilityNote;
  isTerminating: boolean;
  onPowerOffComputer: () => void;
  onBootComputer: () => void;
  onUpdateAppearance: (patch: Partial<AppearancePatch>) => void;
}

function pickAppearance(preferences: OfficeComputerPreferences): AppearancePatch {
  return {
    wallpaper: preferences.wallpaper,
    rgbEnabled: preferences.rgbEnabled,
    rgbColor: sanitizeRgbHexColor(preferences.rgbColor),
  };
}

function appearanceEqual(a: AppearancePatch, b: AppearancePatch): boolean {
  return (
    a.wallpaper === b.wallpaper &&
    a.rgbEnabled === b.rgbEnabled &&
    a.rgbColor.toLowerCase() === b.rgbColor.toLowerCase()
  );
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

interface PowerSectionProps {
  session: OfficeSessionItem | null;
  isPoweredOn: boolean;
  canEditPrefs: boolean;
  durabilityNote: SessionDurabilityNote;
  onPowerOffComputer: () => void;
  onBootComputer: () => void;
}

function OfficePowerSection({
  session,
  isPoweredOn,
  canEditPrefs,
  durabilityNote,
  onPowerOffComputer,
  onBootComputer,
}: PowerSectionProps) {
  return (
    <section className="office-cs-section" aria-label="虚拟电脑电源控制">
      <div className="office-cs-section-head">
        <div className="office-cs-section-heading">
          <PoweroffOutlined />
          <h4>虚拟电源</h4>
          <SettingStatusTag
            status={isPoweredOn ? 'applied' : 'unset'}
            label={isPoweredOn ? '已开机' : '虚拟关机'}
            compact
          />
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
              <span>虚拟关机</span>
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
              <span>开机恢复</span>
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
  );
}

interface AppearanceSectionProps {
  draft: AppearancePatch;
  canEditPrefs: boolean;
  loadedWallpaperAssetUrl: string | null;
  onPatchDraft: (patch: Partial<AppearancePatch>) => void;
}

function OfficeAppearanceSections({
  draft,
  canEditPrefs,
  loadedWallpaperAssetUrl,
  onPatchDraft,
}: AppearanceSectionProps) {
  const handleSelectWallpaper = (wallpaper: OfficeDesktopWallpaperId) => {
    if (!canEditPrefs) return;
    onPatchDraft({ wallpaper });
  };

  return (
    <>
      <section className="office-cs-section" aria-label="桌面壁纸选择">
        <div className="office-cs-section-head">
          <div className="office-cs-section-heading">
            <BgColorsOutlined />
            <h4>屏幕壁纸</h4>
          </div>
          <span className="office-cs-inline-hint">
            {loadedWallpaperAssetUrl ? '实景 WebP' : 'CSS 光影兜底'}
          </span>
        </div>

        <div className="office-cs-wallpaper-grid" role="radiogroup" aria-label="壁纸主题">
          {OFFICE_DESKTOP_WALLPAPERS.map((wp) => {
            const selected = draft.wallpaper === wp.id;
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

      <section className="office-cs-section" aria-label="机箱灯效设置">
        <div className="office-cs-section-head">
          <div className="office-cs-section-heading">
            <BulbOutlined />
            <h4>机箱 RGB 灯效</h4>
            <SettingStatusTag
              status={draft.rgbEnabled ? 'applied' : 'unset'}
              label={draft.rgbEnabled ? `已开启 · ${draft.rgbColor.toUpperCase()}` : '已关闭'}
              compact
            />
          </div>

          <button
            type="button"
            className="session-desktop-btn"
            aria-pressed={draft.rgbEnabled}
            disabled={!canEditPrefs}
            onClick={() => onPatchDraft({ rgbEnabled: !draft.rgbEnabled })}
          >
            <BulbOutlined />
            <span>{draft.rgbEnabled ? '关闭灯效' : '开启灯效'}</span>
          </button>
        </div>

        <div className="office-cs-rgb-row">
          <div className="office-cs-rgb-swatches" role="group" aria-label="预设灯效颜色">
            {OFFICE_DESKTOP_RGB_SWATCHES.map((swatch) => {
              const isCurrent = draft.rgbEnabled && draft.rgbColor.toLowerCase() === swatch.hex;
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
                  onClick={() => onPatchDraft({ rgbEnabled: true, rgbColor: swatch.hex })}
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
              value={sanitizeRgbHexColor(draft.rgbColor)}
              onChange={(event) => {
                onPatchDraft({
                  rgbEnabled: true,
                  rgbColor: sanitizeRgbHexColor(event.target.value, draft.rgbColor),
                });
              }}
            />
          </label>
        </div>
      </section>
    </>
  );
}

export default function OfficeComputerSettings({
  open,
  onCloseWindow,
  onFocusTerminal,
  serverId,
  session,
  preferences,
  loadedWallpaperAssetUrl,
  durabilityNote,
  isTerminating,
  onPowerOffComputer,
  onBootComputer,
  onUpdateAppearance,
}: OfficeComputerSettingsProps) {
  const committedAppearance = useMemo(
    () => pickAppearance(preferences),
    [preferences.rgbColor, preferences.rgbEnabled, preferences.wallpaper],
  );
  const [draftAppearance, setDraftAppearance] = useState<AppearancePatch>(committedAppearance);
  const [saveFeedback, setSaveFeedback] = useState('');

  // Sync draft when switching session/server or receiving external preference changes.
  useEffect(() => {
    setDraftAppearance(committedAppearance);
    setSaveFeedback('');
  }, [committedAppearance, serverId, session?.id]);

  if (!open) return null;

  const canEditPrefs = Boolean(isSessionServerScopeAdmitted(serverId, session) && !isTerminating);
  const isPoweredOn = preferences.power === 'on';
  const sessionTitle = session?.shortLabel || session?.label || '未选定工位';
  const appearanceDirty = !appearanceEqual(draftAppearance, committedAppearance);

  const handlePatchDraft = (patch: Partial<AppearancePatch>) => {
    if (!canEditPrefs) return;
    setDraftAppearance((current) => ({ ...current, ...patch }));
    if (saveFeedback) setSaveFeedback('');
  };

  const handleApplyAppearance = () => {
    if (!canEditPrefs || !appearanceDirty) return;
    onUpdateAppearance(draftAppearance);
    setSaveFeedback('外观设置已应用并保存到当前工位');
  };

  const handleDiscardAppearance = () => {
    setDraftAppearance(committedAppearance);
    setSaveFeedback('已放弃未保存的外观修改');
  };

  return (
    <section
      className="session-desktop-window office-computer-settings-window"
      aria-label={`电脑设置 — ${sessionTitle}`}
    >
      <div className="session-desktop-window-bar">
        <div className="session-desktop-window-title">
          <SettingOutlined />
          <span className="session-desktop-window-name">电脑设置 — {sessionTitle}</span>
          <SettingStatusTag
            status={isPoweredOn ? 'applied' : 'unset'}
            label={isPoweredOn ? '已开机' : '虚拟关机'}
            compact
          />
          {appearanceDirty ? (
            <SettingStatusTag status="dirty" label="未保存" compact />
          ) : null}
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
          <button
            type="button"
            className="session-desktop-win-btn"
            onClick={onCloseWindow}
            title="收起电脑设置窗口"
            aria-label="关闭电脑设置窗口"
          >
            <CloseOutlined />
          </button>
        </div>
      </div>

      <div className="office-cs-body">
        {!canEditPrefs ? (
          <div className="office-cs-notice">
            <InlineNote tone="info">
              {!session
                ? '请先选定工位，再保存该会话专属的显示与外观设置。'
                : isTerminating
                  ? '当前会话正在终止，外观与电源操作已锁定。'
                  : '当前工位所属 Server 与视图作用域不一致，配置为只读。'}
            </InlineNote>
          </div>
        ) : null}

        <div
          id="office-cs-panel-settings"
          role="tabpanel"
          className="office-cs-panel"
        >
          <OfficePowerSection
            session={session}
            isPoweredOn={isPoweredOn}
            canEditPrefs={canEditPrefs}
            durabilityNote={durabilityNote}
            onPowerOffComputer={onPowerOffComputer}
            onBootComputer={onBootComputer}
          />

          <OfficeAppearanceSections
            draft={draftAppearance}
            canEditPrefs={canEditPrefs}
            loadedWallpaperAssetUrl={loadedWallpaperAssetUrl}
            onPatchDraft={handlePatchDraft}
          />
        </div>
      </div>

      <footer className="office-cs-footer">
          <SaveActionBar
            dirty={appearanceDirty}
            disabled={!canEditPrefs}
            onSave={handleApplyAppearance}
            onReset={handleDiscardAppearance}
            saveLabel="应用更改"
            cleanSaveLabel="已应用"
            effectSummary="仅作用于当前工位外观（布局、壁纸、灯效），应用后同步到 3D 场景"
            feedback={saveFeedback || undefined}
            feedbackTone={saveFeedback.includes('已应用') ? 'success' : 'muted'}
          />
      </footer>
    </section>
  );
}
