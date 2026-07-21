import type {
  ChatAccount,
  Provider,
  QueuedChatMessage,
  Session,
} from '@/types';

export type PersistedChatSelection = {
  projectPath?: string;
  sessionId?: string;
  provider?: string;
  projectDirName?: string;
};

export type LegacyApprovalMode = 'bypass' | 'confirm' | 'plan';

export type ActiveSessionRun = {
  runKey: string;
  draftSessionId?: string;
  provider: Provider;
  sessionId?: string;
  runId?: string;
  projectDirName?: string;
  projectPath?: string;
  controller: AbortController;
};

export type DetachedRunBinding = {
  sessionKey: string;
  runId: string;
};

export interface LegacyRunMessageInput {
  readonly session: Session;
  readonly account: ChatAccount;
  readonly model?: string;
  readonly content: string;
  readonly imageList: string[];
}

export type QueuedSessionMessage = QueuedChatMessage & {
  provider: Provider;
  model?: string;
  mode: 'after_turn' | 'after_tool_call';
} & (
  | { accountRef: string; gateway?: false }
  | { gateway: true; accountRef?: never }
);
