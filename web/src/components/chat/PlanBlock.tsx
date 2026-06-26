import { memo, useMemo } from 'react';
import {
  countChecklistProgress,
  getChecklistState,
  getChecklistStateLabel,
  getTaskStatusLabel,
  type ChecklistState,
  type StructuredChecklist
} from './message-structure';
import { CheckSquareOutlined, OrderedListOutlined } from '@ant-design/icons';
import EventBlock, { type StatusTone } from './EventBlock';
import evt from './EventBlock.module.css';

interface Props {
  checklist: StructuredChecklist;
  result?: string;
  mobile?: boolean;
}

const STATE_TONE: Record<ChecklistState, StatusTone> = {
  waiting: 'neutral',
  running: 'running',
  attention: 'attention',
  failed: 'failed',
  cancelled: 'cancelled',
  completed: 'success'
};

function getProgressRatio(totalCount: number, completedCount: number) {
  if (totalCount <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((completedCount / totalCount) * 100)));
}

function getResultText(result?: string) {
  const text = String(result || '').trim();
  if (!text || text === '{}') return '';
  return text;
}

function PlanBlock({ checklist, result = '', mobile = false }: Props) {
  const progress = useMemo(() => countChecklistProgress(checklist.items), [checklist.items]);
  const state = useMemo(() => getChecklistState(checklist.items), [checklist.items]);
  const progressRatio = getProgressRatio(progress.totalCount, progress.completedCount);
  const resultText = getResultText(result || checklist.result);
  const title = checklist.kind === 'todo' ? '待办' : '计划';

  return (
    <EventBlock
      tone="plan"
      icon={checklist.kind === 'todo' ? <CheckSquareOutlined /> : <OrderedListOutlined />}
      title={title}
      collapsible={false}
      dense={mobile}
      status={{ label: getChecklistStateLabel(state), tone: STATE_TONE[state], dot: state === 'running' }}
      meta={<span className={evt.metaText}>{`${progress.completedCount}/${progress.totalCount}`}</span>}
      aria-label={title}
    >
      <div className={evt.progressTrack} aria-hidden="true">
        <span className={evt.progressBar} style={{ width: `${progressRatio}%` }} />
      </div>

      {checklist.explanation ? <div className={evt.explanation}>{checklist.explanation}</div> : null}

      <ol className={evt.taskList}>
        {checklist.items.map((item, index) => (
          <li key={`${item.content}-${index}`} className={evt.task} data-status={item.status}>
            <span className={evt.taskMarker} aria-hidden="true" />
            <div className={evt.taskContent}>
              <span className={evt.taskText}>{item.content}</span>
              <span className={evt.taskStatus}>{getTaskStatusLabel(item.status)}</span>
            </div>
          </li>
        ))}
      </ol>

      {resultText ? (
        <details className={evt.result}>
          <summary>执行结果</summary>
          <pre>{resultText}</pre>
        </details>
      ) : null}
    </EventBlock>
  );
}

export default memo(PlanBlock);
