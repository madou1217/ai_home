import React from 'react';
import { MessageOutlined, CodeOutlined } from '@ant-design/icons';
import styles from './chat.module.css';

export type WorkspaceMode = 'chat' | 'work';

interface Props {
  mode: WorkspaceMode;
  onChange: (mode: WorkspaceMode) => void;
  mobile?: boolean;
}

export default function ModeSelector({ mode, onChange, mobile = false }: Props) {
  return (
    <div className={`${styles.modeSelector} ${mobile ? styles.modeSelectorMobile : ''}`}>
      <button
        type="button"
        className={`${styles.modeTab} ${mode === 'chat' ? styles.modeTabActive : ''}`}
        onClick={() => onChange('chat')}
      >
        <MessageOutlined className={styles.modeIcon} />
        <span>Chat</span>
      </button>
      <button
        type="button"
        className={`${styles.modeTab} ${mode === 'work' ? styles.modeTabActive : ''}`}
        onClick={() => onChange('work')}
      >
        <CodeOutlined className={styles.modeIcon} />
        <span>Work</span>
      </button>
    </div>
  );
}
