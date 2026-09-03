import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Badge } from 'antd';
import { useSessionSelector } from '@/chat-runtime';
import type {
  SessionProjection,
  SessionRuntimeController,
  SessionState,
} from '@/chat-runtime';
import type { Account } from '@/types';
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
      <WorkspaceHeader title={props.title} projection={projection} />
      <ConversationTimeline
        controller={props.controller}
        firstTextPaintProbe={firstTextPaintProbe}
        provider={props.runtimeTarget.provider as Provider}
        projectPath={props.runtimeTarget.projectPath}
        mobile={props.mobile}
      />
      <div className={styles.workspaceDock}>
        <fieldset
          className={styles.workspaceDockControls}
          disabled={!connection.interactive}
          data-disabled={!connection.interactive}
        >
          <PlanImplementationPrompt
            store={props.controller.store}
            actions={actions}
            onImplementCurrent={implementCurrent}
            onImplementFresh={implementFresh}
          />
          <InteractionDock store={props.controller.store} actions={actions} />
          <QueueDock store={props.controller.store} actions={actions} />
          <Composer
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
}: {
  title: string;
  projection: ReturnType<typeof selectWorkspaceProjection>;
}) {
  const connection = sessionConnectionPresentation(projection.connectionState);
  // 副行 caption：连接状态 · CLI 版本 · seq N，整行 hover 可见全量。
  const meta = `${connection.label} · ${projection.version || '默认运行时'} · seq ${projection.throughSeq}`;
  return (
    <header className={styles.workspaceHeader}>
      <div className={styles.workspaceHeaderMain}>
        <strong className={styles.workspaceTitle} title={title}>{title}</strong>
        <Badge
          status={STATE_BADGE[projection.state]}
          text={STATE_LABELS[projection.state]}
          className={styles.workspaceStateBadge}
        />
      </div>
      <div className={styles.workspaceHeaderMeta} title={meta}>{meta}</div>
    </header>
  );
}

function selectWorkspaceProjection(projection: SessionProjection) {
  return {
    state: projection.state,
    connectionState: projection.connectionState,
    throughSeq: projection.throughSeq,
    nativeSessionId: projection.runtimeBinding?.nativeSessionId,
    version: projection.runtimeBinding?.version,
    approvalMode: canonicalApprovalMode(projection.policy.approvalMode),
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

const STATE_LABELS: Readonly<Record<SessionState, string>> = {
  idle: '就绪', starting: '正在启动', running: '运行中', waiting_input: '等待输入',
  interrupting: '正在停止', completing: '正在收尾', recovering: '正在恢复', closed: '已关闭',
};

// 会话状态 → Badge 小指示灯语义色（antd Badge status，禁大色块状态 Tag）。
const STATE_BADGE: Readonly<Record<SessionState, 'default' | 'processing' | 'warning'>> = {
  idle: 'default', starting: 'processing', running: 'processing', waiting_input: 'warning',
  interrupting: 'warning', completing: 'processing', recovering: 'warning', closed: 'default',
};
