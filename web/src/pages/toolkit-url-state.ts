// Toolkit 二级菜单的 URL 状态。
//
// 只用一个查询参数 `panel`：面板 id 全局唯一，能反推出所属一级分组。
// 用 replaceState 而不是 pushState，避免切换菜单时污染浏览器返回历史；
// 刷新 / 直接分享链接都能回到同一面板。

export const TOOLKIT_PANEL_QUERY_KEY = 'panel';

/**
 * 已并入其它面板的旧面板 id → 现在的面板 id。
 *
 * 「CLI 自动升级」不再是独立二级面板：它的一份结论直接长在「应用管理」的
 * provider 卡片上（同一份账本、同一个 provider）。旧链接、浏览器书签和别处
 * 引用的 `?panel=cli-upgrade` 必须还能落到应用管理，而不是打开一个空面板。
 */
const RETIRED_PANEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'cli-upgrade': 'apps'
});

/** 把历史面板 id 归一到当前面板 id；未知 id 原样返回。 */
export function resolveToolkitPanelAlias(panel: string): string {
  const key = String(panel || '').trim();
  if (!key) return '';
  return RETIRED_PANEL_ALIASES[key] || key;
}

export function readToolkitPanel(search?: string): string {
  if (typeof window === 'undefined') return '';
  const source = typeof search === 'string' ? search : window.location.search;
  try {
    return new URLSearchParams(source).get(TOOLKIT_PANEL_QUERY_KEY) || '';
  } catch (_error) {
    return '';
  }
}

export function writeToolkitPanel(panel: string): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (panel) {
      url.searchParams.set(TOOLKIT_PANEL_QUERY_KEY, panel);
    } else {
      url.searchParams.delete(TOOLKIT_PANEL_QUERY_KEY);
    }
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`
    );
  } catch (_error) {
    // URL 不可写时保持页面状态可用，不影响菜单切换。
  }
}

export function subscribeToolkitPanel(listener: (panel: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = () => listener(readToolkitPanel());
  window.addEventListener('popstate', handler);
  return () => window.removeEventListener('popstate', handler);
}
