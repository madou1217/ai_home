import { Spin } from 'antd';
import { ExclamationCircleOutlined, ReloadOutlined, UserSwitchOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
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
          {!mobile ? (
            <strong className={styles.workspaceTitle} data-workspace-title="true" title={title}>{title}</strong>
          ) : null}
          <SettingStatusTag status="saving" label={label} compact />
        </div>
        {!chat ? <div className={styles.workspaceHeaderMeta}>连接就绪后即可输入</div> : null}
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
    return (
      <RuntimeState
        tone="blocked"
        title="需要选择运行凭据"
        description={BLOCK_REASON_TEXT[connection.reason]}
        hint="请在底部运行目标中选择可用账号后继续。"
      />
    );
  }
  if (connection.phase === 'error') {
    const presentation = runtimeFailurePresentation(connection.failure);
    return (
      <RuntimeState
        tone="error"
        title={presentation.title}
        description={presentation.description}
        hint="运行时未就绪，发送暂不可用。"
        retry={connection.retry}
      />
    );
  }
  return (
    <div className={runtimeStyles.runtimeState} role="status" aria-live="polite">
      <Spin size="small" />
      <strong>{connection.phase === 'pending' ? '正在读取会话策略…' : '正在连接运行时…'}</strong>
    </div>
  );
}

interface RuntimeStateProps {
  readonly tone: 'blocked' | 'error';
  readonly title: string;
  readonly description: string;
  readonly hint: string;
  readonly retry?: () => void;
}

function RuntimeState(props: RuntimeStateProps) {
  const isError = props.tone === 'error';
  return (
    <div className={runtimeStyles.runtimeState}>
      <section
        className={runtimeStyles.runtimeStateCard}
        role={isError ? 'alert' : 'status'}
        aria-live={isError ? 'assertive' : 'polite'}
      >
        <div className={runtimeStyles.runtimeStateHead}>
          <span className={runtimeStyles.runtimeStateIcon} data-tone={props.tone} aria-hidden="true">
            {isError ? <ExclamationCircleOutlined /> : <UserSwitchOutlined />}
          </span>
          <strong className={runtimeStyles.runtimeStateTitle}>{props.title}</strong>
          <SettingStatusTag status={isError ? 'error' : 'unset'} label={isError ? '连接异常' : '未就绪'} compact />
        </div>
        <p className={runtimeStyles.runtimeStateDesc}>{props.description}</p>
        <div className={runtimeStyles.runtimeStateFooter}>
          <span className={runtimeStyles.runtimeStateHint}>{props.hint}</span>
          {props.retry ? (
            <Button type="primary" size="small" icon={<ReloadOutlined />} onClick={props.retry}>
              重试连接
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

const BLOCK_REASON_TEXT: Readonly<Record<RuntimeTargetBlockReason, string>> = {
  account_required: '请选择当前 provider 可用的 OAuth 或 API Key 凭据。',
  provider_mismatch: '所选凭据与当前 provider 不匹配。',
  runtime_provider_unsupported: '当前 provider 尚未注册 canonical runtime descriptor。',
};
