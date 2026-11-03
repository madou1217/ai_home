import { useCallback, useEffect, useRef } from 'react';

interface DebouncedActionOptions {
  wait?: number;
  disabled?: boolean;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return Boolean(value && typeof (value as Promise<unknown>).then === 'function');
}

export function useDebouncedAction<TArgs extends unknown[]>(
  handler: ((...args: TArgs) => unknown) | undefined,
  options: DebouncedActionOptions = {}
) {
  const { wait = 720, disabled = false } = options;
  const lockedRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  const releaseAfterWait = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }

    timerRef.current = window.setTimeout(() => {
      lockedRef.current = false;
      timerRef.current = null;
    }, wait);
  }, [wait]);

  useEffect(() => () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
  }, []);

  return useCallback((...args: TArgs) => {
    if (!handler) return undefined;
    if (disabled) return handler(...args);
    if (lockedRef.current) return undefined;

    lockedRef.current = true;
    const result = handler(...args);

    if (isPromiseLike(result)) {
      result.finally(releaseAfterWait);
    } else {
      releaseAfterWait();
    }

    return result;
  }, [disabled, handler, releaseAfterWait]);
}
