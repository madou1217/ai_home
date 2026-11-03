import { useState } from 'react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import type { MobilePageProps } from '../mobile-routes';
import { useChatPageState } from '@/pages/chat-page-state';
import ArchivedSessionsSheet from './chat/ArchivedSessionsSheet';
import ChatConversationScreen from './chat/ChatConversationScreen';
import ChatSessionList from './chat/ChatSessionList';
import { useMobileChatSessions } from './chat/use-mobile-chat-sessions';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

/**
 * /chat 移动端 HUD：两屏栈。
 * - 屏 1 会话列表（CHAT/WORK 芯片、等宽列表 + 左滑置顶/删除/归档/移除项目、拇指区新建）。
 * - 屏 2 对话（沉浸态，自带 HUD 头部，复用聊天运行时引擎）。
 * 页面级状态与桌面 Chat.tsx 共用 useChatPageState（同一套目录/账号/恢复/深链/新建逻辑）。
 */
export default function MobileChat(_props: MobilePageProps) {
  const state = useChatPageState(true);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const sessions = useMobileChatSessions({
    mode: state.workspaceMode,
    selectedSession: state.projectCatalog.selectedSession,
    runningSessionKeys: state.runningSessionKeys,
    onRefreshDirectory: state.refreshProjectList,
    onCreateSession: state.handleCreateSession,
    onProjectRemoved: state.handleProjectRemoved,
  });

  return (
    <>
      <div hidden={state.mobileShowChat}>
        <ChatSessionList state={state} sessions={sessions} onOpenArchived={() => setArchivedOpen(true)} />
      </div>
      <ChatConversationScreen state={state} sessions={sessions} />
      <ArchivedSessionsSheet
        open={archivedOpen}
        onClose={() => setArchivedOpen(false)}
        onRestored={state.refreshProjectList}
      />
      {state.dialogs.node}
    </>
  );
}
