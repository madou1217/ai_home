import { useCallback, useLayoutEffect, useRef } from 'react';

const DEFAULT_INTERVAL_FRAMES = 3;

/**
 * Return a stable scheduler that coalesces visual updates over a frame interval.
 * (Adopted from deepseek-harness client architecture)
 */
export function useThrottledVisualUpdate(
  update: () => void,
  intervalFrames = DEFAULT_INTERVAL_FRAMES
): () => void {
  const updateRef = useRef(update);
  updateRef.current = update;
  const pendingFrameRef = useRef<number | null>(null);

  useLayoutEffect(() => () => {
    if (pendingFrameRef.current === null) return;
    cancelAnimationFrame(pendingFrameRef.current);
    pendingFrameRef.current = null;
  }, []);

  return useCallback(() => {
    if (pendingFrameRef.current !== null) return;
    let remainingFrames = intervalFrames;
    const advance = (): void => {
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        pendingFrameRef.current = requestAnimationFrame(advance);
        return;
      }
      pendingFrameRef.current = null;
      updateRef.current();
    };
    pendingFrameRef.current = requestAnimationFrame(advance);
  }, [intervalFrames]);
}
