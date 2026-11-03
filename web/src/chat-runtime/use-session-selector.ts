import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { SessionProjection } from './projection-types';
import type { SessionProjectionStore } from './session-projection-store';

type Selector<T> = (projection: SessionProjection) => T;
type Equality<T> = (left: T, right: T) => boolean;

interface SelectionCache<T> {
  store?: SessionProjectionStore;
  projection?: SessionProjection;
  selector?: Selector<T>;
  initialized: boolean;
  value?: T;
}

export function useSessionSelector<T>(
  store: SessionProjectionStore,
  selector: Selector<T>,
  isEqual: Equality<T> = Object.is,
): T {
  const selectorRef = useRef(selector);
  const equalityRef = useRef(isEqual);
  const cacheRef = useRef<SelectionCache<T>>({ initialized: false });
  selectorRef.current = selector;
  equalityRef.current = isEqual;

  const getSelection = useCallback((): T => {
    const projection = store.getSnapshot();
    const cache = cacheRef.current;
    const currentSelector = selectorRef.current;
    const cacheMatches = cache.store === store
      && cache.projection === projection
      && cache.selector === currentSelector;
    if (cacheMatches && cache.initialized) return cache.value as T;

    const nextValue = currentSelector(projection);
    const value = cache.initialized && equalityRef.current(cache.value as T, nextValue)
      ? cache.value as T
      : nextValue;
    cacheRef.current = {
      store,
      projection,
      selector: currentSelector,
      initialized: true,
      value,
    };
    return value;
  }, [store]);

  return useSyncExternalStore(store.subscribe, getSelection, getSelection);
}
