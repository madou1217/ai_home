type ViewportListener = () => void;

const listeners = new Set<ViewportListener>();
let frame = 0;
let attached = false;

function flush() {
  frame = 0;
  listeners.forEach((listener) => listener());
}

function requestFlush() {
  if (frame !== 0) return;
  frame = window.requestAnimationFrame(flush);
}

/**
 * 全页面共享一对滚动/尺寸监听。
 *
 * 每个账号行各自注册 capture 阶段的 scroll 监听时，一屏 20 个账号就是 20 个监听
 * 和每帧几十次 getBoundingClientRect——滚动时必然掉帧。这里合并成一对监听 + 一次
 * rAF 节流，所有订阅者在同一帧里量完。
 */
export function subscribeViewportChange(listener: ViewportListener): () => void {
  if (typeof window === 'undefined') return () => {};
  listeners.add(listener);
  if (!attached) {
    window.addEventListener('resize', requestFlush);
    window.addEventListener('scroll', requestFlush, true);
    attached = true;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || !attached) return;
    window.removeEventListener('resize', requestFlush);
    window.removeEventListener('scroll', requestFlush, true);
    attached = false;
    if (frame !== 0) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}
