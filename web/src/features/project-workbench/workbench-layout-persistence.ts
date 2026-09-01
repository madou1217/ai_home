import type { ColumnWidths } from './workbench-layout';
import { restoreColumnWidths, serializeColumnWidths } from './workbench-layout';

// 栏宽是用户级偏好而非项目级状态，与按项目存储的标签页（workbench-persistence）分开存放。
const STORAGE_KEY = 'aih:workbench:column-layout';

export function saveColumnWidths(widths: ColumnWidths): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeColumnWidths(widths));
  } catch { /* quota exceeded or private mode */ }
}

export function loadColumnWidths(): ColumnWidths {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return restoreColumnWidths(raw ? JSON.parse(raw) : null);
  } catch {
    return restoreColumnWidths(null);
  }
}
