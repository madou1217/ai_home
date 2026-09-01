import React, { memo } from 'react';
import { MessageOutlined, CodeOutlined } from '@ant-design/icons';
import styles from './composer/composer.module.css';

export type WorkspaceMode = 'chat' | 'work';

interface Props {
  mode: WorkspaceMode;
  onChange: (mode: WorkspaceMode) => void;
  mobile?: boolean;
}

export const ModeSelector = memo(function ModeSelector({ mode, onChange, mobile = false }: Props) {
  return (
    <div className={`${styles.modeSelectorContainer} ${mobile ? styles.modeSelectorMobile : ''}`}>
      <button
        type="button"
        className={`${styles.modeOptionBtn} ${mode === 'chat' ? styles.modeOptionBtnActive : ''}`}
        onClick={() => onChange('chat')}
        aria-label="纯聊天模式"
      >
        <MessageOutlined />
        <span>Chat</span>
      </button>
      <button
        type="button"
        className={`${styles.modeOptionBtn} ${mode === 'work' ? styles.modeOptionBtnActive : ''}`}
        onClick={() => onChange('work')}
        aria-label="工作区项目模式"
      >
        <CodeOutlined />
        <span>Work</span>
      </button>
    </div>
  );
});

export default ModeSelector;
