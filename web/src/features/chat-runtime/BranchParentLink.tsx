import { useEffect, useState } from 'react';
import { createBrowserChatRuntimeApiClient } from '@/chat-runtime';
import Button from '@/components/ui/AppButton';
import { resolveBranchParentHref } from './branch-navigation';
import type { SessionRuntimeTarget } from './session-surface-policy';
import styles from './session-runtime.module.css';

const api = createBrowserChatRuntimeApiClient();

export default function BranchParentLink({ parentSessionId, regenerated, target }: {
  parentSessionId: string; regenerated: boolean; target: SessionRuntimeTarget;
}) {
  const [href, setHref] = useState('');
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const { provider, executionAccountRef, projectPath, policy: { workspaceMode } } = target;
  useEffect(() => {
    let disposed = false;
    setHref('');
    setFailed(false);
    void resolveBranchParentHref(parentSessionId, {
      provider, executionAccountRef, projectPath, policy: { workspaceMode, approvalMode: 'confirm' },
    }, api).then(
      (url) => { if (!disposed) setHref(url); },
      () => { if (!disposed) setFailed(true); },
    );
    return () => { disposed = true; };
  }, [parentSessionId, provider, executionAccountRef, projectPath, workspaceMode, attempt]);
  const label = regenerated ? '重新生成的回答 · 返回原会话' : '分支会话 · 返回原会话';
  return href ? <a className={styles.branchParent} href={href}>{label}</a>
    : <Button type="text" size="small" className={styles.branchParent} loading={!failed}
      onClick={() => setAttempt((value) => value + 1)}>
      {failed ? '原会话加载失败 · 重试' : label}
    </Button>;
}
