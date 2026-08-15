import type {
  Account,
  AccountAddJob,
  AccountImportJob,
  AccountRefreshJob,
  AccountRemovedEvent,
  AccountsListResponse
} from '../../types/index.ts';

export type AccountExportFormat = 'sub2api' | 'antigravity' | 'cliproxyapi';

export interface AccountImportUploadFile {
  name: string;
  relativePath?: string;
  content?: string;
  contentBase64?: string;
  encoding?: 'text' | 'base64';
}
export type AccountImportPayload =
  | { content: string; provider?: string }
  | {
      mode: 'upload';
      uploadKind?: 'file' | 'folder';
      files: AccountImportUploadFile[];
      provider?: string;
    }
  | { mode: 'cliproxyapi'; provider?: string };

export interface AccountsWatchHandlers {
  onSnapshot?: (payload: AccountsListResponse) => void;
  onSnapshotRequested?: (payload: { requestedAt?: number; hydrating?: boolean }) => void;
  onAccount?: (account: Account) => void;
  onAccountRemoved?: (payload: AccountRemovedEvent) => void;
  onHydrated?: (payload: { hydratedAt?: number }) => void;
  onImportJob?: (job: AccountImportJob) => void;
  onAuthJob?: (job: AccountAddJob) => void;
  onAccountRefreshJob?: (job: AccountRefreshJob) => void;
  onError?: () => void;
}
