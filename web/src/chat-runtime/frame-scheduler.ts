export interface FrameHandle {
  cancel(): void;
}

export interface FrameScheduler {
  request(callback: FrameRequestCallback): FrameHandle;
  cancel(handle: FrameHandle): void;
}

function requestBrowserFrame(callback: FrameRequestCallback): FrameHandle {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    const handle = globalThis.requestAnimationFrame(callback);
    return { cancel: () => globalThis.cancelAnimationFrame(handle) };
  }

  const handle = globalThis.setTimeout(() => callback(Date.now()), 16);
  return { cancel: () => globalThis.clearTimeout(handle) };
}

function cancelBrowserFrame(handle: FrameHandle): void {
  handle.cancel();
}

export const browserFrameScheduler: FrameScheduler = {
  request: requestBrowserFrame,
  cancel: cancelBrowserFrame,
};
