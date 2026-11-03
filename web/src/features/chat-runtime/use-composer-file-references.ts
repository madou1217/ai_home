import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useFileReferenceCandidates, type FileReferenceCandidate } from '@/components/chat/use-file-reference-candidates';

// `@` 文件引用（由 legacy MessageArea 迁入 canonical Composer，行为一致）：
//   - 光标前最近的 `@query`（行首或空白后的 @ 片段）触发项目文件下拉；
//   - 与 slash 命令互斥（输入以 `/` 开头时不弹）；
//   - ↑/↓ 选择、Enter/Tab 插入 `@path `、Esc 关闭；插入后光标停在片段末尾。
export interface ComposerFileReferences {
  readonly open: boolean;
  readonly candidates: FileReferenceCandidate[];
  readonly loading: boolean;
  readonly fetchError: string | null;
  readonly selectedIndex: number;
  readonly setSelectedIndex: (index: number) => void;
  readonly apply: (item: FileReferenceCandidate | null) => void;
  /** 键盘拦截：菜单打开时消费方向键/回车/Tab/Esc，返回 true 表示已处理。 */
  readonly handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

export function useComposerFileReferences(
  input: string,
  setInput: (value: string) => void,
  projectPath: string | undefined,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
): ComposerFileReferences {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const pendingCaretRef = useRef<number | null>(null);
  const match = useMemo(() => {
    if (input.trimStart().startsWith('/')) return null;
    const el = textareaRef.current;
    const caret = el && typeof el.selectionStart === 'number' ? el.selectionStart : input.length;
    const before = input.slice(0, caret);
    const found = before.match(/(?:^|\s)@([^\s@]{0,80})$/);
    if (!found) return null;
    return { query: found[1], start: caret - found[1].length - 1, end: caret };
  }, [input, textareaRef]);
  const open = Boolean(match) && !dismissed && Boolean(projectPath);
  const refs = useFileReferenceCandidates(projectPath, match?.query || '', open);
  useEffect(() => { setDismissed(false); }, [input]);
  useEffect(() => { setSelectedIndex(0); }, [match?.query]);
  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(0, refs.candidates.length - 1)));
  }, [refs.candidates.length]);

  const apply = useCallback((item: FileReferenceCandidate | null): void => {
    if (!item || !match) return;
    const inserted = `@${item.path} `;
    pendingCaretRef.current = match.start + inserted.length;
    setInput(`${input.slice(0, match.start)}${inserted}${input.slice(match.end)}`);
  }, [input, match, setInput]);

  // 受控 value 变更会把光标甩到末尾：插入后恢复到片段末尾。
  useLayoutEffect(() => {
    if (pendingCaretRef.current === null) return;
    const position = pendingCaretRef.current;
    pendingCaretRef.current = null;
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(position, position);
    }
  }, [input, textareaRef]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    const count = refs.candidates.length;
    if (event.key === 'Escape') {
      event.preventDefault();
      setDismissed(true);
      return true;
    }
    if (count === 0) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setSelectedIndex((current) => (current + step + count) % count);
      return true;
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      event.preventDefault();
      apply(refs.candidates[selectedIndex] || null);
      return true;
    }
    return false;
  }, [apply, open, refs.candidates, selectedIndex]);

  return {
    open,
    candidates: refs.candidates,
    loading: refs.loading,
    fetchError: refs.fetchError,
    selectedIndex,
    setSelectedIndex,
    apply,
    handleKeyDown,
  };
}
