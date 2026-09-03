import type { ColumnLayout } from './workbench-layout';
import { restoreColumnLayout, serializeColumnLayout } from './workbench-layout';

// 栏布局（宽度 + 折叠态）是用户级偏好而非项目级状态，与按项目存储的标签页
// （workbench-persistence）分开存放。
const STORAGE_KEY = 'aih:workbench:column-layout';

export function saveColumnLayout(layout: ColumnLayout): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeColumnLayout(layout));
  } catch { /* quota exceeded or private mode */ }
}

export function loadColumnLayout(): ColumnLayout {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return restoreColumnLayout(raw ? JSON.parse(raw) : null);
  } catch {
    return restoreColumnLayout(null);
  }
}
