import { useEffect } from 'react';
import { resolveWebUiManagementKey } from '@/services/webui-auth-transport';

/** 所有 aih 页面让系统取词让路，包括网页划词已关闭的页面。 */
export function useSystemTranslationFocus() {
  useEffect(() => {
    // 远端浏览器的焦点与服务器桌面无关。此通道固定同源，不能随 active server 代理。
    if (!['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) return;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const localRequest = (path: string, body?: object, signal?: AbortSignal) => fetch(`/v0/webui/translation/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${resolveWebUiManagementKey()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2500)]) : AbortSignal.timeout(2500),
      keepalive: Boolean(body),
    });
    let enabled = false;
    let sequence = 0;
    let revision = 0;
    let focusController: AbortController | null = null;
    const sendFocus = (focused: boolean) => {
      focusController?.abort();
      focusController = new AbortController();
      void localRequest('focus', { id, focused, observedAt: Date.now(), revision: ++revision }, focusController.signal).catch(() => {});
    };
    const report = () => {
      if (!enabled) return;
      // 只发送最新焦点，不积压旧心跳；服务端按 revision 和观察时间拒绝迟到消息。
      sendFocus(document.visibilityState === 'visible' && document.hasFocus());
    };
    const refresh = () => {
      const token = ++sequence;
      void localRequest('system').then((response) => response.json()).then(({ system }) => {
        if (token !== sequence) return;
        enabled = system?.enabled === true;
        report();
      }).catch(() => {});
    };
    const change = () => report();
    const timer = window.setInterval(() => report(), 2000);
    const refreshTimer = window.setInterval(refresh, 10000);
    window.addEventListener('focus', change);
    window.addEventListener('blur', change);
    window.addEventListener('pagehide', change);
    window.addEventListener('aih-system-translation-changed', refresh);
    document.addEventListener('visibilitychange', change);
    refresh();
    return () => {
      sequence++;
      window.clearInterval(timer);
      window.clearInterval(refreshTimer);
      window.removeEventListener('focus', change);
      window.removeEventListener('blur', change);
      window.removeEventListener('pagehide', change);
      window.removeEventListener('aih-system-translation-changed', refresh);
      document.removeEventListener('visibilitychange', change);
      sendFocus(false);
    };
  }, []);
}
