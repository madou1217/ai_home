import { useCallback, useEffect, useState } from 'react';
import { Modal, Spin, message } from 'antd';
import { HistoryOutlined, RollbackOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { workspaceCheckpointAPI } from '@/services/api';
import type { WorkspaceCheckpoint } from '@/services/api';
import styles from '../project-workbench.module.css';

interface Props {
  sessionId?: string;
  /** 恢复后通知宿主刷新 Git 变更 / 文件树。 */
  onRestored?: () => void;
}

const STATUS_LABEL: Record<string, string> = { A: '会删除', D: '会恢复', M: '会还原' };

function formatTime(ms: number): string {
  try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
}

/**
 * 当前会话的「每轮检查点」：每次发消息前 Server 给工作区拍一次快照（git plumbing，
 * 不碰暂存区 / 分支 / stash），这里可以把工作区撤销回任意一轮之前。本机与远程工作区同一机制。
 */
export default function CheckpointList({ sessionId, onRestored }: Props) {
  const [items, setItems] = useState<WorkspaceCheckpoint[]>([]);
  const [skipped, setSkipped] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    if (!sessionId) { setItems([]); return; }
    setLoading(true);
    try {
      const result = await workspaceCheckpointAPI.list(sessionId);
      setItems((result.checkpoints || []).filter((item) => !item.label.startsWith('aih pre-restore')));
      setSkipped(result.skipped || '');
    } catch {
      setItems([]);
    }
    setLoading(false);
  }, [sessionId]);
  useEffect(() => { void load(); }, [load]);

  const restore = useCallback(async (checkpoint: WorkspaceCheckpoint) => {
    if (!sessionId) return;
    setBusy(checkpoint.commit);
    try {
      const { files } = await workspaceCheckpointAPI.changes(sessionId, checkpoint.commit);
      if (files.length === 0) { message.info('工作区与该检查点一致，无需撤销'); return; }
      const confirmed = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: `撤销到 ${formatTime(checkpoint.createdAt)} 之前？`,
          content: (
            <div className={styles.checkpointConfirm}>
              <p>将影响 {files.length} 个文件（撤销前会自动再存一个检查点，可以撤回）：</p>
              <ul>
                {files.slice(0, 20).map((file) => (
                  <li key={file.path}><code>{file.path}</code> {STATUS_LABEL[file.status] || file.status}</li>
                ))}
                {files.length > 20 ? <li>…等 {files.length} 个</li> : null}
              </ul>
            </div>
          ),
          okText: '撤销',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!confirmed) return;
      await workspaceCheckpointAPI.restore(sessionId, checkpoint.commit);
      message.success('工作区已撤销到该检查点');
      onRestored?.();
      void load();
    } catch (error) {
      message.error(`撤销失败：${String((error as Error)?.message || error)}`);
    } finally {
      setBusy('');
    }
  }, [load, onRestored, sessionId]);

  if (!sessionId) return null;
  return (
    <section className={styles.checkpointSection} aria-label="每轮检查点">
      <div className={styles.reviewGroupTitle}>
        <span><HistoryOutlined /> 每轮检查点</span>
        <span>{items.length}</span>
      </div>
      {loading ? <Spin size="small" /> : null}
      {!loading && skipped ? <p className={styles.checkpointHint}>{skipped === 'git_not_installed' ? '未安装 git，无法建立检查点' : '不是 Git 仓库，无法建立检查点'}</p> : null}
      {!loading && !skipped && items.length === 0 ? <p className={styles.checkpointHint}>发送消息后，每轮之前的工作区状态会出现在这里</p> : null}
      {items.map((item, index) => (
        <div key={item.ref} className={styles.checkpointRow}>
          <span title={item.commit}>第 {items.length - index} 轮前 · {formatTime(item.createdAt)}</span>
          <Button
            type="text"
            size="small"
            icon={<RollbackOutlined />}
            loading={busy === item.commit}
            disabled={Boolean(busy)}
            aria-label="撤销到此检查点"
            title="撤销到此检查点"
            onClick={() => { void restore(item); }}
          />
        </div>
      ))}
    </section>
  );
}
