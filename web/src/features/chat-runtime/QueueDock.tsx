import { useState } from 'react';
import { Input, message as toast } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { useSessionSelector } from '@/chat-runtime';
import type {
  SessionProjection,
  SessionProjectionStore,
  SessionQueueEntry,
} from '@/chat-runtime';
import type { SessionRuntimeActions } from './session-runtime-actions';
import { runCommandOperation } from './command-operation';
import { queueRowPolicy } from './queue-row-policy';
import { usePresenceList } from '@/hooks/use-presence-list';
import styles from './session-runtime.module.css';

interface Props {
  readonly store: SessionProjectionStore;
  readonly actions: SessionRuntimeActions;
}

export default function QueueDock({ store, actions }: Props) {
  const queue = useSessionSelector(store, selectQueue);
  const state = useSessionSelector(store, selectState);
  const paused = useSessionSelector(store, (projection) =>
    (projection.policy.queueControl as { paused?: boolean } | undefined)?.paused === true);
  // 删除/发出队列项时先留 170ms 播退场（.aih-leaving）再卸载，队列不会「点一下整行消失」。
  const presence = usePresenceList([...queue], (entry) => entry.queueId, 170);
  if (presence.render.length === 0) return null;
  return (
    <section className={styles.queueDock} aria-label="消息队列">
      <header><strong>接下来</strong><span>{queue.length} 条</span>
        {paused ? <span role="status">已暂停，待发消息已保留</span> : null}
      </header>
      {presence.render.map(({ item: entry, leaving }) => {
        // 离场行不参与策略计算（它已不在 queue 里，位置/可操作性都失效）
        const liveIndex = leaving ? -1 : queue.findIndex((item) => item.queueId === entry.queueId);
        const policy = liveIndex < 0
          ? { mutable: false, canDispatch: false, moveUp: undefined, moveDown: undefined }
          : queueRowPolicy(queue, liveIndex, state);
        return <QueueRow
          key={entry.queueId}
          entry={entry}
          leaving={leaving}
          mutable={policy.mutable}
          canDispatch={policy.canDispatch}
          onSave={(content) => actions.editQueue(entry.queueId, content)}
          onRemove={() => actions.removeQueue(entry.queueId)}
          onDispatch={() => actions.dispatchQueue(entry.queueId)}
          onMoveUp={policy.moveUp
            ? () => actions.moveQueue(entry, policy.moveUp?.beforeQueueId)
            : undefined}
          onMoveDown={policy.moveDown
            ? () => actions.moveQueue(entry, policy.moveDown?.beforeQueueId)
            : undefined}
        />;
      })}
    </section>
  );
}

interface QueueRowProps {
  readonly entry: SessionQueueEntry;
  /** 正在播退场：只渲染不可操作 */
  readonly leaving?: boolean;
  readonly mutable: boolean;
  readonly canDispatch: boolean;
  readonly onSave: (content: string) => Promise<unknown>;
  readonly onRemove: () => Promise<unknown>;
  readonly onDispatch: () => Promise<unknown>;
  readonly onMoveUp?: () => Promise<unknown>;
  readonly onMoveDown?: () => Promise<unknown>;
}

function QueueRow(props: QueueRowProps) {
  const content = queueContent(props.entry);
  const [draft, setDraft] = useState(content);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const editingActive = props.mutable && editing;

  const run = async (
    operation: () => Promise<unknown>,
    onSuccess?: () => void,
  ): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await runCommandOperation({ execute: operation, onSuccess });
      if (result.ok) return true;
      toast.error(errorText(result.error, '队列操作失败'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    await run(
      () => props.onSave(draft),
      () => setEditing(false),
    );
  };

  return (
    <article
      className={`${styles.queueRow}${props.leaving ? ' aih-leaving' : ''}`}
      data-status={props.entry.status}
      aria-hidden={props.leaving || undefined}
    >
      <div className={styles.queueOrder}>#{props.entry.position}</div>
      <div className={styles.queueBody}>
        {editingActive ? (
          <Input.TextArea value={draft} autoSize={{ minRows: 1, maxRows: 3 }} onChange={(event) => setDraft(event.target.value)} />
        ) : <span>{content}</span>}
        <small>{props.entry.policy === 'after_turn' ? '本轮结束后' : '工具边界后'}</small>
      </div>
      <div className={styles.queueActions}>
        {!props.mutable ? <span>{QUEUE_STATUS_LABELS[props.entry.status]}</span> : editingActive ? (
          <Button size="small" loading={busy} onClick={() => void save()}>保存</Button>
        ) : (
          <Button
            size="small"
            icon={<EditOutlined />}
            disabled={busy}
            onClick={() => { setDraft(content); setEditing(true); }}
          />
        )}
        {props.mutable ? <>
          <Button size="small" icon={<ArrowUpOutlined />} disabled={busy || !props.onMoveUp} onClick={() => props.onMoveUp && void run(props.onMoveUp)} />
          <Button size="small" icon={<ArrowDownOutlined />} disabled={busy || !props.onMoveDown} onClick={() => props.onMoveDown && void run(props.onMoveDown)} />
          <Button size="small" disabled={busy || !props.canDispatch} onClick={() => void run(props.onDispatch)}>现在执行</Button>
          <Button size="small" danger icon={<DeleteOutlined />} disabled={busy} onClick={() => void run(props.onRemove)} />
        </> : null}
      </div>
    </article>
  );
}

function queueContent(entry: SessionQueueEntry): string {
  return typeof entry.payload.content === 'string' ? entry.payload.content : '';
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function selectQueue(projection: SessionProjection): readonly SessionQueueEntry[] {
  return projection.queue;
}

function selectState(projection: SessionProjection): SessionProjection['state'] {
  return projection.state;
}

const QUEUE_STATUS_LABELS: Readonly<Record<SessionQueueEntry['status'], string>> = {
  queued: '等待中', leased: '已领取', running: '执行中', completed: '已完成', failed: '失败',
};
