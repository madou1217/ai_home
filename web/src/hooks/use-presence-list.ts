import { useEffect, useMemo, useRef, useState } from 'react';

export interface PresenceEntry<T> {
  item: T;
  leaving: boolean;
}

/**
 * 列表删除项的「离场保留」：items 里消失的项先留在 DOM 里 exitMs，页面给它加 `.aih-leaving`
 * 播一次退出动画，播完再真正移除。删除、移除附件都用它，避免「点一下整行瞬间消失」的硬切。
 *
 * 返回 render 列表：仍在的项用新对象、离场的项按**原来那一轮的顺序**插在原来的位置
 * （否则被删项会先瞬移到队尾再淡出），这一轮新增的项追加在末尾。
 */
export function usePresenceList<T>(items: T[], keyOf: (item: T) => string, exitMs = 170) {
  const [leaving, setLeaving] = useState<T[]>([]);
  const previous = useRef<T[]>(items);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const before = previous.current;
    previous.current = items;
    const live = new Set(items.map(keyOf));
    const removed = before.filter((item) => !live.has(keyOf(item)));
    if (!removed.length) return;
    const removedKeys = new Set(removed.map(keyOf));
    setLeaving((current) => [...current.filter((item) => !removedKeys.has(keyOf(item))), ...removed]);
    const timer = setTimeout(() => {
      timers.current = timers.current.filter((item) => item !== timer);
      setLeaving((current) => current.filter((item) => !removedKeys.has(keyOf(item))));
    }, exitMs);
    timers.current.push(timer);
  }, [items]);

  useEffect(() => () => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  }, []);

  const render = useMemo<PresenceEntry<T>[]>(() => {
    if (!leaving.length) return items.map((item) => ({ item, leaving: false }));
    const leavingKeys = new Set(leaving.map(keyOf));
    const liveByKey = new Map(items.map((item) => [keyOf(item), item]));
    const placed = new Set<string>();
    const out: PresenceEntry<T>[] = [];
    for (const item of previous.current) {
      const key = keyOf(item);
      const live = liveByKey.get(key);
      if (live !== undefined) {
        out.push({ item: live, leaving: false });
        placed.add(key);
      } else if (leavingKeys.has(key)) {
        out.push({ item, leaving: true });
        placed.add(key);
      }
    }
    for (const item of items) {
      const key = keyOf(item);
      if (placed.has(key)) continue;
      out.push({ item, leaving: false });
    }
    return out;
  }, [items, leaving]);

  return { leaving, render };
}
