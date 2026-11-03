import { SoundOutlined, AudioMutedOutlined } from '@ant-design/icons';
import { useHudPreferences } from '@/components/hud/use-hud-preferences';
import { useHudTelemetry } from '@/components/hud/use-hud-telemetry';
import type { HudGatewayState } from '@/components/hud/use-hud-telemetry';
import { formatHudCount } from '@/components/hud/hud-format';
import type { MobileRouteEntry } from '../mobile-routes';

const GATEWAY: Record<HudGatewayState, { text: string; tone: 'ok' | 'warn' | 'err' | 'info' }> = {
  connecting: { text: 'SYNC', tone: 'info' },
  online: { text: 'ONLINE', tone: 'ok' },
  degraded: { text: 'DEGRADED', tone: 'warn' },
  empty: { text: 'NO ACCTS', tone: 'warn' },
  offline: { text: 'OFFLINE', tone: 'err' },
};

interface Props {
  entry: MobileRouteEntry | null;
  telemetryEnabled: boolean;
}

/**
 * 移动端 HUD 顶栏：分区代号 + 标题、网关状态灯与可调度账号数（真实 /management/status），
 * 以及 SFX / CRT 两个开关（与桌面顶栏共用 hudPreferences 存储）。每个可点区域 ≥44px。
 */
export default function MobileHudTopBar({ entry, telemetryEnabled }: Props) {
  const { state, status } = useHudTelemetry(telemetryEnabled);
  const [prefs, setPrefs] = useHudPreferences();
  const gateway = GATEWAY[state];

  return (
    <header className="mhud-topbar" aria-label="HUD 顶栏">
      <div className="mhud-topbar__title">
        <span className="mhud-topbar__code">SYS // {entry?.code || 'AI_HOME'}</span>
        <span className="mhud-topbar__name">{entry?.title || 'AI Home'}</span>
      </div>
      {telemetryEnabled && (
        <div className="mhud-topbar__telemetry" aria-label={`网关 ${gateway.text}`}>
          <span className={`hud-led hud-led--${gateway.tone}${state === 'online' ? ' hud-led--live' : ''}`} />
          <span className={`mhud-topbar__gateway mhud-tone--${gateway.tone}`}>{gateway.text}</span>
          <span className="mhud-topbar__accounts">
            {status ? `${formatHudCount(status.activeAccounts)}/${formatHudCount(status.totalAccounts)}` : '—'}
          </span>
        </div>
      )}
      <div className="mhud-topbar__toggles">
        <button
          type="button"
          className="mhud-toggle"
          data-on={prefs.sfx ? 'true' : 'false'}
          aria-pressed={prefs.sfx}
          aria-label={prefs.sfx ? '关闭音效' : '开启音效'}
          onClick={() => setPrefs({ sfx: !prefs.sfx })}
        >
          {prefs.sfx ? <SoundOutlined /> : <AudioMutedOutlined />}
          <span>{prefs.sfx ? 'SFX' : 'MUTE'}</span>
        </button>
        <button
          type="button"
          className="mhud-toggle"
          data-on={prefs.crt ? 'true' : 'false'}
          aria-pressed={prefs.crt}
          aria-label={prefs.crt ? '关闭 CRT 扫描线' : '开启 CRT 扫描线'}
          onClick={() => setPrefs({ crt: !prefs.crt })}
        >
          <span className="mhud-toggle__crt" aria-hidden="true" />
          <span>CRT</span>
        </button>
      </div>
    </header>
  );
}
