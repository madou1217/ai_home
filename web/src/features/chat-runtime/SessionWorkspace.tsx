import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from 'antd';
import { useSessionSelector } from '@/chat-runtime';
import type {
  SessionProjection,
  SessionRuntimeController,
  SessionState,
} from '@/chat-runtime';
import type { Account, Session } from '@/types';
import type { Provider } from '@/types';
import { useWorkbench } from '@/features/project-workbench/WorkbenchContext';
import Composer from './Composer';
import ConversationTimeline from './ConversationTimeline';
import InteractionDock from './InteractionDock';
import PlanImplementationPrompt from './PlanImplementationPrompt';
import QueueDock from './QueueDock';
import { BrowserFreshPlanRuntimePort } from './browser-fresh-plan-runtime-port';
import { BrowserFirstTextPaintProbe } from './browser-first-text-paint-probe';
import {
  FreshPlanImplementationWorkflow,
} from './fresh-plan-implementation-workflow';
import { PlanImplementationWorkflow } from './plan-implementation-workflow';
import type { PlanImplementationRuntimePort } from './plan-implementation-workflow';
import { sessionConnectionPresentation } from './session-connection-presentation';
import { SessionRuntimeActions } from './session-runtime-actions';
import type { ApprovalMode, SessionRuntimeTarget } from './session-surface-policy';
import { useRuntimeComposerCatalog } from './use-runtime-composer-catalog';
import { workspaceStatusLabel } from './workspace-status-presentation';
import styles from './session-runtime.module.css';

interface Props {
  readonly controller: SessionRuntimeController;
  readonly runtimeTarget: SessionRuntimeTarget;
  readonly title: string;
  readonly mobile?: boolean;
  readonly accounts: readonly Account[];
  readonly accountRef: string;
  readonly selectedModel: string;
  readonly approvalMode: ApprovalMode;
  readonly onAccountChange: (account: Account) => void;
  readonly onModelChange: (model: string) => void;
  readonly onApprovalModeChange: (mode: ApprovalMode) => void;
  readonly onFreshNativeSessionBound: (nativeSessionId: string) => void;
  readonly onNativeSessionBound?: (nativeSessionId: string) => void;
  readonly onBranchSession?: (session: Session) => void;
}

export default function SessionWorkspace(props: Props) {
  const workbench = useWorkbench();
  const projection = useSessionSelector(props.controller.store, selectWorkspaceProjection);
  const firstTextPaintProbe = useMemo(
    () => new BrowserFirstTextPaintProbe(props.controller.sessionId),
    [props.controller],
  );
  const actions = useMemo(
    () => new SessionRuntimeActions(props.controller, undefined, firstTextPaintProbe),
    [firstTextPaintProbe, props.controller],
  );
  const composerCatalog = useRuntimeComposerCatalog(props.controller);
  const connection = sessionConnectionPresentation(projection.connectionState);
  useEffect(() => () => firstTextPaintProbe.dispose(), [firstTextPaintProbe]);
  useNativeSessionReporter(projection.nativeSessionId, props.onNativeSessionBound);
  useCanonicalApprovalMode(projection.approvalMode, props);
  const currentPlanWorkflow = useMemo(
    () => new PlanImplementationWorkflow(currentPlanRuntimePort(props.controller)),
    [props.controller],
  );
  const freshPlanWorkflow = useMemo(
    () => new FreshPlanImplementationWorkflow(freshPlanRuntimePort),
    [props.controller],
  );
  useEffect(() => () => freshPlanWorkflow.dispose(), [freshPlanWorkflow]);
  useEffect(() => {
    if (props.runtimeTarget.policy.workspaceMode === 'chat' && projection.state === 'idle') {
      window.dispatchEvent(new Event('aih:chat-sessions-changed'));
    }
  }, [projection.state, props.runtimeTarget.policy.workspaceMode]);
  const implementCurrent = useCallback(async (sourceTurnId: string): Promise<void> => {
    await currentPlanWorkflow.execute(sourceTurnId);
    props.onApprovalModeChange('confirm');
  }, [currentPlanWorkflow, props.onApprovalModeChange]);
  const implementFresh = useCallback(async (
    sourceTurnId: string,
    planMarkdown: string,
  ): Promise<void> => {
    const result = await freshPlanWorkflow.execute(
      props.runtimeTarget,
      sourceTurnId,
      planMarkdown,
    );
    props.onFreshNativeSessionBound(result.nativeSessionId);
  }, [freshPlanWorkflow, props.onFreshNativeSessionBound, props.runtimeTarget]);

  return (
    <main className={styles.workspace}>
      <WorkspaceHeader title={projection.title || props.title} projection={projection} mobile={props.mobile}
        chat={props.runtimeTarget.policy.workspaceMode === 'chat'} />
      {projection.parentSessionId ? <a className={styles.branchParent}
        href={`/ui/chat?sessionId=${encodeURIComponent(projection.parentSessionId)}&provider=${encodeURIComponent(props.runtimeTarget.provider)}`}>
        {projection.regenerated ? '重新生成的回答 · 返回原会话' : '分支会话 · 返回原会话'}
      </a> : null}
      <ConversationTimeline
        controller={props.controller}
        actions={actions}
        firstTextPaintProbe={firstTextPaintProbe}
        provider={props.runtimeTarget.provider as Provider}
        projectPath={props.runtimeTarget.projectPath}
        workspaceMode={props.runtimeTarget.policy.workspaceMode}
        mobile={props.mobile}
        onBranchSession={props.onBranchSession}
      />
      <div className={styles.workspaceDock}>
        <fieldset
          className={styles.workspaceDockControls}
          disabled={!connection.interactive}
          data-disabled={!connection.interactive}
        >
          {props.runtimeTarget.policy.workspaceMode !== 'chat' ? <PlanImplementationPrompt
            store={props.controller.store}
            actions={actions}
            onImplementCurrent={implementCurrent}
            onImplementFresh={implementFresh}
          /> : null}
          <InteractionDock store={props.controller.store} actions={actions} />
          <QueueDock store={props.controller.store} actions={actions} />
          <Composer
            workspaceMode={props.runtimeTarget.policy.workspaceMode}
            store={props.controller.store}
            actions={actions}
            accounts={props.accounts}
            accountRef={props.accountRef}
            catalog={composerCatalog}
            selectedModel={props.selectedModel}
            approvalMode={projection.approvalMode || props.approvalMode}
            onAccountChange={props.onAccountChange}
            onModelChange={props.onModelChange}
            onApprovalModeChange={props.onApprovalModeChange}
            uploadAttachments={(attachments) => props.controller.uploadAttachments(attachments)}
            terminalOpen={false}
            onToggleTerminal={() => workbench?.openPanel('terminal')}
          />
        </fieldset>
      </div>
    </main>
  );
}

