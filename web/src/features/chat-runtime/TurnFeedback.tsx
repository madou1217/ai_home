import { useEffect, useRef, useState } from 'react';
import { ReloadOutlined, StopOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { useSessionSelector, type SessionProjection, type SessionProjectionStore } from '@/chat-runtime';
import { resolveComposerPolicy } from './composer-policy';
import { sessionConnectionPresentation } from './session-connection-presentation';
import type { SessionRuntimeActions } from './session-runtime-actions';
import { turnFailureMessage, turnProgressText } from './turn-feedback-policy';
import styles from './session-runtime.module.css';

export default function TurnFeedback({ store, actions }: {
  readonly store: SessionProjectionStore;
  readonly actions: SessionRuntimeActions;
}) {
  const projection = useSessionSelector(store, selectProjection);
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState('');
  const inFlight = useRef(false);
  const progress = turnProgressText(projection, now);
  const ticking = Boolean(progress);
  const failure = projection.failedTurn;
  const connected = sessionConnectionPresentation(projection.connectionState).interactive;
  const canInterrupt = resolveComposerPolicy(projection.state, projection.capabilitySnapshot).canInterrupt
    && projection.state !== 'interrupting';
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  useEffect(() => setOperationError(''), [failure?.turnId, projection.activeTurn?.turnId]);

  const execute = async (operation: () => Promise<unknown>): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setOperationError('');
    try { await operation(); }
    catch (error) {
      setOperationError(error instanceof Error ? error.message : '操作失败，请稍后重试');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  if (!progress && !failure) return null;
  return (
    <div className={styles.turnFeedback}>
      <div className={styles.turnFeedbackRow}>
        <span role="status" aria-live={progress ? 'off' : 'polite'}>{progress || (failure && turnFailureMessage(failure))}</span>
        {progress && canInterrupt ? <Button size="small" icon={<StopOutlined />}
          loading={busy} disabled={!connected} onClick={() => void execute(() => actions.interrupt())}>
          停止
        </Button> : null}
        {failure?.retryable && projection.state === 'idle' ? <Button size="small" icon={<ReloadOutlined />}
          loading={busy} disabled={!connected} title="使用本轮原消息、附件和模型参数重新发送"
          onClick={() => void execute(() => actions.retry(failure.turnId))}>
          重试本轮
        </Button> : null}
      </div>
      {failure ? <details className={styles.turnFailureDetail}>
        <summary>错误详情</summary>
        <div>{failure.error.message || failure.error.code}</div>
      </details> : null}
      {operationError ? <div role="alert" className={styles.runtimeNotice} data-danger="true">
        {operationError}
      </div> : null}
    </div>
  );
}

function selectProjection(projection: SessionProjection): SessionProjection { return projection; }
