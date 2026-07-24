import { createContext, useContext } from 'react';
import type { WorkbenchPanelKind } from './workbench-types';

export interface WorkbenchActions {
  openPanel: (kind: WorkbenchPanelKind) => void;
}

const WorkbenchContext = createContext<WorkbenchActions | null>(null);

export const WorkbenchProvider = WorkbenchContext.Provider;

export function useWorkbench(): WorkbenchActions | null {
  return useContext(WorkbenchContext);
}
