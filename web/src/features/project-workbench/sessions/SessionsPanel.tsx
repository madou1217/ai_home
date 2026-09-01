import { Empty } from 'antd';
import dayjs from 'dayjs';
import ProviderIcon from '@/components/chat/ProviderIcon';
import { providerAccentStyle } from '@/components/chat/provider-registry';
import {
  getSessionRunKey,
  isSameSession,
  isSessionRunning,
} from '@/components/chat/project-runtime-state.js';
import type { Session } from '@/types';
import chatStyles from '@/components/chat/session-list.module.css';
import styles from '../project-workbench.module.css';

interface Props {
  sessions: readonly Session[];
  selectedSession: Session | null;
  runningSessionKeys?: Set<string>;
  onSelectSession: (session: Session) => void;
}

// 左栏 Sessions 页签：当前项目会话的只读列表，点击切换中栏会话。
// 行样式复用会话侧边栏（session-list.module.css 的 sessionItem 系列），不重造。
export default function SessionsPanel({ sessions, selectedSession, runningSessionKeys, onSelectSession }: Props) {
  if (sessions.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无会话" />;
  }
  return (
    <div className={styles.sessionsPanel}>
      {sessions.map((session) => {
        const isRunning = isSessionRunning(session, runningSessionKeys);
        return (
          <div
            key={getSessionRunKey(session)}
            className={`${chatStyles.sessionItem} ${
              isSameSession(selectedSession, session) ? chatStyles.sessionItemActive : ''
            } ${isRunning ? chatStyles.sessionItemRunning : ''}`}
            onClick={() => onSelectSession(session)}
          >
            <div className={chatStyles.sessionHeader}>
              <span
                className={`${chatStyles.sessionProviderSlot} ${
                  isRunning ? chatStyles.sessionProviderSlotRunning : ''
                }`}
                style={providerAccentStyle(session.provider)}
              >
                <ProviderIcon provider={session.provider} size={14} />
              </span>
              <span className={chatStyles.sessionTitle}>{session.title || '新会话'}</span>
            </div>
            <span className={chatStyles.sessionTime}>
              {isRunning ? '进行中' : dayjs(session.updatedAt).fromNow()}
            </span>
          </div>
        );
      })}
    </div>
  );
}
