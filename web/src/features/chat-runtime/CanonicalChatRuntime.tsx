import type { Account, ChatAccount, Provider, Session } from '@/types';
import SessionRuntimeSurface from './SessionRuntimeSurface';
import {
  resolveSessionRuntimeTarget,
  runtimeAccountsForSession,
} from './session-surface-policy';
import type { ApprovalMode } from './session-surface-policy';
import { useNativeSessionAdoption } from './use-native-session-adoption';

interface ProjectRefreshSelection {
  readonly sessionId?: string;
  readonly provider?: Provider;
  readonly projectPath?: string;
}

interface Props {
  readonly session: Session;
  readonly projectPath?: string;
  readonly account: ChatAccount | null;
  readonly accounts: readonly Account[];
  readonly selectedModel: string;
  readonly approvalMode: ApprovalMode;
  readonly approvalModeReady: boolean;
  readonly title: string;
  readonly mobile?: boolean;
  readonly onAccountChange: (account: Account) => void;
  readonly onModelChange: (model: string) => void;
  readonly onApprovalModeChange: (mode: ApprovalMode) => void;
  readonly onSessionChange: (session: Session) => void;
  readonly onProjectsRefresh: (selection: ProjectRefreshSelection) => Promise<void>;
}

export default function CanonicalChatRuntime(props: Props) {
  const adoption = useNativeSessionAdoption({
    ...props,
    session: props.session,
  });
  const runtimeAccounts = runtimeAccountsForSession(props.session, props.accounts);
  const resolution = resolveRuntimeTarget(props);

  return (
    <SessionRuntimeSurface
      resolution={resolution}
      runtimeInstanceKey={adoption.runtimeInstanceKey}
      title={props.title}
      mobile={props.mobile}
      accounts={runtimeAccounts}
      selectedModel={props.selectedModel}
      approvalMode={props.approvalMode}
      onAccountChange={props.onAccountChange}
      onModelChange={props.onModelChange}
      onApprovalModeChange={props.onApprovalModeChange}
      onNativeSessionBound={adoption.onNativeSessionBound}
      onFreshNativeSessionBound={adoption.onFreshNativeSessionBound}
      onSessionResolved={adoption.onSessionResolved}
    />
  );
}

function resolveRuntimeTarget(props: Props) {
  if (!props.approvalModeReady) return { status: 'pending' as const };
  return resolveSessionRuntimeTarget({
    session: props.session,
    account: props.account,
    projectPath: props.projectPath,
    approvalMode: props.approvalMode,
  });
}
