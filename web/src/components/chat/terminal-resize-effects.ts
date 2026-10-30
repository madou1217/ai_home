const activeResizes = new WeakMap<HTMLElement, { count: number; hadClass: boolean }>();
const RESIZING_CLASS = 'aih-terminal-resizing';

/** Temporarily reduce background paint work while any terminal is resized. */
export function suspendBackgroundBlur(root: HTMLElement = document.documentElement): () => void {
  let state = activeResizes.get(root);
  if (!state) {
    state = { count: 0, hadClass: root.classList.contains(RESIZING_CLASS) };
    activeResizes.set(root, state);
    root.classList.add(RESIZING_CLASS);
  }
  state.count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state!.count -= 1;
    if (state!.count === 0) {
      if (!state!.hadClass) root.classList.remove(RESIZING_CLASS);
      activeResizes.delete(root);
    }
  };
}
