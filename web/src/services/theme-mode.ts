// 主题模式的唯一读取/订阅入口。
// 主题真相存在 document.documentElement 的 data-theme 属性上（写入方见
// GlobalCommandPalette 与 cross-tab-session-sync），CSS 与 antd 都以它为准；
// 这里只负责读与订阅，不写入，避免出现第二个写入方造成两处真相。

export type ThemeMode = 'light' | 'dark';

export const THEME_ATTRIBUTE = 'data-theme';

/** 订阅所需的最小宿主能力，便于在无 DOM 的测试环境注入替身。 */
export interface ThemeModeHost {
  getAttribute(name: string): string | null;
}

function resolveRoot(root?: ThemeModeHost | null): ThemeModeHost | null {
  if (root) return root;
  if (typeof document === 'undefined') return null;
  return document.documentElement;
}

/** 未显式标注时按浅色处理——与 design-tokens.css 裸 :root 的取值一致。 */
export function readThemeMode(root?: ThemeModeHost | null): ThemeMode {
  const host = resolveRoot(root);
  return host?.getAttribute(THEME_ATTRIBUTE) === 'dark' ? 'dark' : 'light';
}

/**
 * 订阅 data-theme 变化。返回取消订阅函数；宿主环境没有 MutationObserver
 * （SSR、node 测试）时退化为空订阅，调用方仍可安全使用快照值。
 */
export function subscribeThemeMode(
  listener: (mode: ThemeMode) => void,
  root?: ThemeModeHost | null,
): () => void {
  const host = resolveRoot(root);
  if (!host || typeof MutationObserver === 'undefined') return () => {};

  let last = readThemeMode(host);
  const observer = new MutationObserver(() => {
    const next = readThemeMode(host);
    // 属性被重复写成同值时不打扰订阅方，避免无谓重渲染。
    if (next === last) return;
    last = next;
    listener(next);
  });
  observer.observe(host as unknown as Node, {
    attributes: true,
    attributeFilter: [THEME_ATTRIBUTE],
  });
  return () => observer.disconnect();
}
