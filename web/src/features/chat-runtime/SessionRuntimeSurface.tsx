import { Badge, Spin } from 'antd';
import Button from '@/components/ui/AppButton';
import type { ChatRuntimeSession } from '@/chat-runtime';
import type { ChatAccount, Provider, Session } from '@/types';
import SessionWorkspace from './SessionWorkspace';
import type {
  ApprovalMode,
  RuntimeTargetBlockReason,
  SessionRuntimeTargetResolution,
} from './session-surface-policy';
import { runtimeFailurePresentation } from './session-connection-presentation';
import { useSessionRuntime } from './use-session-runtime';
import runtimeStyles from './runtime-state.module.css';
import styles from './session-runtime.module.css';

interface Props {
  readonly resolution: SessionRuntimeTargetResolution;
  readonly runtimeInstanceKey: string;
  readonly title: string;
  readonly mobile?: boolean;
  readonly accounts: readonly ChatAccount[];
  readonly selectedModel: string;
  readonly approvalMode: ApprovalMode;
  readonly onAccountChange: (account: ChatAccount) => void;
  readonly onModelChange: (model: string) => void;
  readonly onApprovalModeChange: (mode: ApprovalMode) => void;
  readonly onNativeSessionBound?: (nativeSessionId: string) => void;
  readonly onFreshNativeSessionBound: (nativeSessionId: string) => void;
  readonly onSessionResolved?: (session: ChatRuntimeSession) => void;
  readonly onProjectsRefresh: (selection: { readonly sessionId?: string; readonly provider?: Provider; readonly projectPath?: string }) => Promise<void>;
  readonly onBranchSession?: (session: Session) => void;
}

export default function SessionRuntimeSurface(props: Props) {
  const connection = useSessionRuntime(
    props.resolution,
    props.runtimeInstanceKey,
    props.onSessionResolved,
  );
  const runtimeTarget = props.resolution.status === 'ready'
    ? props.resolution.target
    : undefined;
  if (connection.phase === 'ready' && runtimeTarget) {
    return (
      <SessionWorkspace
        controller={connection.controller}
        runtimeTarget={{ ...runtimeTarget, ...(connection.readOnly ? { readOnly: true } : {}) }}
        title={props.title}
        mobile={props.mobile}
        accounts={props.accounts}
        accountRef={runtimeTarget.executionAccountRef}
        selectedModel={props.selectedModel}
        approvalMode={props.approvalMode}
        onAccountChange={props.onAccountChange}
        onModelChange={props.onModelChange}
        onApprovalModeChange={props.onApprovalModeChange}
        onNativeSessionBound={props.onNativeSessionBound}
        onFreshNativeSessionBound={props.onFreshNativeSessionBound}
        onBranchSession={props.onBranchSession}
        onProjectsRefresh={props.onProjectsRefresh}
      />
    );
  }
  if (connection.phase === 'pending' || connection.phase === 'connecting') {
    return (
      <RuntimeConnectingShell
        title={props.title}
        mobile={props.mobile}
        chat={!runtimeTarget?.projectPath}
        label={connection.phase === 'pending' ? '正在读取会话策略' : '正在连接运行时'}
      />
    );
  }
  return <RuntimeConnectionState connection={connection} />;
}

/**
 * 连接中的占位外壳：先给出与工作区一致的标题/结构，而不是整屏 Spin。
 * 会话创建通常只有几十毫秒；慢的时候用户至少看到的是「这个会话」而不是一个空白等待页。
 */
function RuntimeConnectingShell({
  title,
  mobile,
  chat,
  label,
}: {
  readonly title: string;
  readonly mobile?: boolean;
  readonly chat: boolean;
  readonly label: string;
}) {
  return (
    <main className={styles.workspace} data-runtime-workspace="true" data-runtime-connecting="true">
      <header className={styles.workspaceHeader}>
        <div className={styles.workspaceHeaderMain}>
          {!mobile ? <strong className={styles.workspaceTitle} title={title}>{title}</strong> : null}
          <Badge status="processing" text={label} className={styles.workspaceStateBadge} />
        </div>
        {!chat ? <div className={styles.workspaceHeaderMeta}>正在准备运行时</div> : null}
      </header>
      <div className={styles.timelineFrame}>
        <div className={styles.connectingTimeline} role="status" aria-live="polite">
          <Spin size="small" />
          <span>{label}…</span>
        </div>
      </div>
      <div className={styles.workspaceDock}>
        <div className={styles.connectingDock} aria-hidden="true" />
      </div>
    </main>
  );
}

function RuntimeConnectionState({
  connection,
}: {
  connection: ReturnType<typeof useSessionRuntime>;
}) {
  if (connection.phase === 'blocked') {
    return <RuntimeState
      title="请选择运行凭据"
      description={BLOCK_REASON_TEXT[connection.reason]}
    />;
  }
  if (connection.phase === 'error') {
    const presentation = runtimeFailurePresentation(connection.failure);
    return <RuntimeState
      title={presentation.title}
      description={presentation.description}
      retry={connection.retry}
    />;
  }
  return (
    <div className={runtimeStyles.runtimeState}>
      <Spin size="large" />
      <strong>{connection.phase === 'pending' ? '正在读取会话策略…' : '正在连接原生运行时…'}</strong>
    </div>
  );
}

interface RuntimeStateProps {
  readonly title: string;
  readonly description: string;
  readonly retry?: () => void;
}

function RuntimeState(props: RuntimeStateProps) {
  return (
    <div className={runtimeStyles.runtimeState}>
      <strong role="status">{props.title}</strong>
      <span>{props.description}</span>
      {props.retry ? <Button type="primary" onClick={props.retry}>重试 AIH Chat Runtime</Button> : null}
      <span>运行时未就绪，发送已禁用。</span>
    </div>
  );
}

const BLOCK_REASON_TEXT: Readonly<Record<RuntimeTargetBlockReason, string>> = {
  account_required: '请选择当前 provider 可用的 OAuth 或 API Key 凭据。',
  provider_mismatch: '所选凭据与当前 provider 不匹配。',
  runtime_provider_unsupported: '当前 provider 尚未注册 canonical runtime descriptor。',
};
