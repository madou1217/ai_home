import type { MutableRefObject } from 'react';
import type {
  Account,
  AggregatedProject,
  ChatAccount,
  Session,
} from '@/types';
import type {
  LegacyApprovalMode,
  PersistedChatSelection,
} from './runtime-types';

export interface LegacyChatSelectionPort {
  readonly session: Session;
  readonly sessionRef: MutableRefObject<Session | null>;
  readonly project: AggregatedProject | null;
  readonly account: ChatAccount | null;
  readonly model: string;
  readonly approvalMode: LegacyApprovalMode;
  readonly changeSession: (session: Session) => void;
  readonly changeProject: (project: AggregatedProject) => void;
  readonly changeAccount: (account: ChatAccount) => void;
  readonly changeModel: (model: string) => void;
  readonly changeApprovalMode: (mode: LegacyApprovalMode) => void;
}

export interface LegacyChatCatalogPort {
  readonly projects: AggregatedProject[];
  readonly accounts: Account[];
  readonly accountsRef: MutableRefObject<Account[]>;
  readonly findProjectByPath: (projectPath?: string) => AggregatedProject | null;
  readonly refreshProjects: (selection?: PersistedChatSelection) => Promise<void>;
  readonly pauseProjectWatch: () => void;
  readonly resumeProjectWatch: () => void;
  readonly selectAccountForProvider: (provider: Session['provider']) => void;
}
