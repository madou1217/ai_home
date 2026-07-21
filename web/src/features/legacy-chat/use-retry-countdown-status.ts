import { useEffect, useState } from 'react';
import {
  formatRetryCountdownStatus,
  getRetryCountdownDelayMs,
} from '@/components/chat/provider-pending-policy.js';
import type { RetryCountdown } from '@/components/chat/provider-pending-policy.js';

export function useRetryCountdownStatus(countdown: RetryCountdown | null): string | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!countdown) return;
    let timer: number | null = null;

    const tick = (): void => {
      const current = Date.now();
      setNow(current);
      const delayMs = getRetryCountdownDelayMs(countdown, current);
      if (delayMs !== null) timer = window.setTimeout(tick, delayMs);
    };

    tick();
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [countdown]);

  if (!countdown) return null;
  return formatRetryCountdownStatus(countdown, Math.max(now, countdown.startedAt));
}
