import { useCallback, useEffect, useState } from 'react';
import type { ComposerCatalog, SessionRuntimeController } from '@/chat-runtime';

export interface RuntimeComposerCatalogState extends ComposerCatalog {
  readonly loading: boolean;
  readonly error?: string;
  readonly retry: () => void;
}

const EMPTY_CATALOG: ComposerCatalog = Object.freeze({ models: [], defaultModel: '' });

export function useRuntimeComposerCatalog(
  controller: SessionRuntimeController,
): RuntimeComposerCatalogState {
  const [catalog, setCatalog] = useState<ComposerCatalog>(EMPTY_CATALOG);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(undefined);
    void controller.getComposerCatalog().then(
      (next) => {
        if (disposed) return;
        setCatalog(next);
        setLoading(false);
      },
      (failure: unknown) => {
        if (disposed) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        setLoading(false);
      },
    );
    return () => { disposed = true; };
  }, [attempt, controller]);

  return { ...catalog, loading, error, retry };
}
