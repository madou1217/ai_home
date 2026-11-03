import { useEffect } from 'react';
import { applyThemeMode } from '@/services/theme-persistence';
import { referenceInChatMiniWindow } from '@/components/chat/chat-global-shortcuts';

// Chat 快捷唤起入口（/chat/quick）：桌面原生小窗（native/chat 的 WKWebView）与「从别处一键打开会话」
// 共用。页面本体就是 Chat 页（同一套 canonical 会话、同一套多视图布局），只由 URL 参数切换：
//   mode=chat|work   打开时的工作区（不写入用户在 Chat 页的模式偏好，避免小窗改掉主窗口习惯）
//   embed=desktop    嵌入原生小窗：隐藏 WebUI 顶栏/侧栏，只留会话区（窗口标题由壳自己画）
//   theme=light|dark 跟随宿主（被动应用，不持久化，不影响用户在 WebUI 里选的主题）
//   引用内容         壳 postMessage({type:'aih-chat-reference', text, source}) 投递，进当前会话输入框附件
// 管理密钥由壳经同源 cookie/localStorage 注入，不出现在 URL 里。

export type QuickChatMode = 'chat' | 'work';

export interface QuickChatLaunch {
  readonly quick: boolean;
  readonly mode?: QuickChatMode;
  readonly embed: '' | 'desktop';
}

const QUICK_PATH = /\/chat\/quick\/?$/;

export function readQuickChatLaunch(location: { pathname: string; search: string } | undefined = typeof window === 'undefined' ? undefined : window.location): QuickChatLaunch {
  if (!location || !QUICK_PATH.test(location.pathname)) return { quick: false, embed: '' };
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode');
  return {
    quick: true,
    ...(mode === 'chat' || mode === 'work' ? { mode } : {}),
    embed: params.get('embed') === 'desktop' ? 'desktop' : '',
  };
}

/** 嵌入模式：给 <html> 打标记，CSS 据此隐藏 ProLayout 外壳（见 styles/quick-chat.css）。 */
export function useQuickChatHost(launch: QuickChatLaunch): void {
  useEffect(() => {
    if (!launch.quick || typeof document === 'undefined') return undefined;
    const root = document.documentElement;
    if (launch.embed) root.setAttribute('data-aih-embed', launch.embed);
    const theme = new URLSearchParams(window.location.search).get('theme');
    if (theme === 'light' || theme === 'dark') applyThemeMode(theme, { persist: false });
    return () => { root.removeAttribute('data-aih-embed'); };
  }, [launch.quick, launch.embed]);

  // 留在快捷窗口：任何站内链接点击 / history 跳转如果要离开 /chat/quick（例如去 /ui/chat 主页面），
  // 改写成 /chat/quick + 同样的查询参数（会话选择参数照常生效）；指向非 chat 页面的站内链接直接拦下。
  // 原生壳只放行 /ui/chat 前缀，/ui/chat 本身也会被放行，所以这一层必须在页面里兜住。
  useEffect(() => {
    if (!launch.quick || typeof window === 'undefined') return undefined;
    const quickPath = window.location.pathname;
    const keep = new URLSearchParams(window.location.search);
    const rewrite = (target: URL): string | null => {
      if (target.origin !== window.location.origin) return null;
      if (target.pathname === quickPath) return null;
      if (!/\/ui\/chat\/?$/.test(target.pathname)) return '';
      ['embed', 'theme', 'mode'].forEach((key) => {
        const value = keep.get(key);
        if (value && !target.searchParams.has(key)) target.searchParams.set(key, value);
      });
      return `${quickPath}?${target.searchParams.toString()}`;
    };
    const onClick = (event: MouseEvent): void => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.target === '_blank') return;
      const next = rewrite(new URL(anchor.href, window.location.href));
      if (next === null) return;
      event.preventDefault();
      if (next) {
        window.history.pushState(null, '', next);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    };
    const patchHistory = (method: 'pushState' | 'replaceState'): (() => void) => {
      const original = window.history[method].bind(window.history);
      window.history[method] = (data: unknown, unused: string, url?: string | URL | null) => {
        if (url !== undefined && url !== null) {
          const next = rewrite(new URL(String(url), window.location.href));
          if (next === '') return;
          if (next) return original(data, unused, next);
        }
        return original(data, unused, url);
      };
      return () => { window.history[method] = original; };
    };
    document.addEventListener('click', onClick, true);
    const restorePush = patchHistory('pushState');
    const restoreReplace = patchHistory('replaceState');
    return () => {
      document.removeEventListener('click', onClick, true);
      restorePush();
      restoreReplace();
    };
  }, [launch.quick]);

  // 宿主投递引用：只接受同源或原生壳（WKWebView 注入的 window.postMessage 来源为 null/同源）。
  useEffect(() => {
    if (!launch.quick || typeof window === 'undefined') return undefined;
    const onMessage = (event: MessageEvent): void => {
      if (event.origin && event.origin !== 'null' && event.origin !== window.location.origin) return;
      const data = event.data as { type?: unknown; text?: unknown; source?: unknown } | null;
      if (!data || data.type !== 'aih-chat-reference') return;
      const text = typeof data.text === 'string' ? data.text : '';
      if (!text.trim()) return;
      referenceInChatMiniWindow({ text, source: typeof data.source === 'string' ? data.source : 'desktop' });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [launch.quick]);
}
