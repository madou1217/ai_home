import styles from './dictation.module.css';

interface Props {
  readonly elapsedSeconds: number;
  readonly onStop: () => void;
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export default function DictationRecordingBar({ elapsedSeconds, onStop }: Props) {
  return (
    <div className={styles.recordingBar}>
      <span className={styles.recordingPulseLine} aria-hidden="true" />
      <span className={styles.recordingTimer}>{formatElapsed(elapsedSeconds)}</span>
      <button
        type="button"
        className={styles.stopDictationBtn}
        onClick={onStop}
        title="停止听写"
        aria-label="停止听写"
      >
        <span className={styles.stopDictationGlyph} aria-hidden="true" />
      </button>
    </div>
  );
}
