import type { ITheme } from '@xterm/xterm';
import { subscribeThemeMode } from '@/services/theme-mode';

/**
 * xterm 画布的 HUD 配色：运行时从 design-tokens.css 的语义变量读取，
 * 深色 HUD = Void Black 底（--color-bg）+ 青色光标（--color-accent）+ 正文色前景（--color-text），
 * 日光 HUD 同理取浅色取值；主题切换时由 subscribeTerminalTheme 推送新配色。
 * canvas 不能解析 var() / color-mix()，因此这里只读 token 的实际颜色值，兜底值取深色 HUD。
 */

/** 终端字体栈：必须以 JetBrains Mono 开头（随包分发的 HUD 数据字体）。 */
export const TERMINAL_FONT_FAMILY = "'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, Consolas, monospace";

function readToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // 只接受 xterm 能解析的颜色写法（#hex / rgb() / rgba()）；其它（如 color-mix）退回兜底值。
  if (/^#[0-9a-f]{3,8}$/i.test(value) || /^rgba?\(/i.test(value)) return value;
  return fallback;
}

/** 给 #rgb / #rrggbb 颜色加透明度，供选区底色使用；非 hex 值原样返回。 */
function withAlpha(color: string, alpha: number): string {
  const hex = color.replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(full)) return color;
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
  return `#${full}${a}`;
}

export function readTerminalTheme(): ITheme {
  const background = readToken('--color-bg', '#05080e');
  const foreground = readToken('--color-text', '#e2f1f8');
  const accent = readToken('--color-accent', '#00f0ff');
  const heading = readToken('--color-heading', '#f2fbff');
  const muted = readToken('--color-muted', '#7f9bb3');
  const faint = readToken('--color-faint', '#5c7890');
  const success = readToken('--color-success', '#00ff66');
  const warning = readToken('--color-warning', '#ffaa00');
  const danger = readToken('--color-danger', '#ff0055');
  const violet = readToken('--event-thinking', '#c38bff');
  return {
    background,
    foreground,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: withAlpha(accent, 0.28),
    // ANSI 16 色映射到 HUD 语义色，深浅主题下都保证可读（xterm 默认的 white / black 在日光底上会消失）。
    black: faint,
    red: danger,
    green: success,
    yellow: warning,
    blue: accent,
    magenta: violet,
    cyan: accent,
    white: foreground,
    brightBlack: muted,
    brightRed: danger,
    brightGreen: success,
    brightYellow: warning,
    brightBlue: accent,
    brightMagenta: violet,
    brightCyan: accent,
    brightWhite: heading
  };
}

/** 主题（html[data-theme]）切换时回调新的终端配色；返回取消订阅函数。 */
export function subscribeTerminalTheme(apply: (theme: ITheme) => void): () => void {
  return subscribeThemeMode(() => apply(readTerminalTheme()));
}
