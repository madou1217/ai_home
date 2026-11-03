export const ACCOUNT_APP_ENTRY_POLL_INTERVAL_MS = 2000;

type PollWindowTarget = Pick<Window, 'addEventListener' | 'removeEventListener'> & {
  setInterval: (handler: () => void, timeout: number) => number;
  clearInterval: (id: number) => void;
};

type PollDocumentTarget = Pick<
  Document,
  'visibilityState' | 'addEventListener' | 'removeEventListener'
>;

type AccountAppEntryPollingOptions<T> = {
  request: () => Promise<T>;
  onResult: (result: T) => void;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  windowTarget?: PollWindowTarget;
  documentTarget?: PollDocumentTarget;
};

export function startAccountAppEntryPolling<T>(
  options: AccountAppEntryPollingOptions<T>,
): () => void {
  const windowTarget = options.windowTarget || window;
  const documentTarget = options.documentTarget || document;
  const intervalMs = Math.max(500, options.intervalMs || ACCOUNT_APP_ENTRY_POLL_INTERVAL_MS);
  let stopped = false;
  let inFlight = false;

  const poll = async () => {
    if (stopped || inFlight || documentTarget.visibilityState === 'hidden') return;
    inFlight = true;
    try {
      const result = await options.request();
      if (!stopped) options.onResult(result);
    } catch (error) {
      if (!stopped) options.onError?.(error);
    } finally {
      inFlight = false;
    }
  };
  const handleFocus = () => void poll();
  const handleVisibilityChange = () => {
    if (documentTarget.visibilityState !== 'hidden') void poll();
  };
  const timer = windowTarget.setInterval(() => void poll(), intervalMs);

  windowTarget.addEventListener('focus', handleFocus);
  documentTarget.addEventListener('visibilitychange', handleVisibilityChange);
  void poll();

  return () => {
    stopped = true;
    windowTarget.clearInterval(timer);
    windowTarget.removeEventListener('focus', handleFocus);
    documentTarget.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}
