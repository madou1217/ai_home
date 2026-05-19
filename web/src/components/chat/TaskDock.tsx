import { useMemo, useState } from 'react';
import type { StructuredChecklist } from './message-structure';
import { countChecklistProgress } from './message-structure';
import styles from './chat.module.css';

interface Props {
  checklist: StructuredChecklist;
  className?: string;
}

const TaskDock = ({ checklist, className }: Props) => {
  const [expanded, setExpanded] = useState(false);
  const progress = useMemo(() => countChecklistProgress(checklist.items), [checklist.items]);

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
          {`${checklist.kind === 'todo' ? 'Todo' : 'Plan'} · ${progress.completedCount}/${progress.totalCount} 已完成`}
        </span>
        <span className={styles.taskDockSummaryMeta}>
          <span className={styles.taskDockBadge}>{checklist.kind === 'todo' ? 'Todo' : 'Plan'}</span>
          <span className={styles.taskDockChevron}>{expanded ? '⌄' : '›'}</span>
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
                  {item.status === 'completed' ? '◌' : item.status === 'in_progress' ? '◔' : '○'}
                </span>
                <span
                  className={[
                    styles.taskDockItemText,
                    item.status === 'completed' ? styles.taskDockItemCompleted : '',
                    item.status === 'in_progress' ? styles.taskDockItemActive : ''
                  ].filter(Boolean).join(' ')}
                >
                  {`${index + 1}. ${item.content}`}
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
