/** Ignore mutations inside xterm's renderer: it cannot contain Ant Design overlays. */
export function forEachHudAddedElement(
  records: readonly MutationRecord[],
  inspect: (element: Element) => void,
): void {
  for (const record of records) {
    if (record.target instanceof Element && record.target.closest('.xterm-screen')) continue;
    record.addedNodes.forEach((node) => {
      if (node instanceof Element) inspect(node);
    });
  }
}
