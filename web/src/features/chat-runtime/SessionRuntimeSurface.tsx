import { Alert, Spin } from 'antd';
import Button from '@/components/ui/AppButton';
import type { ChatRuntimeSession } from '@/chat-runtime';
import type { Account } from '@/types';
import SessionWorkspace from './SessionWorkspace';
import type {
  ApprovalMode,
  RuntimeTargetBlockReason,
  SessionRuntimeTargetResolution,
} from './session-surface-policy';
import { runtimeFailurePresentation } from './session-connection-presentation';
import { useSessionRuntime } from './use-session-runtime';
import styles from './runtime-state.module.css';

interface Props {
  readonly resolution: SessionRuntimeTargetResolution;
  readonly runtimeInstanceKey: string;
  readonly title: string;
  readonly mobile?: boolean;
  readonly accounts: readonly Account[];
  readonly selectedModel: string;
  readonly approvalMode: ApprovalMode;
  readonly onAccountChange: (account: Account) => void;
  readonly onModelChange: (model: string) => void;
  readonly onApprovalModeChange: (mode: ApprovalMode) => void;
  readonly onNativeSessionBound?: (nativeSessionId: string) => void;
  readonly onFreshNativeSessionBound: (nativeSessionId: string) => void;
  readonly onSessionResolved?: (session: ChatRuntimeSession) => void;
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
        runtimeTarget={runtimeTarget}
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
      />
    );
  }

  return <RuntimeConnectionState connection={connection} />;
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
    <div className={styles.runtimeState}>
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
    <div className={styles.runtimeState}>
      <Alert type="warning" showIcon message={props.title} description={props.description} />
      {props.retry ? <Button type="primary" onClick={props.retry}>重试 AIH Chat Runtime</Button> : null}
      <span>运行时未就绪，发送已禁用。</span>
    </div>
  );
}

const BLOCK_REASON_TEXT: Readonly<Record<RuntimeTargetBlockReason, string>> = {
  account_required: '请选择当前 provider 可用的 OAuth 或 API Key 凭据。',
  provider_mismatch: '所选凭据与当前 provider 不匹配。',
  project_path_required: '当前会话缺少项目路径，无法启动原生运行时。',
  runtime_provider_unsupported: '当前 provider 尚未注册 canonical runtime descriptor。',
};
