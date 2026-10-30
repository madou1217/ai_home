/**
 * xterm's DOM renderer rewrites its generated style elements on every grid
 * resize, including when the CSS is identical. Avoid invalidating page-wide
 * styles for no-op writes while keeping real theme and renderer changes intact.
 * This is scoped to the terminal's own style nodes and fails open if a browser
 * or a future renderer does not expose the expected DOM shape.
 */
export function avoidDuplicateTerminalStyleWrites(terminalElement: HTMLElement): () => void {
  const nodePrototype = terminalElement.ownerDocument.defaultView?.Node?.prototype;
  const native = nodePrototype && Object.getOwnPropertyDescriptor(nodePrototype, 'textContent');
  if (!native?.get || !native.set) return () => {};

  const installed: Array<{ style: HTMLStyleElement; get: () => string | null; set: (value: string | null) => void }> = [];
  for (const style of terminalElement.querySelectorAll<HTMLStyleElement>('.xterm-screen > style')) {
    if (Object.prototype.hasOwnProperty.call(style, 'textContent')) continue;
    const get = () => native.get!.call(style) as string | null;
    const set = (value: string | null) => {
      if (typeof value === 'string' && value === get()) return;
      native.set!.call(style, value);
    };
    try {
      Object.defineProperty(style, 'textContent', { configurable: true, enumerable: native.enumerable, get, set });
      installed.push({ style, get, set });
    } catch (_error) {
      // Keep xterm's native behavior when the host does not allow an override.
    }
  }
  return () => {
    for (const { style, get, set } of installed) {
      const current = Object.getOwnPropertyDescriptor(style, 'textContent');
      if (current?.get === get && current.set === set) delete (style as Partial<HTMLStyleElement>).textContent;
    }
  };
}
