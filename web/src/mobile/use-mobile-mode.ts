import { useSyncExternalStore } from 'react';

/**
 * 移动端模式判定：视口宽度 < 768px（与 antd `md` 断点、mobile-shell.css 的 767.98px 一致）。
 * 命中时整站切到独立的移动端 HUD 界面（见 web/MOBILE.md），不再复用桌面布局。
 */
export const MOBILE_HUD_QUERY = '(max-width: 767.98px)';

const getMediaQuery = (): MediaQueryList | null => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(MOBILE_HUD_QUERY);
};

const subscribe = (onChange: () => void) => {
  const mq = getMediaQuery();
  if (!mq) return () => {};
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
};

const getSnapshot = () => Boolean(getMediaQuery()?.matches);

export function useMobileMode(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
