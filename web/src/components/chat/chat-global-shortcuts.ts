/**
 * Chat 页全局快捷键的单一事实源。
 *
 * 纪律:快捷键手册(KeyboardShortcutsModal)里广告的每一个键,都必须能在这里
 * 找到对应实现——2026-09-11 F20 行为验收发现手册广告了 Cmd+T/Cmd+N/Cmd+F
 * 三个全无实现的键。其中 Cmd+T(新标签)/Cmd+N(新窗口)是浏览器保留键,
 * 页面收不到也无法 preventDefault,这类键禁止写入手册,只能移除广告。
 */
export const IN_SESSION_SEARCH_OPEN_EVENT = 'aih:in-session-search-open';
export const CHAT_MINI_WINDOW_OPEN_EVENT = 'aih:chat-mini-window-open';
/**
 * 「万物皆可引用」的统一入口：任何页面把选中文字 / 文件交给 Chat 快速窗口。
 * detail = { text?: string; files?: File[]; source?: string }。文字一律作为附件进入
 * （与大段粘贴同一条附件路径），不直接塞进输入框。
 */
export const CHAT_MINI_WINDOW_REFERENCE_EVENT = 'aih:chat-mini-window-reference';

export interface ChatReferenceDetail {
  readonly text?: string;
  readonly files?: readonly File[];
  readonly source?: string;
}

// 快速窗口的 Composer 只在窗口打开、会话就绪后才挂载；在那之前到达的引用先排队，
// 挂载时一次取走。有上限，避免没人消费时无界增长。
const pendingReferences: ChatReferenceDetail[] = [];
const MAX_PENDING_REFERENCES = 8;

export function referenceInChatMiniWindow(detail: ChatReferenceDetail): void {
  if (typeof window === 'undefined') return;
  pendingReferences.push(detail);
  if (pendingReferences.length > MAX_PENDING_REFERENCES) pendingReferences.shift();
  window.dispatchEvent(new CustomEvent<ChatReferenceDetail>(CHAT_MINI_WINDOW_REFERENCE_EVENT, { detail }));
}

export function takePendingChatReferences(): ChatReferenceDetail[] {
  return pendingReferences.splice(0, pendingReferences.length);
}

export type ChatGlobalShortcut = 'command-palette' | 'shortcuts-help' | 'in-session-search' | 'chat-mini-window';

export interface ShortcutKeyEventLike {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey?: boolean;
}

/**
 * 把一次 keydown 解析为 Chat 页全局快捷键;不命中返回 null。
 * 行为与 2026-09 前的内联实现保持一致:Cmd/Ctrl+K 命令面板、Cmd/Ctrl+/ 手册;
 * 新增 Cmd/Ctrl+F 会话内检索(手册早已广告,此处补上实现)，
 * Cmd/Ctrl+Alt+C 在任意 WebUI 页面打开 Chat 快速窗口。
 */
export function resolveChatGlobalShortcut(event: ShortcutKeyEventLike): ChatGlobalShortcut | null {
  if (!event.metaKey && !event.ctrlKey) return null;
  if (event.key.toLowerCase() === 'c' && event.altKey === true) return 'chat-mini-window';
  if (event.key.toLowerCase() === 'k') return 'command-palette';
  if (event.key === '/') return 'shortcuts-help';
  if (event.key.toLowerCase() === 'f') return 'in-session-search';
  return null;
}
