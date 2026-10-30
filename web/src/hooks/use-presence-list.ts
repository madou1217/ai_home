import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface PresenceEntry<T> {
  item: T;
  leaving: boolean;
}

/**
 * 列表删除项的「离场保留」：items 里消失的项先留在 DOM 里 exitMs，页面给它加 `.aih-leaving`
 * 播一次退出动画，播完再真正移除。删除、移除附件都用它，避免「点一下整行瞬间消失」的硬切。
 *
 * 返回的 render 列表：仍在的项用新对象、离场的项按**原来那一轮的顺序**留在原位
 * （否则被删项会先瞬移到队尾再淡出），这一轮新增的项追加在末尾。
 *
 * 实现要点：
 * - 渲染顺序存在自己的 state 里。此前只在 ref 里记「上一轮 items」，effect 跑完 ref 已指向
 *   新一轮，离场项两处都找不到 → 离场从来没被渲染出来过（节点仍瞬间消失）。
 * - 用 layout effect 同步合并：新增项与离场标记在同一帧上屏，不会晚一帧闪现。
 * - 每个离场 key 记自己的截止时间，只挂一个「最早截止」的定时器。调用方常传 `[...queue]`
 *   （每次渲染都是新数组），若每轮都重置定时器，流式输出期间离场项会永远清不掉。
 */
export function usePresenceList<T>(items: T[], keyOf: (item: T) => string, exitMs = 170) {
  const keyOfRef = useRef(keyOf);
  keyOfRef.current = keyOf;

  const [entries, setEntries] = useState<PresenceEntry<T>[]>(
    () => items.map((item) => ({ item, leaving: false }))
  );
  const deadlines = useRef(new Map<string, number>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const drain = () => {
    timer.current = null;
    const now = Date.now();
    const expired = new Set<string>();
    let nextDue = Infinity;
    deadlines.current.forEach((due, key) => {
      if (due <= now) expired.add(key);
      else nextDue = Math.min(nextDue, due);
    });
    expired.forEach((key) => deadlines.current.delete(key));
    if (expired.size) {
      setEntries((current) => {
        const filtered = current.filter((entry) => !(entry.leaving && expired.has(keyOfRef.current(entry.item))));
        return filtered.length === current.length ? current : filtered;
      });
    }
    if (nextDue !== Infinity) timer.current = setTimeout(drain, Math.max(0, nextDue - now));
  };

  useLayoutEffect(() => {
    const keyOfItem = keyOfRef.current;
    setEntries((current) => {
      const live = new Map(items.map((item) => [keyOfItem(item), item]));
      const next: PresenceEntry<T>[] = [];
      const placed = new Set<string>();
      let added = false;
      for (const entry of current) {
        const key = keyOfItem(entry.item);
        const liveItem = live.get(key);
        if (liveItem !== undefined) {
          // 离场中又回来了（撤销删除）：取消它的截止时间，恢复成普通项。
          deadlines.current.delete(key);
          next.push({ item: liveItem, leaving: false });
        } else {
          if (!entry.leaving) {
            deadlines.current.set(key, Date.now() + exitMs);
            added = true;
          }
          next.push({ item: entry.item, leaving: true });
        }
        placed.add(key);
      }
      for (const item of items) {
        const key = keyOfItem(item);
        if (placed.has(key)) continue;
        next.push({ item, leaving: false });
        placed.add(key);
      }
      if (added && !timer.current) timer.current = setTimeout(drain, exitMs);
      const unchanged = next.length === current.length
        && next.every((entry, index) => entry.item === current[index].item && entry.leaving === current[index].leaving);
      return unchanged ? current : next;
    });
  }, [items, exitMs]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const leaving = useMemo(
    () => entries.filter((entry) => entry.leaving).map((entry) => entry.item),
    [entries]
  );

  return { leaving, render: entries };
}