function useCanonicalApprovalMode(
  mode: ApprovalMode | undefined,
  props: Pick<Props, 'approvalMode' | 'onApprovalModeChange'>,
): void {
  useEffect(() => {
    if (mode && mode !== props.approvalMode) props.onApprovalModeChange(mode);
  }, [mode, props.approvalMode, props.onApprovalModeChange]);
}

function useNativeSessionReporter(
  nativeSessionId: string | undefined,
  onNativeSessionBound: ((nativeSessionId: string) => void) | undefined,
): void {
  const reportedNativeIdRef = useRef('');
  useEffect(() => {
    const currentId = nativeSessionId || '';
    if (!currentId || currentId === reportedNativeIdRef.current) return;
    reportedNativeIdRef.current = currentId;
    onNativeSessionBound?.(currentId);
  }, [nativeSessionId, onNativeSessionBound]);
}

function WorkspaceHeader({
  title,
  projection,
  chat,
  mobile,
}: {
  title: string;
  projection: ReturnType<typeof selectWorkspaceProjection>;
  chat: boolean;
  mobile?: boolean;
}) {
  const connection = sessionConnectionPresentation(projection.connectionState);
  const now = useSecondClock(projection.activeTurnStartedAt);
  const stateLabel = workspaceStatusLabel(
    projection.state,
    projection.connectionState,
    projection.activeTurnStartedAt,
    now,
  );
  const meta = `${connection.label} · ${projection.version || '默认运行时'} · seq ${projection.throughSeq}`;
  if (mobile && chat && projection.state === 'idle' && connection.interactive) return null;
  return (
    <header className={styles.workspaceHeader}>
      <div className={styles.workspaceHeaderMain}>
        {!mobile ? <strong className={styles.workspaceTitle} title={title}>{title}</strong> : null}
        <Badge
          status={connection.interactive ? STATE_BADGE[projection.state] : CONNECTION_BADGE[projection.connectionState]}
          text={stateLabel}
          className={styles.workspaceStateBadge}
        />
      </div>
      {!chat ? <div className={styles.workspaceHeaderMeta} title={meta}>{meta}</div> : null}
    </header>
  );
}

function selectWorkspaceProjection(projection: SessionProjection) {
  const lineage = projection.policy.lineage as { parentSessionId?: string; operation?: string } | undefined;
  return {
    state: projection.state,
    connectionState: projection.connectionState,
    throughSeq: projection.throughSeq,
    nativeSessionId: projection.runtimeBinding?.nativeSessionId,
    activeTurnStartedAt: projection.activeTurn?.startedAt,
    version: projection.runtimeBinding?.version,
    approvalMode: canonicalApprovalMode(projection.policy.approvalMode),
    title: typeof projection.policy.title === 'string' ? projection.policy.title : undefined,
    parentSessionId: lineage?.parentSessionId,
    regenerated: lineage?.operation === 'turn.regenerate',
  };
}

function canonicalApprovalMode(value: unknown): ApprovalMode | undefined {
  return value === 'bypass' || value === 'confirm' || value === 'plan' ? value : undefined;
}

const freshPlanRuntimePort = new BrowserFreshPlanRuntimePort();

function currentPlanRuntimePort(
  controller: SessionRuntimeController,
): PlanImplementationRuntimePort {
  return {
    confirmPolicy: (commandId) => controller.dispatch({
      commandId,
      type: 'session.policy.set',
      payload: { key: 'approvalMode', value: 'confirm' },
    }),
    submit: (commandId, content) => controller.dispatch({
      commandId,
      type: 'turn.submit',
      payload: { content },
    }),
  };
}

// 会话状态 → Badge 小指示灯语义色（antd Badge status，禁大色块状态 Tag）。
const STATE_BADGE: Readonly<Record<SessionState, 'default' | 'processing' | 'warning'>> = {
  idle: 'default', starting: 'processing', running: 'processing', waiting_input: 'warning',
  interrupting: 'warning', completing: 'processing', recovering: 'warning', closed: 'default',
};

const CONNECTION_BADGE = {
  connecting: 'processing', connected: 'default', reconnecting: 'warning', resyncing: 'warning',
} as const;

function useSecondClock(startedAt: number | undefined): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return now;
}
