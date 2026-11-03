import { memo } from 'react';
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

export const DictationRecordingBar = memo(function DictationRecordingBar({
  elapsedSeconds,
  onStop,
}: Props) {
  return (
    <div className={styles.recordingCapsuleHarmony} role="status" aria-label="正在录音">
      <div className={styles.recordingLiveDotHarmony} aria-hidden="true" />
      {/* 鸿蒙 6 胶囊律动动态音频声波条 */}
      <div className={styles.recordingWaveformHarmony} aria-hidden="true">
        <span className={`${styles.waveBar} ${styles.waveBar1}`} />
        <span className={`${styles.waveBar} ${styles.waveBar2}`} />
        <span className={`${styles.waveBar} ${styles.waveBar3}`} />
        <span className={`${styles.waveBar} ${styles.waveBar4}`} />
        <span className={`${styles.waveBar} ${styles.waveBar5}`} />
        <span className={`${styles.waveBar} ${styles.waveBar6}`} />
      </div>
      <span className={styles.recordingTimerHarmony}>{formatElapsed(elapsedSeconds)}</span>
      <button
        type="button"
        className={styles.stopDictationBtnHarmony}
        onClick={onStop}
        title="完成语音录入"
        aria-label="停止并完成录音"
      >
        <span className={styles.stopGlyphHarmony} aria-hidden="true" />
      </button>
    </div>
  );
});

export default DictationRecordingBar;
