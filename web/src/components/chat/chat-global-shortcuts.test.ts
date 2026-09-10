import { describe, expect, test } from 'bun:test';
import {
  IN_SESSION_SEARCH_OPEN_EVENT,
  resolveChatGlobalShortcut,
} from './chat-global-shortcuts';

describe('resolveChatGlobalShortcut', () => {
  test('Cmd/Ctrl+K 命中命令面板(与既有内联实现语义一致)', () => {
    expect(resolveChatGlobalShortcut({ key: 'k', metaKey: true, ctrlKey: false })).toBe('command-palette');
    expect(resolveChatGlobalShortcut({ key: 'K', metaKey: false, ctrlKey: true })).toBe('command-palette');
  });

  test('Cmd/Ctrl+/ 命中快捷键手册', () => {
    expect(resolveChatGlobalShortcut({ key: '/', metaKey: true, ctrlKey: false })).toBe('shortcuts-help');
  });

  test('Cmd/Ctrl+F 命中会话内检索(手册早已广告,此处是实现)', () => {
    expect(resolveChatGlobalShortcut({ key: 'f', metaKey: true, ctrlKey: false })).toBe('in-session-search');
    expect(resolveChatGlobalShortcut({ key: 'F', metaKey: false, ctrlKey: true })).toBe('in-session-search');
  });

  test('无修饰键或无关键不命中', () => {
    expect(resolveChatGlobalShortcut({ key: 'k', metaKey: false, ctrlKey: false })).toBeNull();
    expect(resolveChatGlobalShortcut({ key: 't', metaKey: true, ctrlKey: false })).toBeNull();
    expect(resolveChatGlobalShortcut({ key: 'n', metaKey: true, ctrlKey: false })).toBeNull();
    expect(resolveChatGlobalShortcut({ key: 'x', metaKey: true, ctrlKey: false })).toBeNull();
  });

  test('搜索事件名稳定(双 surface 监听器依赖同一常量)', () => {
    expect(IN_SESSION_SEARCH_OPEN_EVENT).toBe('aih:in-session-search-open');
  });
});
