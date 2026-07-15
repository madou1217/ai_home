import { useMemo, useState } from 'react';
import type { StructuredChecklist } from './message-structure';
import { countChecklistProgress, getChecklistState, getChecklistStateLabel, getTaskStatusLabel } from './message-structure';
import styles from './chat.module.css';

interface Props {
  checklist: StructuredChecklist;
  className?: string;
}

const TaskDock = ({ checklist, className }: Props) => {
  const [expanded, setExpanded] = useState(false);
  const progress = useMemo(() => countChecklistProgress(checklist.items), [checklist.items]);
  const state = useMemo(() => getChecklistState(checklist.items), [checklist.items]);
  // Dock 只复用结构化计划数据，标题文案在展示层转换成中文。
  const title = checklist.kind === 'todo' ? '待办' : '计划';

  if (progress.activeCount <= 0) return null;

  return (
    <div className={[styles.taskDock, className].filter(Boolean).join(' ')}>
      <button
        type="button"
        className={styles.taskDockSummary}
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <span className={styles.taskDockSummaryText}>
          {`${title} · ${getChecklistStateLabel(state)} · ${progress.completedCount}/${progress.totalCount} 已完成`}
        </span>
        <span className={styles.taskDockSummaryMeta}>
          <span className={[styles.taskDockBadge, styles[`taskDockBadge_${state}`]].filter(Boolean).join(' ')}>
            {title}
          </span>
          <span className={styles.taskDockChevron}>{expanded ? '▴' : '▾'}</span>
        </span>
      </button>

      {expanded ? (
        <div className={styles.taskDockBody}>
          {checklist.explanation ? (
            <div className={styles.taskDockExplanation}>{checklist.explanation}</div>
          ) : null}
          <div className={styles.taskDockList}>
            {checklist.items.map((item, index) => (
              <div key={`${item.content}-${index}`} className={styles.taskDockItem}>
                <span className={styles.taskDockItemMarker} aria-hidden="true">
                  {item.status === 'completed' ? '●' : item.status === 'in_progress' ? '◐' : '○'}
                </span>
                <span className={styles.taskDockItemContent}>
                  <span
                    className={[
                      styles.taskDockItemText,
                      item.status === 'completed' ? styles.taskDockItemCompleted : '',
                      item.status === 'in_progress' ? styles.taskDockItemActive : '',
                      item.status === 'blocked' ? styles.taskDockItemBlocked : '',
                      item.status === 'failed' ? styles.taskDockItemFailed : '',
                      item.status === 'cancelled' ? styles.taskDockItemMuted : '',
                      item.status === 'skipped' ? styles.taskDockItemMuted : ''
                    ].filter(Boolean).join(' ')}
                  >
                    {`${index + 1}. ${item.content}`}
                  </span>
                  <span className={[styles.taskDockStatusLabel, styles[`taskDockStatusLabel_${item.status}`]].filter(Boolean).join(' ')}>
                    {getTaskStatusLabel(item.status)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default TaskDock;
