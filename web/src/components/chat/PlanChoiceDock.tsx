import { memo } from 'react';
import styles from './chat.module.css';
import type { InteractivePrompt, InteractivePromptOption } from '@/types';

export type PlanChoiceDockOption = InteractivePromptOption;

interface PlanChoiceDockProps {
  visible: boolean;
  prompt: InteractivePrompt | null;
  disabled?: boolean;
  onSelect: (value: string, prompt: InteractivePrompt) => void;
}

function PlanChoiceDock({ visible, prompt, disabled = false, onSelect }: PlanChoiceDockProps) {
  if (!visible || !prompt || prompt.options.length === 0) return null;

  return (
    <div className={`${styles.planChoiceDock} ${styles.composerDockCard}`}>
      <div className={styles.planChoiceDockTitle}>{prompt.question}</div>
      <div className={styles.planChoiceDockOptions}>
        {prompt.options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={styles.planChoiceDockOption}
            disabled={disabled}
            onClick={() => onSelect(option.value, prompt)}
          >
            <span className={styles.planChoiceDockIndex}>{option.value}</span>
            <span className={styles.planChoiceDockCopy}>
              <strong>{option.title}</strong>
              {option.description ? <span>{option.description}</span> : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default memo(PlanChoiceDock);
