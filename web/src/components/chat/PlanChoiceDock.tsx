import { memo, useRef } from 'react';
import { useCollapsePresence } from '@/hooks/use-collapse-presence';
import styles from './composer/composer.module.css';
import type { InteractivePrompt, InteractivePromptOption } from '@/types';

export type PlanChoiceDockOption = InteractivePromptOption;

interface PlanChoiceDockProps {
  visible: boolean;
  prompt: InteractivePrompt | null;
  disabled?: boolean;
  onSelect: (value: string, prompt: InteractivePrompt) => void;
}

const DOCK_EXIT_MS = 160;

function PlanChoiceDock({ visible, prompt, disabled = false, onSelect }: PlanChoiceDockProps) {
  const active = Boolean(visible && prompt && prompt.options.length > 0);
  // 选择后 prompt 立刻被清空，退场期间继续展示最后一次的选项
  const lastPromptRef = useRef<InteractivePrompt | null>(prompt);
  if (active && prompt) lastPromptRef.current = prompt;
  const { present } = useCollapsePresence(active, DOCK_EXIT_MS);
  const current = active ? prompt : lastPromptRef.current;

  if (!present || !current || current.options.length === 0) return null;

  return (
    <div
      className={`${styles.planChoiceDock} ${styles.composerDockCard}${active ? '' : ` ${styles.planChoiceDockClosing}`}`}
      data-state={active ? 'open' : 'closing'}
      aria-hidden={active ? undefined : true}
    >
      <div className={styles.planChoiceDockTitle}>{current.question}</div>
      <div className={styles.planChoiceDockOptions}>
        {current.options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={styles.planChoiceDockOption}
            disabled={active ? disabled : true}
            onClick={() => onSelect(option.value, current)}
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
