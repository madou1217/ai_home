import { useCallback, useRef } from 'react';
import type { ChatRuntimeSession } from '@/chat-runtime';
import type { Provider, Session } from '@/types';
import {
  adoptDraftNativeSession,
  createFreshNativeSession,
  resolveNativeSessionAdoption,
} from './native-session-adoption';
import {
  createRuntimeInstanceIdentity,
  expectNativeSessionAdoption,
  reconcileRuntimeInstanceIdentity,
} from './runtime-instance-identity';
import type { ApprovalMode } from './session-surface-policy';
import { persistSessionApprovalMode } from './use-session-approval-mode';

interface ProjectRefreshSelection {
  readonly sessionId?: string;
  readonly provider?: Provider;
  readonly projectPath?: string;
}

interface NativeSessionAdoptionOptions {
  readonly session: Session;
  readonly projectPath?: string;
  readonly approvalMode: ApprovalMode;
  readonly onApprovalModeChange: (mode: ApprovalMode) => void;
  readonly onSessionChange: (session: Session) => void;
  readonly onProjectsRefresh: (selection: ProjectRefreshSelection) => Promise<void>;
}

export function useNativeSessionAdoption(options: NativeSessionAdoptionOptions) {
  const runtimeIdentityRef = useRef(createRuntimeInstanceIdentity(options.session));
  runtimeIdentityRef.current = reconcileRuntimeInstanceIdentity(
    runtimeIdentityRef.current,
    options.session,
  );

  const expectNativeSession = useCallback((nativeSessionId: string): void => {
    runtimeIdentityRef.current = expectNativeSessionAdoption(
      runtimeIdentityRef.current,
      nativeSessionId,
    );
  }, []);
  const refresh = useCallback((session: Session): void => {
    void options.onProjectsRefresh({
      sessionId: session.id,
      provider: session.provider,
      projectPath: session.projectPath,
    });
  }, [options.onProjectsRefresh]);

  const onNativeSessionBound = useCallback((nativeSessionId: string): void => {
    const session = adoptDraftNativeSession({
      session: options.session,
      projectPath: options.projectPath,
    }, nativeSessionId);
    if (!session) return;
    expectNativeSession(nativeSessionId);
    persistSessionApprovalMode(session, options.approvalMode);
    options.onSessionChange(session);
    refresh(session);
  }, [
    expectNativeSession,
    options.approvalMode,
    options.onSessionChange,
    options.projectPath,
    options.session,
    refresh,
  ]);

  const onFreshNativeSessionBound = useCallback((nativeSessionId: string): void => {
    const session = createFreshNativeSession({
      session: options.session,
      projectPath: options.projectPath,
    }, nativeSessionId);
    if (!session) return;
    persistSessionApprovalMode(session, 'confirm');
    options.onApprovalModeChange('confirm');
    options.onSessionChange(session);
    refresh(session);
  }, [
    options.onApprovalModeChange,
    options.onSessionChange,
    options.projectPath,
    options.session,
    refresh,
  ]);

  const onSessionResolved = useCallback((resolved: ChatRuntimeSession): void => {
    const adoption = resolveNativeSessionAdoption(
      options.session,
      resolved,
      options.projectPath,
    );
    if (!adoption) return;
    if (options.session.draft) expectNativeSession(adoption.nativeSessionId);
    if (!adoption.session) return;
    options.onSessionChange(adoption.session);
    refresh(adoption.session);
  }, [
    expectNativeSession,
    options.onSessionChange,
    options.projectPath,
    options.session,
    refresh,
  ]);

  return {
    runtimeInstanceKey: runtimeIdentityRef.current.key,
    onNativeSessionBound,
    onFreshNativeSessionBound,
    onSessionResolved,
  };
}
