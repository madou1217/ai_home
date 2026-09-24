import { useEffect } from 'react';
import { hudSfx } from '@/services/hud-sfx';
import { useHudPreferences } from './use-hud-preferences';

// 会触发「按键」音效的可交互元素；链接按钮、菜单、Tabs、分段、开关、选择器都在内。
const INTERACTIVE_SELECTOR = [
  'button:not(:disabled)',
  '[role="button"]',
  'a[href]',
  '.ant-menu-item',
  '.ant-menu-submenu-title',
  '.ant-tabs-tab',
  '.ant-segmented-item',
  '.ant-switch',
  '.ant-checkbox-wrapper',
  '.ant-radio-wrapper',
  '.ant-select-selector',
  '.ant-select-item-option',
  '.ant-dropdown-menu-item',
].join(',');

function playForAddedNode(node: Element) {
  if (node.matches('.ant-message-notice') || node.querySelector('.ant-message-notice-content')) {
    if (node.querySelector('.ant-message-error, .ant-message-warning')) hudSfx.warn();
    else if (node.querySelector('.ant-message-success')) hudSfx.success();
    return;
  }
  if (node.matches('.ant-notification-notice') || node.querySelector('.ant-notification-notice')) {
    if (node.querySelector('.ant-notification-notice-icon-error, .ant-notification-notice-icon-warning')) hudSfx.warn();
    else hudSfx.success();
  }
}

/**
 * 全局 HUD 效果：CRT 扫描线覆盖层 + Web Audio 微反馈。
 * 音效通过事件委托与 DOM 观察接入，不改任何业务组件：
 *   - pointerdown 命中可交互元素 → 按键音
 *   - antd message / notification 出现 → 成功音或警告音
 *   - 弹窗 / 抽屉打开 → 开启音
 */
export default function HudEffects() {
  const [prefs] = useHudPreferences();

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(INTERACTIVE_SELECTOR)) hudSfx.click();
    };
    document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });

    const observer = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver((records) => {
        for (const record of records) {
          record.addedNodes.forEach((node) => {
            if (!(node instanceof Element)) return;
            if (node.matches('.ant-modal-root, .ant-drawer') || node.querySelector('.ant-modal-content, .ant-drawer-content')) {
              hudSfx.open();
              return;
            }
            playForAddedNode(node);
          });
        }
      });
    observer?.observe(document.body, { childList: true, subtree: true });

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, { capture: true });
      observer?.disconnect();
    };
  }, []);

  return <div className="hud-crt-overlay" data-enabled={prefs.crt ? 'true' : 'false'} aria-hidden="true" />;
}
