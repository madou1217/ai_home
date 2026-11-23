import { useEffect, useMemo, useState } from 'react';
import { AimOutlined } from '@ant-design/icons';
import { Input, InputNumber, Popover, message } from 'antd';
import Button from '@/components/ui/AppButton';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import { useSessionSelector, type SessionProjection, type SessionProjectionStore } from '@/chat-runtime';
import type { SessionRuntimeActions } from './session-runtime-actions';
import StatsLine from '@/components/chat/StatsLine';
import ContextMeter from '@/components/chat/ContextMeter';
import type { ChatMessage } from '@/types';
import styles from '@/components/chat/composer/composer.module.css';

export default function SessionMetrics({ store, actions, onCompact }: {
  readonly store: SessionProjectionStore;
  readonly actions: SessionRuntimeActions;
  readonly onCompact: () => void;
}) {
  const projection = useSessionSelector(store, selectProjection);
  const messages = useMemo(() => projection.items.flatMap((item): ChatMessage[] => item.kind === 'message'
    ? [{ role: item.detail.role, content: item.content || '', metrics: item.detail.metrics }]
    : item.kind === 'reasoning' && item.detail.metrics
      ? [{ role: 'assistant', content: '', metrics: item.detail.metrics }] : []), [projection.items]);
  // After compaction, wait for a fresh usage report instead of showing the old context size.
  const latestContext = projection.items.findLast((item) =>
    (item.kind === 'message' || item.kind === 'reasoning') && item.detail.metrics?.contextTokens !== undefined
      || item.kind === 'notice' && ['contextCompaction', 'context_compacted'].includes(item.detail.code || ''));
  const lastMetrics = latestContext?.kind === 'notice' ? undefined : latestContext?.detail;
  const metrics = { ...(lastMetrics && 'metrics' in lastMetrics ? lastMetrics.metrics : {}), ...projection.activeTurn?.metrics };
  const context = projection.policy.contextState as { usedTokens?: number; contextWindow?: number; stale?: boolean;
    compaction?: { status: string }; goal?: { objective?: string; status?: string; tokenBudget?: number | null } } | undefined;
  const window = context?.contextWindow || metrics.contextWindow;
  const used = context ? context.usedTokens : metrics.contextTokens;
  const status = context?.compaction?.status;
  const contextStale = Boolean(context?.stale);
  const compacting = status === 'running';
  const canCompact = projection.capabilitySnapshot?.slashCommands?.includes('compact');
  const contextMeter = <>
    {status === 'failed' ? <span role="status" className={styles.compactStatus} data-state="failed">压缩失败，可重试</span>
        : status === 'cancelled' ? <span role="status" className={styles.compactStatus} data-state="cancelled">压缩已停止</span>
          : null}
    {projection.items.length > 0 ? <ContextMeter
      messages={[]} maxTokens={window} usedTokens={used}
      stale={contextStale} compacting={compacting} unknown={!window || used === undefined}
      showLabel onCompactSuggest={canCompact && projection.state === 'idle' && !compacting ? onCompact : undefined} /> : null}
  </>;
  const goal = <GoalControl actions={actions} projection={projection} context={context} />;
  return <StatsLine messages={messages} showConnection={false} partial={projection.timelineHasMore}
    embedded trailing={<>{goal}{contextMeter}</>} />;
}

function GoalControl({ actions, projection, context }: {
  readonly actions: SessionRuntimeActions;
  readonly projection: SessionProjection;
  readonly context?: { usedTokens?: number; contextWindow?: number; stale?: boolean;
    compaction?: { status: string }; goal?: { objective?: string; status?: string; tokenBudget?: number | null } };
}) {
  const descriptor = projection.capabilitySnapshot?.capabilities?.['session.goal'];
  const supported = descriptor?.support === 'native' || descriptor?.support === 'emulated';
  const [open, setOpen] = useState(false);
  const [objective, setObjective] = useState(context?.goal?.objective || '');
  const [tokenBudget, setTokenBudget] = useState<number | null>(context?.goal?.tokenBudget ?? null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) return;
    setObjective(context?.goal?.objective || '');
    setTokenBudget(context?.goal?.tokenBudget ?? null);
  }, [context?.goal?.objective, context?.goal?.tokenBudget, open]);
  if (!supported) return null;
  const hasGoal = Boolean(context?.goal?.objective?.trim());
  const dirty = objective !== (context?.goal?.objective || '')
    || tokenBudget !== (context?.goal?.tokenBudget ?? null);
  const currentGoal = hasGoal ? (
    <span
      className={styles.sessionGoal}
      title={`${context?.goal?.status || 'active'} · ${context?.goal?.objective}`}
    >
      <AimOutlined aria-hidden="true" />
      <span>目标：{context?.goal?.objective}</span>
    </span>
  ) : null;
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      if (!objective.trim()) await actions.clearGoal();
      else await actions.setGoal(objective, tokenBudget);
      setOpen(false);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '目标更新失败');
    } finally {
      setSaving(false);
    }
  };
  const clear = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await actions.clearGoal();
      setObjective('');
      setTokenBudget(null);
      setOpen(false);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '目标清除失败');
    } finally {
      setSaving(false);
    }
  };
  const content = (
    <div className={styles.goalEditor}>
      <div className={styles.goalEditorStatus}>
        <SettingStatusTag
          status={saving ? 'saving' : dirty ? 'dirty' : hasGoal ? 'applied' : 'unset'}
          label={saving ? '保存中' : dirty ? '未保存' : hasGoal ? '已设定目标' : '未设定目标'}
          compact
        />
      </div>
      <Input.TextArea
        value={objective}
        autoSize={{ minRows: 2, maxRows: 4 }}
        maxLength={16000}
        placeholder="输入本会话的目标…"
        onChange={(event) => setObjective(event.target.value)}
      />
      <InputNumber
        value={tokenBudget}
        min={1}
        precision={0}
        controls={false}
        placeholder="可选 token 预算"
        onChange={(value) => setTokenBudget(value)}
      />
      <div className={styles.goalEditorActions}>
        <Button type="text" size="small" disabled={saving || (!hasGoal && !objective.trim())} onClick={() => void clear()}>
          清除
        </Button>
        <Button type="primary" size="small" loading={saving} disabled={projection.state !== 'idle' || !dirty} onClick={() => void save()}>
          保存
        </Button>
      </div>
    </div>
  );
  return (
    <span className={styles.goalControl}>
      {currentGoal}
      <Popover title="会话目标" trigger="click" open={open} onOpenChange={setOpen} content={content}>
        <Button
          type="text"
          size="small"
          className={styles.goalControlButton}
          disabled={projection.state !== 'idle'}
          icon={<AimOutlined />}
          aria-label={hasGoal ? '编辑会话目标（已设定）' : '设置会话目标（未设定）'}
          title={hasGoal ? '编辑会话目标' : '设置会话目标'}
        />
      </Popover>
    </span>
  );
}

function selectProjection(projection: SessionProjection): SessionProjection { return projection; }
