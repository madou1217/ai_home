export type WorkbenchPanelKind =
  | 'chat'
  | 'terminal'
  | 'files'
  | 'review'
  | 'browser';

export type WorkbenchToolKind = Exclude<WorkbenchPanelKind, 'chat'>;

interface BaseTab {
  readonly id: string;
  readonly kind: WorkbenchPanelKind;
  readonly label: string;
  readonly closable: boolean;
}

export interface ChatTab extends BaseTab {
  readonly kind: 'chat';
  readonly closable: false;
}

export interface TerminalTab extends BaseTab {
  readonly kind: 'terminal';
}

export interface FilesTab extends BaseTab {
  readonly kind: 'files';
  readonly filePath?: string;
}

export interface ReviewTab extends BaseTab {
  readonly kind: 'review';
}

export interface BrowserTab extends BaseTab {
  readonly kind: 'browser';
  readonly url: string;
}

export type WorkbenchTab = ChatTab | TerminalTab | FilesTab | ReviewTab | BrowserTab;

export interface WorkbenchState {
  readonly tabs: readonly WorkbenchTab[];
  readonly activeTabId: string;
}

export const PANEL_LABELS = WORKBENCH_PANEL_LABELS as Record<WorkbenchPanelKind, string>;

export const PANEL_LIMITS = WORKBENCH_PANEL_LIMITS as Partial<
  Record<WorkbenchPanelKind, number>
>;
import {
  PANEL_LABELS as WORKBENCH_PANEL_LABELS,
  PANEL_LIMITS as WORKBENCH_PANEL_LIMITS,
} from './workbench-state-policy.js';
