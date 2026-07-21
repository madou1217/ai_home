import { useCallback, useEffect, useState } from 'react';
import type { Provider, ProviderSessionLifecycleCapability } from '@/types';
import { sessionsAPI } from '@/services/api';

export type SessionLifecycleCapabilities = Partial<Record<Provider, ProviderSessionLifecycleCapability>>;

export function useSessionLifecycleCapabilities() {
  const [capabilities, setCapabilities] = useState<SessionLifecycleCapabilities>({});
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setCapabilities(await sessionsAPI.getSessionLifecycleCapabilities());
    } catch {
      setCapabilities({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { capabilities, loading, reload };
}

export function lifecycleErrorMessage(error: any, fallback: string) {
  return String(error?.response?.data?.message || error?.message || fallback);
}
