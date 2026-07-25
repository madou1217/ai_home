import type {
  WorkbenchPanelKind,
  WorkbenchState,
  WorkbenchTab,
} from './workbench-types';
import {
  createInitialWorkbenchState,
  nextWorkbenchTabId,
  reduceWorkbenchState,
} from './workbench-state-policy.js';

export type WorkbenchAction =
  | { type: 'tab/add'; tab: WorkbenchTab }
  | { type: 'tab/activate'; id: string }
  | { type: 'tab/close'; id: string }
  | { type: 'tab/update'; id: string; patch: Partial<Pick<WorkbenchTab, 'label'>> & Record<string, unknown> }
  | { type: 'tab/reorder'; fromIndex: number; toIndex: number }
  | { type: 'state/reset'; state: WorkbenchState };

export function nextTabId(kind: WorkbenchPanelKind): string {
  return nextWorkbenchTabId(kind);
}

export function createInitialState(): WorkbenchState {
  return createInitialWorkbenchState() as WorkbenchState;
}

export function workbenchReducer(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  return reduceWorkbenchState(state, action) as WorkbenchState;
}
