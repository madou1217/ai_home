type PollWindowTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

type PollDocumentTarget = Pick<
  Document,
  'visibilityState' | 'addEventListener' | 'removeEventListener'
>;

type AccountAppEntryPollingOptions<T> = {
  request: () => Promise<T>;
  onResult: (result: T) => void;
  onError?: (error: unknown) => void;
  windowTarget?: PollWindowTarget;
  documentTarget?: PollDocumentTarget;
};

// WebUI 已删除周期轮询：只在挂载/聚焦/重新可见时拉一次；后续由 SSE/手动操作驱动。
export function startAccountAppEntryPolling<T>(
  options: AccountAppEntryPollingOptions<T>,
): () => void {
  const windowTarget = options.windowTarget || window;
  const documentTarget = options.documentTarget || document;
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

  windowTarget.addEventListener('focus', handleFocus);
  documentTarget.addEventListener('visibilitychange', handleVisibilityChange);
  void poll();

  return () => {
    stopped = true;
    windowTarget.removeEventListener('focus', handleFocus);
    documentTarget.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}
