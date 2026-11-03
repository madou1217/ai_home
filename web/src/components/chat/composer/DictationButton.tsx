import { AudioOutlined } from '@ant-design/icons';
import styles from './dictation.module.css';

interface Props {
  readonly onClick: () => void;
}

export default function DictationButton({ onClick }: Props) {
  return (
    <button
      type="button"
      className={styles.micIdleBtn}
      title="语音听写"
      aria-label="语音听写"
      onClick={onClick}
    >
      <AudioOutlined style={{ fontSize: 16 }} />
    </button>
  );
}
