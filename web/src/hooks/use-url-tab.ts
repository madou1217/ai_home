import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * 让页内 Tab 与地址栏 `?tab=` 双向同步。
 *
 * - 地址栏是单一事实源：刷新、前进/后退或从外部链接进入都直接落到对应 Tab；
 * - 切换 Tab 用 replace 更新查询参数，不产生无意义的历史记录；
 * - 选中默认 Tab 时移除参数，保持 URL 干净。
 */
export function useUrlTab<T extends string>(
  keys: readonly T[],
  fallback: T,
  param = 'tab'
): [T, (next: T) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = String(searchParams.get(param) || '').trim() as T;
  const tab = keys.includes(raw) ? raw : fallback;

  const selectTab = useCallback((next: T) => {
    const params = new URLSearchParams(searchParams);
    if (next === fallback) {
      params.delete(param);
    } else {
      params.set(param, next);
    }
    setSearchParams(params, { replace: true });
  }, [fallback, param, searchParams, setSearchParams]);

  return [tab, selectTab];
}