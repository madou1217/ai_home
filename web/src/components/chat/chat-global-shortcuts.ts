/**
 * Chat 页全局快捷键的单一事实源。
 *
 * 纪律:快捷键手册(KeyboardShortcutsModal)里广告的每一个键,都必须能在这里
 * 找到对应实现——2026-09-11 F20 行为验收发现手册广告了 Cmd+T/Cmd+N/Cmd+F
 * 三个全无实现的键。其中 Cmd+T(新标签)/Cmd+N(新窗口)是浏览器保留键,
 * 页面收不到也无法 preventDefault,这类键禁止写入手册,只能移除广告。
 */
export const IN_SESSION_SEARCH_OPEN_EVENT = 'aih:in-session-search-open';

export type ChatGlobalShortcut = 'command-palette' | 'shortcuts-help' | 'in-session-search';

export interface ShortcutKeyEventLike {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

/**
 * 把一次 keydown 解析为 Chat 页全局快捷键;不命中返回 null。
 * 行为与 2026-09 前的内联实现保持一致:Cmd/Ctrl+K 命令面板、Cmd/Ctrl+/ 手册;
 * 新增 Cmd/Ctrl+F 会话内检索(手册早已广告,此处补上实现)。
 */
export function resolveChatGlobalShortcut(event: ShortcutKeyEventLike): ChatGlobalShortcut | null {
  if (!event.metaKey && !event.ctrlKey) return null;
  if (event.key.toLowerCase() === 'k') return 'command-palette';
  if (event.key === '/') return 'shortcuts-help';
  if (event.key.toLowerCase() === 'f') return 'in-session-search';
  return null;
}
