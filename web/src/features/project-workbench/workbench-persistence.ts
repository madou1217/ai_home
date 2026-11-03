import type { WorkbenchState } from './workbench-types';
import {
  restoreWorkbenchState,
  serializeWorkbenchState,
  workbenchProjectStorageKey,
} from './workbench-persistence-policy.js';

export function saveWorkbenchState(projectPath: string, state: WorkbenchState): void {
  try {
    window.localStorage.setItem(
      workbenchProjectStorageKey(projectPath),
      serializeWorkbenchState(state),
    );
  } catch { /* quota exceeded or private mode */ }
}

export function loadWorkbenchState(projectPath: string): WorkbenchState {
  try {
    const raw = window.localStorage.getItem(workbenchProjectStorageKey(projectPath));
    return restoreWorkbenchState(raw ? JSON.parse(raw) : null) as WorkbenchState;
  } catch {
    return restoreWorkbenchState(null) as WorkbenchState;
  }
}

export function clearWorkbenchState(projectPath: string): void {
  try {
    window.localStorage.removeItem(workbenchProjectStorageKey(projectPath));
  } catch { /* ignore */ }
}
