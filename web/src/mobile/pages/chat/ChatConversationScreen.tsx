import { useState } from 'react';
import {
  DeleteOutlined,
  InboxOutlined,
  LeftOutlined,
  MoreOutlined,
  PlusOutlined,
  PushpinFilled,
  PushpinOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import ProviderIcon from '@/components/chat/ProviderIcon';
import { IN_SESSION_SEARCH_OPEN_EVENT } from '@/components/chat/chat-global-shortcuts';
import { getProviderLabel, providerAccentStyle } from '@/components/chat/provider-registry';
import { DetailSheet, HudIconButton, KeyValue } from '@/mobile/ui';
import { ChatConversationContent } from '@/pages/chat-page-state';
import type { ChatPageState } from '@/pages/chat-page-state';
import type { MobileChatSessions } from './use-mobile-chat-sessions';
import styles from './mobile-chat.module.css';

interface Props {
  state: ChatPageState;
  sessions: MobileChatSessions;
}

/**
 * 屏 2：对话（沉浸态，顶栏与底部导航由 body[data-mobile-immersive] 隐藏）。
 * 自带紧凑 HUD 头部 + 安全区；对话区直接复用聊天运行时（canonical / legacy / workbench，mobile=true）。
 * 与原移动端两屏栈一致：对话屏常驻挂载（离屏时隐藏 + inert），返回列表不打断运行中的会话。
 */
export default function ChatConversationScreen({ state, sessions }: Props) {
  const {
    mobileShowChat,
    projectCatalog,
    accountCatalog,
    selectedModel,
    selectedSessionRunning,
    projectLabel,
    workspaceMode,
    navigation,
    handleCreateSession,
  } = state;
  const [sheetOpen, setSheetOpen] = useState(false);
  const session = projectCatalog.selectedSession;
  const project = projectCatalog.selectedProject;
  const account = accountCatalog.selectedAccount;
  const model = selectedModel || session?.model || '';
  const chatSession = session?.mode === 'chat' || (!session && workspaceMode === 'chat');
  const persisted = Boolean(session && !session.draft);
  // 置顶 / 删除只作用于纯聊天列表里真实存在的会话（与桌面列表行操作同一数据源）
  const listedChatSession = Boolean(session && chatSession && sessions.chatSessions.some((item) => item.id === session.id));
  const pinned = session ? sessions.pinnedSessionIds.has(session.id) : false;
  const archive = session && !chatSession ? sessions.archiveAction(session) : null;
  const statusTone = selectedSessionRunning ? 'ok' : session?.draft ? 'warn' : 'info';
  const statusText = selectedSessionRunning ? 'RUNNING' : session?.draft ? 'DRAFT' : 'IDLE';

  const closeSheetThen = (action: () => void) => () => {
    setSheetOpen(false);
    action();
  };

  const infoRows = session ? [
    { key: 'state', label: '状态', value: statusText, tone: statusTone as 'ok' | 'warn' | 'info' },
    { key: 'mode', label: '模式', value: chatSession ? 'CHAT · 纯聊天' : 'WORK · 工作区' },
    { key: 'provider', label: '提供方', value: getProviderLabel(session.provider) },
    { key: 'model', label: '模型', value: model || '—' },
    {
      key: 'account',
      label: '账号',
      value: account ? (account.displayName || account.email || (account.gateway ? '网关' : account.accountRef)) : '—',
    },
    ...(!chatSession ? [{
      key: 'project',
      label: '项目',
      value: project ? project.path : (session.projectPath || projectLabel),
    }] : []),
    ...(persisted ? [
      { key: 'updated', label: '更新', value: dayjs(session.updatedAt).fromNow() },
      { key: 'id', label: '会话 ID', value: session.id },
    ] : []),
    ...(archive?.visible && archive.disabled ? [{
      key: 'archive',
      label: '原生归档',
      value: `不可用：${archive.reason}`,
      tone: 'muted' as const,
    }] : []),
  ] : [];

  return (
    <>
      <section
        className={`${styles.convo}${mobileShowChat ? ` ${styles.convoOpen}` : ''}`}
        style={providerAccentStyle(session?.provider)}
        aria-hidden={!mobileShowChat}
        aria-label="会话对话"
        {...(!mobileShowChat ? { inert: '' } : {})}
        onTouchStart={navigation.touchStart}
        onTouchEnd={navigation.touchEnd}
      >
        <header className={styles.convoHead}>
          <HudIconButton icon={<LeftOutlined />} label="返回会话列表" onClick={navigation.back} />
          <div className={styles.convoTitles}>
            <span className={styles.convoTitle}>{session?.title || projectLabel}</span>
            <span className={styles.convoMeta}>
              <span
                className={`hud-led hud-led--${statusTone}${selectedSessionRunning ? ' hud-led--live' : ''}`}
                aria-hidden="true"
              />
              {session?.provider ? (
                <span className={styles.convoProvider}>
                  <ProviderIcon provider={session.provider} size={12} />
                  {getProviderLabel(session.provider)}
                </span>
              ) : null}
              {model ? <span className={styles.convoModel}>{model}</span> : null}
            </span>
          </div>
          <HudIconButton
            icon={<SearchOutlined />}
            label="会话内搜索"
            onClick={() => window.dispatchEvent(new Event(IN_SESSION_SEARCH_OPEN_EVENT))}
          />
          <HudIconButton icon={<MoreOutlined />} label="会话详情与操作" onClick={() => setSheetOpen(true)} />
        </header>
        <div className={styles.convoBody}>
          <ChatConversationContent state={state} canonicalFrameClassName={styles.canonicalFrame} />
        </div>
      </section>

      <DetailSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        code="SESSION"
        title={session?.title || projectLabel}
        footer={(
          <div className={styles.sheetPrimary}>
            <HudIconButton
              icon={<PlusOutlined />}
              label={workspaceMode === 'chat' ? '发起新对话' : '新建工作区会话'}
              tone="primary"
              showLabel
              onClick={closeSheetThen(handleCreateSession)}
            />
          </div>
        )}
      >
        {session ? <KeyValue rows={infoRows} /> : (
          <p className={styles.sheetNote}>当前没有打开的会话。</p>
        )}
        {session && persisted ? (
          <div className={styles.sheetActions}>
            {listedChatSession ? (
              <>
                <HudIconButton
                  icon={pinned ? <PushpinFilled /> : <PushpinOutlined />}
                  label={pinned ? '取消置顶' : '置顶会话'}
                  showLabel
                  onClick={() => sessions.togglePin(session.id)}
                />
                <HudIconButton
                  icon={<DeleteOutlined />}
                  label="删除对话"
                  tone="danger"
                  showLabel
                  onClick={closeSheetThen(() => { void sessions.deleteChatSession(session); })}
                />
              </>
            ) : !chatSession && archive?.visible ? (
              <HudIconButton
                icon={<InboxOutlined />}
                label="原生归档"
                showLabel
                disabled={archive.disabled}
                onClick={closeSheetThen(() => { void sessions.archiveSession(session); })}
              />
            ) : null}
          </div>
        ) : null}
      </DetailSheet>
    </>
  );
}
