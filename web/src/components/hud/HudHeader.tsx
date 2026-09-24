import { useEffect, useState } from 'react';
import { useThemeMode } from '@/hooks/use-theme-mode';
import { applyThemeMode } from '@/services/theme-persistence';
import { crossTabSync } from '@/services/cross-tab-session-sync';
import type { HudGatewayState } from './use-hud-telemetry';
import { useHudTelemetry } from './use-hud-telemetry';
import { useMobileMode } from '@/mobile/use-mobile-mode';
import { useHudPreferences } from './use-hud-preferences';
import { formatHudCount, formatHudPercent, formatHudUptime } from './hud-format';
import styles from './hud-header.module.css';

const GATEWAY_LABEL: Record<HudGatewayState, { text: string; tone: 'ok' | 'warn' | 'err' | 'info' }> = {
  connecting: { text: 'SYNCING', tone: 'info' },
  online: { text: 'ONLINE', tone: 'ok' },
  degraded: { text: 'DEGRADED', tone: 'warn' },
  empty: { text: 'NO ACCOUNTS', tone: 'warn' },
  offline: { text: 'OFFLINE', tone: 'err' },
};

/** HUD 品牌区：替代 ProLayout 默认的 logo + 标题。 */
export function HudBrand({ logo }: { logo: string }) {
  return (
    <div className={styles.brand}>
      <span className={styles.brandMark}>
        <img src={logo} alt="" />
      </span>
      <span className={styles.brandText}>
        <span className={styles.brandTitle}>AI_HOME</span>
        <span className={styles.brandTag}>ACCOUNTS · GATEWAY</span>
      </span>
    </div>
  );
}

/**
 * 顶栏遥测条：全部来自 /webui/management/status 的真实字段
 * （网关状态、可调度 / 总账号、冷却账号、成功率、请求总数、调度策略、运行时长）。
 */
export function HudTelemetryBar({ enabled: requested }: { enabled: boolean }) {
  // 手机视口由移动端 HUD 顶栏自己轮询；桌面顶栏被隐藏时不再重复请求
  const mobile = useMobileMode();
  const enabled = requested && !mobile;
  const { state, status, receivedAt } = useHudTelemetry(enabled);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  if (!enabled) return null;

  const gateway = GATEWAY_LABEL[state];
  const uptimeSec = status && receivedAt ? status.uptimeSec + Math.max(0, (now - receivedAt) / 1000) : null;
  const hasRequests = Number(status?.totalRequests || 0) > 0;
  const cooldown = Number(status?.cooldownAccounts || 0);

  return (
    <div className={styles.telemetry} aria-label="网关遥测">
      <div className={styles.cell}>
        <span className="hud-label">GATEWAY</span>
        <span className={`${styles.value} ${styles[`tone_${gateway.tone}`]}`}>
          <span className={`hud-led hud-led--${gateway.tone}${state === 'online' ? ' hud-led--live' : ''}`} />
          {gateway.text}
        </span>
      </div>
      <span className={styles.divider} />
      <div className={styles.cell}>
        <span className="hud-label">ACCOUNTS</span>
        <span className={`${styles.value} ${styles.tone_info}`}>
          {status ? `${formatHudCount(status.activeAccounts)} / ${formatHudCount(status.totalAccounts)}` : '—'}
        </span>
      </div>
      <span className={styles.divider} />
      <div className={`${styles.cell} ${styles.optional}`}>
        <span className="hud-label">COOLDOWN</span>
        <span className={`${styles.value} ${cooldown > 0 ? styles.tone_warn : styles.tone_muted}`}>
          {status ? formatHudCount(cooldown) : '—'}
        </span>
      </div>
      <span className={`${styles.divider} ${styles.optional}`} />
      <div className={styles.cell}>
        <span className="hud-label">SUCCESS</span>
        <span className={`${styles.value} ${hasRequests ? styles.tone_ok : styles.tone_muted}`}>
          {hasRequests ? formatHudPercent(status?.successRate) : '—'}
        </span>
      </div>
      <span className={styles.divider} />
      <div className={`${styles.cell} ${styles.optional}`}>
        <span className="hud-label">REQUESTS</span>
        <span className={styles.value}>{status ? formatHudCount(status.totalRequests) : '—'}</span>
      </div>
      <span className={`${styles.divider} ${styles.optional}`} />
      <div className={`${styles.cell} ${styles.optionalWide}`}>
        <span className="hud-label">STRATEGY</span>
        <span className={`${styles.value} ${styles.tone_warn}`}>{status?.strategy ? status.strategy.toUpperCase() : '—'}</span>
      </div>
      <span className={`${styles.divider} ${styles.optionalWide}`} />
      <div className={styles.cell}>
        <span className="hud-label">UPTIME</span>
        <span className={styles.value}>{uptimeSec === null ? '—' : formatHudUptime(uptimeSec)}</span>
      </div>
    </div>
  );
}

/** HUD 开关组：音效、CRT 扫描线、深色 / 日光主题。 */
export function HudToggles() {
  const [prefs, setPrefs] = useHudPreferences();
  const theme = useThemeMode();

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyThemeMode(next);
    crossTabSync.broadcast('THEME_CHANGED', { theme: next });
  };

  return (
    <div className={styles.toggles}>
      <button
        type="button"
        className={styles.toggle}
        aria-pressed={prefs.sfx}
        title="切换 Web Audio 交互音效"
        onClick={() => setPrefs({ sfx: !prefs.sfx })}
      >
        <span className={styles.toggleKey}>SFX</span>
        <span className={prefs.sfx ? styles.toggleOn : styles.toggleOff}>{prefs.sfx ? 'ON' : 'MUTE'}</span>
      </button>
      <button
        type="button"
        className={styles.toggle}
        aria-pressed={prefs.crt}
        title="切换 CRT 扫描线"
        onClick={() => setPrefs({ crt: !prefs.crt })}
      >
        <span className={styles.toggleKey}>CRT</span>
        <span className={prefs.crt ? styles.toggleOn : styles.toggleOff}>{prefs.crt ? 'ON' : 'OFF'}</span>
      </button>
      <button
        type="button"
        className={styles.toggle}
        title="切换深色 / 日光 HUD"
        onClick={toggleTheme}
      >
        <span className={styles.toggleKey}>MODE</span>
        <span className={styles.toggleOn}>{theme === 'dark' ? 'NIGHT' : 'DAY'}</span>
      </button>
    </div>
  );
}
