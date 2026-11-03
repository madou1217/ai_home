export interface SessionWatchUpdateAction {
  reload: boolean;
  markPending: boolean;
  clearPending: boolean;
}

export function resolveSessionWatchUpdateAction(payload: unknown): SessionWatchUpdateAction;
