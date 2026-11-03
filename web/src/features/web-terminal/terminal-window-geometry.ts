export interface TerminalWindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MARGIN = 8;

/** Keep the opposite edge fixed while resizing and keep the window in view. */
export function moveTerminalWindow(
  start: TerminalWindowRect,
  edge: string,
  dx: number,
  dy: number,
  viewportWidth: number,
  viewportHeight: number,
): TerminalWindowRect {
  const maxX = Math.max(MARGIN, viewportWidth - MARGIN);
  const maxY = Math.max(MARGIN, viewportHeight - MARGIN);
  const minWidth = Math.min(420, maxX - MARGIN);
  const minHeight = Math.min(180, maxY - MARGIN);
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
  if (edge === 'move') {
    return {
      ...start,
      x: clamp(start.x + dx, MARGIN, maxX - start.width),
      y: clamp(start.y + dy, MARGIN, maxY - start.height),
    };
  }
  let left = start.x;
  let top = start.y;
  let right = left + start.width;
  let bottom = top + start.height;
  if (edge.includes('w')) left = clamp(left + dx, MARGIN, right - minWidth);
  if (edge.includes('e')) right = clamp(right + dx, left + minWidth, maxX);
  if (edge.includes('n')) top = clamp(top + dy, MARGIN, bottom - minHeight);
  if (edge.includes('s')) bottom = clamp(bottom + dy, top + minHeight, maxY);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
