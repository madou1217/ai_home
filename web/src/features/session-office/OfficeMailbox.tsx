import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import {
  ApartmentOutlined,
  BranchesOutlined,
  CheckOutlined,
  CloseCircleOutlined,
  CodeOutlined,
  CopyOutlined,
  DesktopOutlined,
  EnvironmentOutlined,
  ExclamationCircleOutlined,
  EyeOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  HistoryOutlined,
  InboxOutlined,
  LockOutlined,
  MailOutlined,
  ReloadOutlined,
  RollbackOutlined,
  SendOutlined,
  SwapOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Button, Input, Tag, Tooltip, message } from 'antd';
import HudStateView from '@/components/hud/HudStateView';
import { writeClipboardText } from '@/utils/clipboard';
import { buildSessionMailboxView, formatOfficeTimestamp } from './session-office-model';
import type {
  EnrichedPeerMessage,
  MailboxFolder,
  MailboxScope,
  OfficeProjectRoom,
  OfficeSessionItem,
  PeerCounts,
  PeerDeliveryState,
  PeerThreadGroup,
  ResolvedPeerEndpoint,
} from './session-office-types';
import './OfficeMailbox.css';

export interface OfficeMailboxProps {
  scope: MailboxScope;
  onScopeChange: (scope: MailboxScope) => void;
  focusedSession: OfficeSessionItem | null;
  activeRoom: OfficeProjectRoom | null;
  allRooms: OfficeProjectRoom[];
  allMessages: EnrichedPeerMessage[];
  unassignedMessages: EnrichedPeerMessage[];
  fullyUnassignedCount: number;
  counts: PeerCounts;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onJumpToSession?: (sessionKey: string, projectKey?: string | null) => void;
  initialFolder?: MailboxFolder;
  initialMessageId?: string | null;
  compactHeader?: boolean;
}

type BodyRenderMode = 'prose' | 'mono';
type CliCommandMode = 'reply' | 'send';

interface DeliveryStateMeta {
  label: string;
  shortLabel: string;
  ledTone: 'ok' | 'warn' | 'info' | 'err' | 'neutral';
  pillTone: 'success' | 'warning' | 'info' | 'danger' | 'neutral';
}

interface MatchBasisMeta {
  label: string;
  shortLabel: string;
  tone: 'success' | 'info' | 'warning';
}

const FOLDER_ITEMS: ReadonlyArray<{
  key: MailboxFolder;
  label: string;
  icon: typeof InboxOutlined;
}> = [
  { key: 'inbox', label: '收件箱', icon: InboxOutlined },
  { key: 'sent', label: '已发送', icon: SendOutlined },
  { key: 'all', label: '全部往来', icon: MailOutlined },
  { key: 'threads', label: '会话串', icon: BranchesOutlined },
];

const STATE_FILTER_ITEMS: ReadonlyArray<{
  key: string;
  label: string;
  ledTone?: 'warn' | 'info' | 'ok' | 'err';
}> = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待投递', ledTone: 'warn' },
  { key: 'delivered', label: '已送达', ledTone: 'info' },
  { key: 'read', label: '已读', ledTone: 'ok' },
  { key: 'failed', label: '投递失败', ledTone: 'err' },
];

function getDeliveryStateMeta(state: PeerDeliveryState): DeliveryStateMeta {
  switch (state) {
    case 'pending':
      return { label: '待投递', shortLabel: '待投递', ledTone: 'warn', pillTone: 'warning' };
    case 'delivered':
      return { label: '已送达', shortLabel: '已送达', ledTone: 'info', pillTone: 'info' };
    case 'read':
      return { label: '已读', shortLabel: '已读', ledTone: 'ok', pillTone: 'success' };
    case 'failed':
      return { label: '投递失败', shortLabel: '失败', ledTone: 'err', pillTone: 'danger' };
    default:
      return {
        label: state || '未知',
        shortLabel: state || '未知',
        ledTone: 'neutral',
        pillTone: 'neutral',
      };
  }
}

function getMatchBasisMeta(basis: ResolvedPeerEndpoint['matchBasis']): MatchBasisMeta {
  switch (basis) {
    case 'nativeSessionId':
      return {
        label: 'matchBasis: nativeSessionId（精确匹配活跃原生会话）',
        shortLabel: 'nativeSessionId',
        tone: 'success',
      };
    case 'sessionKey':
      return {
        label: 'matchBasis: sessionKey（精确匹配控制台会话键）',
        shortLabel: 'sessionKey',
        tone: 'success',
      };
    case 'scopedName':
      return {
        label: 'matchBasis: scopedName（按项目作用域名称关联）',
        shortLabel: 'scopedName',
        tone: 'info',
      };
    case 'unresolved':
    default:
      return {
        label: '未解析 · 外部或历史会话端点（未强行猜测归属）',
        shortLabel: '未解析·外部或历史',
        tone: 'warning',
      };
  }
}

function shellQuoteArg(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '""';
  if (/^[a-zA-Z0-9._:/@-]+$/.test(trimmed)) return trimmed;
  return `'${trimmed.replace(/'/g, "'\\''")}'`;
}

function resolveReplyPeerTarget(
  msg: EnrichedPeerMessage,
  focusedSession: OfficeSessionItem | null,
): string {
  const isOutgoingFromFocused = Boolean(
    focusedSession &&
      msg.fromResolved.sessionKey === focusedSession.sessionKey &&
      msg.toResolved.sessionKey !== focusedSession.sessionKey,
  );
  const party = isOutgoingFromFocused ? msg.raw.to : msg.raw.from;
  const fallbackSessionKey = isOutgoingFromFocused
    ? msg.toResolved.sessionKey
    : msg.fromResolved.sessionKey;
  return (
    party.address ||
    party.name ||
    party.sessionId ||
    fallbackSessionKey ||
    ''
  ).trim();
}

function buildCliHelperCommand(
  msg: EnrichedPeerMessage,
  mode: CliCommandMode,
  focusedSession: OfficeSessionItem | null,
): string {
  if (mode === 'send') {
    const target = resolveReplyPeerTarget(msg, focusedSession);
    if (target) {
      return `aih peer send --to ${shellQuoteArg(target)} "..."`;
    }
  }
  const replyId = msg.shortId || msg.id;
  return `aih peer reply ${shellQuoteArg(replyId)} "..."`;
}

function findEndpointRoom(
  endpoint: ResolvedPeerEndpoint,
  allRooms: OfficeProjectRoom[],
): OfficeProjectRoom | null {
  if (endpoint.projectKey) {
    const byProject = allRooms.find((room) => room.projectKey === endpoint.projectKey);
    if (byProject) return byProject;
  }
  if (endpoint.sessionKey) {
    const bySession = allRooms.find((room) =>
      room.sessions.some((session) => session.sessionKey === endpoint.sessionKey),
    );
    if (bySession) return bySession;
  }
  return null;
}

function getDirectionIndicator(
  msg: EnrichedPeerMessage,
  focusedSession: OfficeSessionItem | null,
): { code: 'self' | 'in' | 'out' | null; label: string } {
  if (!focusedSession) return { code: null, label: '' };
  const fromMe = msg.fromResolved.sessionKey === focusedSession.sessionKey;
  const toMe = msg.toResolved.sessionKey === focusedSession.sessionKey;
  if (fromMe && toMe) return { code: 'self', label: '自发' };
  if (toMe) return { code: 'in', label: '收' };
  if (fromMe) return { code: 'out', label: '发' };
  return { code: null, label: '' };
}

function getCombinedDeliveryError(msg: EnrichedPeerMessage): string {
  const parts = [msg.raw.error, msg.raw.lastAttemptError, msg.raw.receiptError]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  return [...new Set(parts)].join(' · ');
}

interface PartyMetaCardProps {
  roleLabel: '发件方 FROM' | '收件方 TO';
  endpoint: ResolvedPeerEndpoint;
  allRooms: OfficeProjectRoom[];
  focusedSession: OfficeSessionItem | null;
  activeRoom: OfficeProjectRoom | null;
  onJumpToSession?: (sessionKey: string, projectKey?: string | null) => void;
}

const PartyMetaCard: FC<PartyMetaCardProps> = ({
  roleLabel,
  endpoint,
  allRooms,
  focusedSession,
  activeRoom,
  onJumpToSession,
}) => {
  const basisMeta = getMatchBasisMeta(endpoint.matchBasis);
  const matchedRoom = useMemo(
    () => findEndpointRoom(endpoint, allRooms),
    [allRooms, endpoint],
  );
  const resolvedProjectName =
    endpoint.projectName || matchedRoom?.projectName || '';
  const resolvedProjectPath =
    endpoint.projectPath || matchedRoom?.projectPath || '';
  const resolvedSessionId = endpoint.party.sessionId || endpoint.sessionId || '';
  const partyAddress =
    endpoint.party.address && endpoint.party.address !== endpoint.party.name
      ? endpoint.party.address
      : '';
  const isCurrentDesk = Boolean(
    focusedSession?.sessionKey &&
      endpoint.sessionKey &&
      focusedSession.sessionKey === endpoint.sessionKey,
  );
  const isCrossRoomJump = Boolean(
    endpoint.projectKey &&
      activeRoom?.projectKey &&
      endpoint.projectKey !== activeRoom.projectKey,
  );

  return (
    <section className="office-mailbox-party-card" aria-label={roleLabel}>
      <div className="office-mailbox-party-head">
        <span className="office-mailbox-party-role">
          <UserOutlined aria-hidden="true" />
          {roleLabel}
        </span>
        <Tooltip title={basisMeta.label}>
          <span
            className={`office-mailbox-basis-pill office-mailbox-basis-pill--${basisMeta.tone}`}
          >
            {basisMeta.shortLabel}
          </span>
        </Tooltip>
      </div>

      <div className="office-mailbox-party-identity">
        <strong className="office-mailbox-party-name" title={endpoint.displayName}>
          {endpoint.displayName || '-'}
        </strong>
        {endpoint.sessionLabel && endpoint.sessionLabel !== endpoint.displayName ? (
          <span className="office-mailbox-party-sub" title={endpoint.sessionLabel}>
            工位标签: {endpoint.sessionLabel}
          </span>
        ) : null}
      </div>

      <dl className="office-mailbox-party-meta">
        <div>
          <dt>渠道</dt>
          <dd>{endpoint.party.channel || '-'}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{endpoint.party.provider || '-'}</dd>
        </div>
        <div>
          <dt>名称 / 地址</dt>
          <dd title={[endpoint.party.name, partyAddress].filter(Boolean).join(' · ')}>
            {endpoint.party.name || '-'}
            {partyAddress ? ` (${partyAddress})` : ''}
          </dd>
        </div>
        <div>
          <dt>Session ID</dt>
          <dd className="office-mailbox-mono" title={resolvedSessionId || '无'}>
            {resolvedSessionId || '未提供'}
          </dd>
        </div>
        {endpoint.sessionKey ? (
          <div>
            <dt>Session Key</dt>
            <dd className="office-mailbox-mono" title={endpoint.sessionKey}>
              {endpoint.sessionKey}
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="office-mailbox-party-foot">
        {resolvedProjectName || resolvedProjectPath ? (
          <Tooltip title={resolvedProjectPath || resolvedProjectName}>
            <span className="office-mailbox-project-badge">
              <FolderOpenOutlined aria-hidden="true" />
              <span>{resolvedProjectName || resolvedProjectPath}</span>
            </span>
          </Tooltip>
        ) : (
          <span className="office-mailbox-project-badge office-mailbox-project-badge--muted">
            <HistoryOutlined aria-hidden="true" />
            <span>
              {endpoint.isExternalOrHistorical ? '外部或历史端点' : '未归属项目'}
            </span>
          </span>
        )}

        {endpoint.sessionKey && onJumpToSession ? (
          <Tooltip
            title={
              isCurrentDesk
                ? '当前已聚焦在该工位'
                : `跳转到 ${resolvedProjectName || '对应房间'} 的该工位桌面`
            }
          >
            <Button
              size="small"
              type="default"
              disabled={isCurrentDesk}
              icon={
                isCrossRoomJump ? (
                  <EnvironmentOutlined />
                ) : (
                  <DesktopOutlined />
                )
              }
              onClick={(event) => {
                event.stopPropagation();
                onJumpToSession(endpoint.sessionKey!, endpoint.projectKey);
              }}
            >
              {isCurrentDesk ? '当前工位' : isCrossRoomJump ? '跳转对方工位' : '前往工位'}
            </Button>
          </Tooltip>
        ) : null}
      </div>
    </section>
  );
};

interface MailDetailArticleProps {
  messageItem: EnrichedPeerMessage;
  allMessages: EnrichedPeerMessage[];
  allRooms: OfficeProjectRoom[];
  focusedSession: OfficeSessionItem | null;
  activeRoom: OfficeProjectRoom | null;
  bodyMode: BodyRenderMode;
  onBodyModeChange: (mode: BodyRenderMode) => void;
  copiedKey: string | null;
  onCopy: (key: string, text: string, successLabel: string) => void;
  onJumpToMessage: (targetMessage: EnrichedPeerMessage) => void;
  onJumpToSession?: (sessionKey: string, projectKey?: string | null) => void;
  onOpenThread?: (threadRootId: string) => void;
  isThreadCard?: boolean;
  isActiveInThread?: boolean;
  onSelectInThread?: (messageId: string) => void;
}

const MailDetailArticle: FC<MailDetailArticleProps> = ({
  messageItem,
  allMessages,
  allRooms,
  focusedSession,
  activeRoom,
  bodyMode,
  onBodyModeChange,
  copiedKey,
  onCopy,
  onJumpToMessage,
  onJumpToSession,
  onOpenThread,
  isThreadCard = false,
  isActiveInThread = false,
  onSelectInThread,
}) => {
  const stateMeta = getDeliveryStateMeta(messageItem.raw.state);
  const deliveryError = getCombinedDeliveryError(messageItem);

  const parentMessage = useMemo(() => {
    const targetId = messageItem.raw.replyTo;
    const targetShort = messageItem.raw.replyToShort;
    if (!targetId && !targetShort) return null;
    return (
      allMessages.find(
        (candidate) =>
          (targetId && candidate.id === targetId) ||
          (targetShort && candidate.shortId === targetShort),
      ) ?? null
    );
  }, [allMessages, messageItem.raw.replyTo, messageItem.raw.replyToShort]);

  const threadSiblingCount = useMemo(() => {
    if (!messageItem.threadRootId || isThreadCard) return 0;
    return allMessages.filter(
      (candidate) => candidate.threadRootId === messageItem.threadRootId,
    ).length;
  }, [allMessages, isThreadCard, messageItem.threadRootId]);

  const idCopyKey = `id:${messageItem.id}`;
  const bodyCopyKey = `body:${messageItem.id}`;

  return (
    <article
      className="office-mailbox-article"
      data-thread-card={isThreadCard ? 'true' : undefined}
      data-active={isActiveInThread ? 'true' : undefined}
      onClick={
        isThreadCard && onSelectInThread
          ? () => onSelectInThread(messageItem.id)
          : undefined
      }
    >
      <header className="office-mailbox-article-head">
        <div className="office-mailbox-subject-row">
          {isThreadCard ? (
            <h3 className="office-mailbox-thread-card-title">
              {messageItem.fromResolved.displayName} → {messageItem.toResolved.displayName}
            </h3>
          ) : (
            <h2 className="office-mailbox-subject">
              {messageItem.subjectLine || '(无正文主题)'}
            </h2>
          )}

          <div className="office-mailbox-head-actions">
            <Tooltip title={`完整消息 ID: ${messageItem.id}`}>
              <span className="office-mailbox-short-id">
                #{messageItem.shortId || messageItem.id.slice(0, 8)}
              </span>
            </Tooltip>
            <Button
              size="small"
              type="text"
              icon={copiedKey === idCopyKey ? <CheckOutlined /> : <CopyOutlined />}
              onClick={(event) => {
                event.stopPropagation();
                onCopy(idCopyKey, messageItem.id, '消息 ID 已复制');
              }}
            >
              {copiedKey === idCopyKey ? '已复制 ID' : '复制 ID'}
            </Button>
          </div>
        </div>

        <div className="office-mailbox-meta-badges">
          <span
            className={`office-mailbox-state-pill office-mailbox-state-pill--${stateMeta.pillTone}`}
          >
            <span
              className={`hud-led hud-led--${stateMeta.ledTone === 'neutral' ? 'info' : stateMeta.ledTone}`}
              aria-hidden="true"
            />
            {stateMeta.label}
          </span>

          {messageItem.isCrossProject ? (
            <Tag icon={<SwapOutlined />} color="cyan">
              跨项目协作
            </Tag>
          ) : null}

          {messageItem.isFullyUnassigned ? (
            <Tag icon={<HistoryOutlined />} color="orange">
              完全未归属 / 历史
            </Tag>
          ) : messageItem.hasUnresolvedParty ? (
            <Tag icon={<HistoryOutlined />} color="gold">
              含未解析端点
            </Tag>
          ) : null}

          {messageItem.raw.replyTo || messageItem.raw.replyToShort ? (
            parentMessage ? (
              <Tooltip
                title={`点击跳转到父消息: ${parentMessage.subjectLine || parentMessage.shortId}`}
              >
                <Button
                  size="small"
                  type="link"
                  className="office-mailbox-reply-link"
                  icon={<RollbackOutlined />}
                  onClick={(event) => {
                    event.stopPropagation();
                    onJumpToMessage(parentMessage);
                  }}
                >
                  回复 #{messageItem.raw.replyToShort || parentMessage.shortId}
                </Button>
              </Tooltip>
            ) : (
              <Tooltip title="原父消息已不在当前内存队列中">
                <span className="office-mailbox-reply-missing">
                  <RollbackOutlined aria-hidden="true" /> 回复 #
                  {messageItem.raw.replyToShort || messageItem.raw.replyTo.slice(0, 8)}（不在当前队列）
                </span>
              </Tooltip>
            )
          ) : null}

          {!isThreadCard && threadSiblingCount > 1 && onOpenThread ? (
            <Button
              size="small"
              type="text"
              icon={<BranchesOutlined />}
              onClick={() => onOpenThread(messageItem.threadRootId)}
            >
              查看会话串 ({threadSiblingCount})
            </Button>
          ) : null}

          {isThreadCard && onSelectInThread ? (
            <button
              type="button"
              className="office-mailbox-thread-target-badge"
              aria-pressed={isActiveInThread}
              onClick={(event) => {
                event.stopPropagation();
                onSelectInThread(messageItem.id);
              }}
            >
              {isActiveInThread ? '当前 CLI 回复目标' : '设为 CLI 回复目标'}
            </button>
          ) : null}
        </div>
      </header>

      <div className="office-mailbox-parties">
        <PartyMetaCard
          roleLabel="发件方 FROM"
          endpoint={messageItem.fromResolved}
          allRooms={allRooms}
          focusedSession={focusedSession}
          activeRoom={activeRoom}
          onJumpToSession={onJumpToSession}
        />
        <PartyMetaCard
          roleLabel="收件方 TO"
          endpoint={messageItem.toResolved}
          allRooms={allRooms}
          focusedSession={focusedSession}
          activeRoom={activeRoom}
          onJumpToSession={onJumpToSession}
        />
      </div>

      <div className="office-mailbox-audit" aria-label="投递审计详情">
        <div className="office-mailbox-audit-grid">
          <div>
            <span>创建时间</span>
            <strong>{formatOfficeTimestamp(messageItem.raw.createdAt)}</strong>
          </div>
          <div>
            <span>送达时间</span>
            <strong>{formatOfficeTimestamp(messageItem.raw.deliveredAt)}</strong>
          </div>
          <div>
            <span>已读时间</span>
            <strong>{formatOfficeTimestamp(messageItem.raw.readAt)}</strong>
          </div>
          <div>
            <span>尝试次数</span>
            <strong>{messageItem.raw.attemptCount ?? 0}</strong>
          </div>
          <div>
            <span>下次重试</span>
            <strong>{formatOfficeTimestamp(messageItem.raw.nextAttemptAt)}</strong>
          </div>
        </div>

        {deliveryError ? (
          <div className="office-mailbox-delivery-error" role="status">
            <span className="hud-led hud-led--err" aria-hidden="true" />
            <ExclamationCircleOutlined aria-hidden="true" />
            <span className="office-mailbox-delivery-error-label">投递错误:</span>
            <span className="office-mailbox-delivery-error-text">{deliveryError}</span>
          </div>
        ) : null}
      </div>

      <div className="office-mailbox-body-panel">
        <div className="office-mailbox-body-toolbar">
          <span className="office-mailbox-body-title">
            <FileTextOutlined aria-hidden="true" />
            邮件正文
          </span>
          <div className="office-mailbox-body-controls">
            <div className="office-mailbox-mode-toggle" role="group" aria-label="正文排版模式">
              <button
                type="button"
                className="office-mailbox-mode-btn"
                data-active={bodyMode === 'prose' ? 'true' : undefined}
                aria-pressed={bodyMode === 'prose'}
                onClick={(event) => {
                  event.stopPropagation();
                  onBodyModeChange('prose');
                }}
              >
                阅读排版
              </button>
              <button
                type="button"
                className="office-mailbox-mode-btn"
                data-active={bodyMode === 'mono' ? 'true' : undefined}
                aria-pressed={bodyMode === 'mono'}
                onClick={(event) => {
                  event.stopPropagation();
                  onBodyModeChange('mono');
                }}
              >
                等宽原文
              </button>
            </div>
            <Button
              size="small"
              type="text"
              icon={copiedKey === bodyCopyKey ? <CheckOutlined /> : <CopyOutlined />}
              onClick={(event) => {
                event.stopPropagation();
                onCopy(
                  bodyCopyKey,
                  messageItem.raw.body || messageItem.normalizedBody,
                  '邮件正文已复制',
                );
              }}
            >
              {copiedKey === bodyCopyKey ? '已复制正文' : '复制正文'}
            </Button>
          </div>
        </div>

        <pre
          className="office-mailbox-body-content"
          data-mode={bodyMode}
        >
          {messageItem.raw.body || messageItem.normalizedBody || '(空正文)'}
        </pre>
      </div>
    </article>
  );
};

export const OfficeMailbox: FC<OfficeMailboxProps> = ({
  scope,
  onScopeChange,
  focusedSession,
  activeRoom,
  allRooms,
  allMessages,
  unassignedMessages,
  fullyUnassignedCount,
  counts,
  loading,
  error,
  onRefresh,
  onJumpToSession,
  initialFolder,
  initialMessageId,
  compactHeader = false,
}) => {
  const [folder, setFolder] = useState<MailboxFolder>(
    () => initialFolder ?? (scope === 'session' && focusedSession ? 'inbox' : 'all'),
  );
  const [stateFilter, setStateFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(
    () => initialMessageId ?? null,
  );
  const [pinnedMessageId, setPinnedMessageId] = useState<string | null>(
    () => initialMessageId ?? null,
  );
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [activeThreadMessageId, setActiveThreadMessageId] = useState<string | null>(null);
  const [bodyMode, setBodyMode] = useState<BodyRenderMode>('prose');
  const [cliMode, setCliMode] = useState<CliCommandMode>('reply');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (initialMessageId) {
      setSelectedMessageId(initialMessageId);
      setPinnedMessageId(initialMessageId);
    }
  }, [initialMessageId]);

  useEffect(() => {
    if (initialFolder) {
      setFolder(initialFolder);
    }
  }, [initialFolder]);

  const mailboxView = useMemo(
    () =>
      buildSessionMailboxView(
        allMessages,
        focusedSession,
        activeRoom,
        scope,
        folder,
        stateFilter,
        searchQuery,
      ),
    [activeRoom, allMessages, focusedSession, folder, scope, searchQuery, stateFilter],
  );

  const selectedMessage = useMemo(() => {
    if (folder === 'threads') return null;
    if (selectedMessageId) {
      const fromList = mailboxView.filteredMessages.find(
        (item) => item.id === selectedMessageId,
      );
      if (fromList) return fromList;
      if (pinnedMessageId === selectedMessageId) {
        const fromAll = allMessages.find((item) => item.id === selectedMessageId);
        if (fromAll) return fromAll;
      }
    }
    return mailboxView.filteredMessages[0] ?? null;
  }, [
    allMessages,
    folder,
    mailboxView.filteredMessages,
    pinnedMessageId,
    selectedMessageId,
  ]);

  const selectedThread = useMemo<PeerThreadGroup | null>(() => {
    if (folder !== 'threads') return null;
    if (selectedThreadId) {
      const matched = mailboxView.threads.find(
        (thread) => thread.threadId === selectedThreadId,
      );
      if (matched) return matched;
    }
    return mailboxView.threads[0] ?? null;
  }, [folder, mailboxView.threads, selectedThreadId]);

  const sortedThreadMessages = useMemo(() => {
    if (!selectedThread) return [];
    return [...selectedThread.messages].sort(
      (a, b) => a.raw.createdAt - b.raw.createdAt,
    );
  }, [selectedThread]);

  const activeThreadMessage = useMemo(() => {
    if (!sortedThreadMessages.length) return null;
    if (activeThreadMessageId) {
      const found = sortedThreadMessages.find((m) => m.id === activeThreadMessageId);
      if (found) return found;
    }
    return selectedThread?.latestMessage ?? sortedThreadMessages[sortedThreadMessages.length - 1] ?? null;
  }, [activeThreadMessageId, selectedThread, sortedThreadMessages]);

  const cliTargetMessage = folder === 'threads' ? activeThreadMessage : selectedMessage;

  const handleCopy = useCallback(
    async (key: string, value: string, successText: string) => {
      try {
        await writeClipboardText(value);
        setCopiedKey(key);
        message.success(successText);
        if (copyTimerRef.current !== null) {
          window.clearTimeout(copyTimerRef.current);
        }
        copyTimerRef.current = window.setTimeout(() => {
          setCopiedKey((current) => (current === key ? null : current));
          copyTimerRef.current = null;
        }, 1600);
      } catch (copyError: unknown) {
        const detail =
          copyError instanceof Error ? copyError.message : '无法写入剪贴板';
        message.error(`复制失败: ${detail}`);
      }
    },
    [],
  );

  const handleSelectScope = useCallback(
    (nextScope: MailboxScope) => {
      setPinnedMessageId(null);
      onScopeChange(nextScope);
    },
    [onScopeChange],
  );

  const handleSelectFolder = useCallback((nextFolder: MailboxFolder) => {
    setPinnedMessageId(null);
    setFolder(nextFolder);
  }, []);

  const handleSelectStateFilter = useCallback((nextState: string) => {
    setPinnedMessageId(null);
    setStateFilter((current) => (current === nextState && nextState !== 'all' ? 'all' : nextState));
  }, []);

  const handleResetFilters = useCallback(() => {
    setPinnedMessageId(null);
    setStateFilter('all');
    setSearchQuery('');
  }, []);

  const handleJumpToMessage = useCallback(
    (targetMessage: EnrichedPeerMessage) => {
      setPinnedMessageId(targetMessage.id);
      setSelectedMessageId(targetMessage.id);
      if (folder === 'threads') {
        setSelectedThreadId(targetMessage.threadRootId);
        setActiveThreadMessageId(targetMessage.id);
        return;
      }
      const inCurrentView = mailboxView.filteredMessages.some(
        (item) => item.id === targetMessage.id,
      );
      if (!inCurrentView) {
        setStateFilter('all');
        setSearchQuery('');
        setFolder('all');
        if (scope !== 'all') {
          onScopeChange('all');
        }
      }
    },
    [folder, mailboxView.filteredMessages, onScopeChange, scope],
  );

  const handleOpenThread = useCallback((threadRootId: string) => {
    setPinnedMessageId(null);
    setFolder('threads');
    setSelectedThreadId(threadRootId);
    setActiveThreadMessageId(null);
  }, []);

  const scopeOptions = useMemo(() => {
    const items: Array<{
      key: MailboxScope;
      label: string;
      icon: typeof DesktopOutlined;
      disabled?: boolean;
      tooltip?: string;
    }> = [];

    if (focusedSession || scope === 'session') {
      items.push({
        key: 'session',
        label: '当前工位',
        icon: DesktopOutlined,
        disabled: !focusedSession,
        tooltip: focusedSession
          ? `${focusedSession.shortLabel || focusedSession.label} (${focusedSession.projectName})`
          : '未聚焦具体工位',
      });
    }

    items.push({
      key: 'room',
      label: '当前房间',
      icon: ApartmentOutlined,
      disabled: !activeRoom,
      tooltip: activeRoom
        ? `${activeRoom.projectName} · ${activeRoom.roomMessages.length} 封关联邮件`
        : '当前未选择项目房间',
    });

    items.push({
      key: 'unassigned',
      label: `未归属 / 历史 (${unassignedMessages.length})`,
      icon: HistoryOutlined,
      tooltip: `含未解析端点 ${unassignedMessages.length} 封（其中完全未归属 ${fullyUnassignedCount} 封）`,
    });

    items.push({
      key: 'all',
      label: `全量消息 (${counts.total})`,
      icon: GlobalOutlined,
      tooltip: `当前服务器全部 ${counts.total} 封 Peer 消息`,
    });

    return items;
  }, [
    activeRoom,
    counts.total,
    focusedSession,
    fullyUnassignedCount,
    scope,
    unassignedMessages.length,
  ]);

  const scopeContextCaption = useMemo(() => {
    if (scope === 'session') {
      return focusedSession
        ? `工位: ${focusedSession.shortLabel || focusedSession.label}`
        : '当前未选中工位';
    }
    if (scope === 'room') {
      return activeRoom
        ? `房间: ${activeRoom.projectName} (${activeRoom.roomMessages.length})`
        : '未选择项目房间';
    }
    if (scope === 'unassigned') {
      const partialCount = Math.max(0, unassignedMessages.length - fullyUnassignedCount);
      return `完全未归属 ${fullyUnassignedCount} · 单端未解析 ${partialCount}`;
    }
    return `全量投递队列 (${counts.total})`;
  }, [
    activeRoom,
    counts.total,
    focusedSession,
    fullyUnassignedCount,
    scope,
    unassignedMessages.length,
  ]);

  const folderCounts: Record<MailboxFolder, number> = {
    inbox: mailboxView.inboxCount,
    sent: mailboxView.sentCount,
    all: mailboxView.allCount,
    threads: mailboxView.threadCount,
  };

  const visibleCount =
    folder === 'threads'
      ? mailboxView.threads.length
      : mailboxView.filteredMessages.length;

  const hasActiveFilter = stateFilter !== 'all' || searchQuery.trim().length > 0;
  const activeFolderLabel =
    FOLDER_ITEMS.find((item) => item.key === folder)?.label ?? '邮件';

  const cliSendTarget = cliTargetMessage
    ? resolveReplyPeerTarget(cliTargetMessage, focusedSession)
    : '';
  const effectiveCliMode: CliCommandMode =
    cliMode === 'send' && cliSendTarget ? 'send' : 'reply';

  const cliCommandText = useMemo(() => {
    if (!cliTargetMessage) return '';
    return buildCliHelperCommand(cliTargetMessage, effectiveCliMode, focusedSession);
  }, [cliTargetMessage, effectiveCliMode, focusedSession]);

  return (
    <section
      className={`office-mailbox${compactHeader ? ' office-mailbox--compact' : ''}`}
      aria-label="Peer 桌面邮箱"
    >
      <header className="office-mailbox-header">
        <div className="office-mailbox-toolbar-top">
          <div className="office-mailbox-brand-group">
            {!compactHeader ? (
              <div className="office-mailbox-title-wrap">
                <span className="office-mailbox-eyebrow">SYS // PEER MAILBOX</span>
                <h2 className="office-mailbox-title">
                  <MailOutlined aria-hidden="true" />
                  <span>Peer 协作邮箱</span>
                </h2>
              </div>
            ) : null}

            <div
              className="office-mailbox-scope-tabs"
              role="tablist"
              aria-label="邮箱作用域切换"
            >
              {scopeOptions.map((item) => {
                const Icon = item.icon;
                const active = scope === item.key;
                return (
                  <Tooltip key={item.key} title={item.tooltip}>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      disabled={item.disabled}
                      data-active={active ? 'true' : undefined}
                      className="office-mailbox-scope-btn"
                      onClick={() => handleSelectScope(item.key)}
                    >
                      <Icon aria-hidden="true" />
                      <span>{item.label}</span>
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          </div>

          <div className="office-mailbox-toolbar-actions">
            <Input.Search
              size="small"
              allowClear
              className="office-mailbox-search"
              aria-label="搜索邮件"
              placeholder="搜索正文、会话、项目、#ID…"
              value={searchQuery}
              onChange={(event) => {
                setPinnedMessageId(null);
                setSearchQuery(event.target.value);
              }}
              onSearch={(value) => {
                setPinnedMessageId(null);
                setSearchQuery(value);
              }}
            />
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={onRefresh}
            >
              刷新
            </Button>
          </div>
        </div>

        <div className="office-mailbox-status-bar">
          <div className="office-mailbox-summary-pills" aria-label="服务器投递计数摘要">
            <button
              type="button"
              className="office-mailbox-summary-pill"
              data-active={stateFilter === 'all' ? 'true' : undefined}
              aria-pressed={stateFilter === 'all'}
              onClick={() => handleSelectStateFilter('all')}
            >
              总 {counts.total}
            </button>
            <button
              type="button"
              className="office-mailbox-summary-pill office-mailbox-summary-pill--warn"
              data-active={stateFilter === 'pending' ? 'true' : undefined}
              aria-pressed={stateFilter === 'pending'}
              onClick={() => handleSelectStateFilter('pending')}
            >
              <span className="hud-led hud-led--warn" aria-hidden="true" />
              待投递 {counts.pending}
            </button>
            <button
              type="button"
              className="office-mailbox-summary-pill office-mailbox-summary-pill--info"
              data-active={stateFilter === 'delivered' ? 'true' : undefined}
              aria-pressed={stateFilter === 'delivered'}
              onClick={() => handleSelectStateFilter('delivered')}
            >
              <span className="hud-led hud-led--info" aria-hidden="true" />
              已送达 {counts.delivered}
            </button>
            <button
              type="button"
              className="office-mailbox-summary-pill office-mailbox-summary-pill--ok"
              data-active={stateFilter === 'read' ? 'true' : undefined}
              aria-pressed={stateFilter === 'read'}
              onClick={() => handleSelectStateFilter('read')}
            >
              <span className="hud-led hud-led--ok" aria-hidden="true" />
              已读 {counts.read}
            </button>
            <button
              type="button"
              className="office-mailbox-summary-pill office-mailbox-summary-pill--err"
              data-active={stateFilter === 'failed' ? 'true' : undefined}
              aria-pressed={stateFilter === 'failed'}
              onClick={() => handleSelectStateFilter('failed')}
            >
              <span className="hud-led hud-led--err" aria-hidden="true" />
              失败 {counts.failed}
            </button>
          </div>

          <div className="office-mailbox-status-right">
            <span className="office-mailbox-context-caption">{scopeContextCaption}</span>
            {loading && allMessages.length > 0 ? (
              <span className="office-mailbox-sync-pill" role="status">
                <span className="hud-led hud-led--info hud-led--live" aria-hidden="true" />
                同步中
              </span>
            ) : null}
            {error ? (
              <span className="office-mailbox-error-pill" role="alert" title={error}>
                <span className="hud-led hud-led--err" aria-hidden="true" />
                <span>{error}</span>
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <div className="office-mailbox-body">
        {/* Left Folder & Filter Rail */}
        <aside className="office-mailbox-rail" aria-label="文件夹与投递状态筛选">
          <div className="office-mailbox-rail-section">
            <div className="office-mailbox-rail-heading">文件夹</div>
            <nav className="office-mailbox-folder-list" aria-label="邮件文件夹">
              {FOLDER_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = folder === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    className="office-mailbox-folder-btn"
                    data-active={active ? 'true' : undefined}
                    aria-pressed={active}
                    onClick={() => handleSelectFolder(item.key)}
                  >
                    <span className="office-mailbox-folder-left">
                      <Icon aria-hidden="true" />
                      <span>{item.label}</span>
                    </span>
                    <span className="office-mailbox-folder-count">
                      {folderCounts[item.key]}
                    </span>
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="office-mailbox-rail-section">
            <div className="office-mailbox-rail-heading">投递状态</div>
            <div className="office-mailbox-filter-list" role="group" aria-label="按投递状态筛选">
              {STATE_FILTER_ITEMS.map((item) => {
                const active = stateFilter === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    className="office-mailbox-filter-btn"
                    data-active={active ? 'true' : undefined}
                    aria-pressed={active}
                    onClick={() => {
                      setPinnedMessageId(null);
                      setStateFilter(item.key);
                    }}
                  >
                    {item.ledTone ? (
                      <span
                        className={`hud-led hud-led--${item.ledTone}`}
                        aria-hidden="true"
                      />
                    ) : (
                      <EyeOutlined aria-hidden="true" />
                    )}
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="office-mailbox-readonly-note" role="note">
            <LockOutlined aria-hidden="true" />
            <span>后端只读 GET 队列 · 预览不改写已读/投递状态</span>
          </div>
        </aside>

        {/* Middle Mail / Thread List Pane */}
        <div className="office-mailbox-list-pane">
          <div className="office-mailbox-list-head">
            <span className="office-mailbox-list-title">
              {activeFolderLabel} · {visibleCount}
              {folder === 'threads' ? ' 组' : ' 封'}
            </span>
            {hasActiveFilter ? (
              <Button
                size="small"
                type="text"
                icon={<CloseCircleOutlined />}
                onClick={handleResetFilters}
              >
                清除筛选
              </Button>
            ) : null}
          </div>

          <div
            className="office-mailbox-list"
            role="listbox"
            aria-label={folder === 'threads' ? '会话串列表' : '邮件列表'}
          >
            {loading && visibleCount === 0 ? (
              <div className="office-mailbox-list-empty">
                <HudStateView
                  compact
                  variant="loading"
                  code="MAIL // SYNCING"
                  title="正在读取 Peer 队列"
                  description="同步会话映射、跨项目关系与最新投递状态"
                />
              </div>
            ) : visibleCount === 0 ? (
              <div className="office-mailbox-list-empty">
                <HudStateView
                  compact
                  code="MAIL // EMPTY"
                  title={
                    hasActiveFilter
                      ? '没有匹配的邮件'
                      : scope === 'session'
                        ? '当前工位暂无邮件'
                        : scope === 'room'
                          ? '当前项目房间暂无邮件'
                          : scope === 'unassigned'
                            ? '当前没有未归属或历史邮件'
                            : '暂无 Peer 邮件'
                  }
                  description={
                    hasActiveFilter
                      ? '调整状态过滤条件或清空搜索关键词后重试。'
                      : scope === 'session' && activeRoom
                        ? '可切换到「当前房间」或「全量消息」浏览同项目与历史往来。'
                        : '由 aih peer send / reply 派发的跨会话消息会实时出现在这里。'
                  }
                  extra={
                    hasActiveFilter ? (
                      <Button size="small" onClick={handleResetFilters}>
                        重置筛选
                      </Button>
                    ) : (folder === 'inbox' || folder === 'sent') && mailboxView.allCount > 0 ? (
                      <Button size="small" onClick={() => handleSelectFolder('all')}>
                        查看全部往来 ({mailboxView.allCount})
                      </Button>
                    ) : scope === 'session' && activeRoom ? (
                      <Button size="small" onClick={() => handleSelectScope('room')}>
                        查看当前房间
                      </Button>
                    ) : scope !== 'all' && counts.total > 0 ? (
                      <Button size="small" onClick={() => handleSelectScope('all')}>
                        查看全量消息 ({counts.total})
                      </Button>
                    ) : null
                  }
                />
              </div>
            ) : folder === 'threads' ? (
              mailboxView.threads.map((thread) => {
                const isSelected = selectedThread?.threadId === thread.threadId;
                const latest = thread.latestMessage;
                const stateMeta = getDeliveryStateMeta(latest.raw.state);
                const hasUnresolved = thread.messages.some(
                  (msg) => msg.hasUnresolvedParty,
                );
                return (
                  <button
                    key={thread.threadId}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-selected={isSelected ? 'true' : undefined}
                    className="office-mailbox-row"
                    onClick={() => {
                      setPinnedMessageId(null);
                      setSelectedThreadId(thread.threadId);
                      setActiveThreadMessageId(latest.id);
                    }}
                  >
                    <div className="office-mailbox-row-top">
                      <span
                        className="office-mailbox-row-parties"
                        title={`${latest.fromResolved.displayName} → ${latest.toResolved.displayName}`}
                      >
                        {latest.fromResolved.displayName} → {latest.toResolved.displayName}
                      </span>
                      <span className="office-mailbox-row-time">
                        {formatOfficeTimestamp(thread.latestAt)}
                      </span>
                    </div>

                    <div className="office-mailbox-row-subject-line">
                      <span className="office-mailbox-row-subject">
                        {thread.subjectLine || '(无主题会话串)'}
                      </span>
                      <span className="office-mailbox-row-id">
                        {thread.messageCount} 封
                      </span>
                    </div>

                    <div className="office-mailbox-row-snippet">
                      {latest.snippet || latest.normalizedBody || '(空正文)'}
                    </div>

                    <div className="office-mailbox-row-badges">
                      <span
                        className={`office-mailbox-state-pill office-mailbox-state-pill--${stateMeta.pillTone}`}
                      >
                        <span
                          className={`hud-led hud-led--${stateMeta.ledTone === 'neutral' ? 'info' : stateMeta.ledTone}`}
                          aria-hidden="true"
                        />
                        {stateMeta.shortLabel}
                      </span>
                      {thread.hasPending ? (
                        <span className="office-mailbox-micro-badge office-mailbox-micro-badge--warn">
                          含待投递
                        </span>
                      ) : null}
                      {thread.hasFailed ? (
                        <span className="office-mailbox-micro-badge office-mailbox-micro-badge--err">
                          含失败
                        </span>
                      ) : null}
                      {thread.isCrossProject ? (
                        <span className="office-mailbox-micro-badge office-mailbox-micro-badge--accent">
                          <SwapOutlined aria-hidden="true" /> 跨项目
                        </span>
                      ) : null}
                      {hasUnresolved ? (
                        <span className="office-mailbox-micro-badge office-mailbox-micro-badge--muted">
                          <HistoryOutlined aria-hidden="true" /> 未归属/历史
                        </span>
                      ) : null}
                    </div>
                  </button>
                );
              })
            ) : (
              mailboxView.filteredMessages.map((item) => {
                const isSelected = selectedMessage?.id === item.id;
                const stateMeta = getDeliveryStateMeta(item.raw.state);
                const direction = getDirectionIndicator(item, focusedSession);
                const hasError = Boolean(getCombinedDeliveryError(item));
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-selected={isSelected ? 'true' : undefined}
                    className="office-mailbox-row"
                    onClick={() => {
                      setPinnedMessageId(null);
                      setSelectedMessageId(item.id);
                    }}
                  >
                    <div className="office-mailbox-row-top">
                      <span
                        className="office-mailbox-row-parties"
                        title={`${item.fromResolved.displayName} → ${item.toResolved.displayName}`}
                      >
                        {direction.code ? (
                          <span
                            className={`office-mailbox-dir-chip office-mailbox-dir-chip--${direction.code}`}
                          >
                            {direction.label}
                          </span>
                        ) : null}
                        <span className="office-mailbox-row-party-text">
                          {item.fromResolved.displayName} → {item.toResolved.displayName}
                        </span>
                      </span>
                      <span className="office-mailbox-row-time">
                        {formatOfficeTimestamp(item.raw.createdAt)}
                      </span>
                    </div>

                    <div className="office-mailbox-row-subject-line">
                      <span className="office-mailbox-row-subject">
                        {item.subjectLine || '(无正文主题)'}
                      </span>
                      <span className="office-mailbox-row-id">
                        #{item.shortId || item.id.slice(0, 6)}
                      </span>
                    </div>

                    <div className="office-mailbox-row-snippet">
                      {item.snippet || item.normalizedBody || '(空正文)'}
                    </div>

                    <div className="office-mailbox-row-badges">
                      <span
                        className={`office-mailbox-state-pill office-mailbox-state-pill--${stateMeta.pillTone}`}
                      >
                        <span
                          className={`hud-led hud-led--${stateMeta.ledTone === 'neutral' ? 'info' : stateMeta.ledTone}`}
                          aria-hidden="true"
                        />
                        {stateMeta.shortLabel}
                      </span>

                      {item.isCrossProject ? (
                        <span className="office-mailbox-micro-badge office-mailbox-micro-badge--accent">
                          <SwapOutlined aria-hidden="true" /> 跨项目
                        </span>
                      ) : null}

                      {item.isFullyUnassigned ? (
                        <span className="office-mailbox-micro-badge office-mailbox-micro-badge--warn">
                          <HistoryOutlined aria-hidden="true" /> 未归属/历史
                        </span>
                      ) : item.hasUnresolvedParty ? (
                        <span className="office-mailbox-micro-badge office-mailbox-micro-badge--muted">
                          <HistoryOutlined aria-hidden="true" /> 未归属/历史
                        </span>
                      ) : null}

                      {item.raw.replyToShort ? (
                        <span className="office-mailbox-micro-badge office-mailbox-micro-badge--muted">
                          ↩ #{item.raw.replyToShort}
                        </span>
                      ) : null}

                      {hasError ? (
                        <span
                          className="office-mailbox-micro-badge office-mailbox-micro-badge--err"
                          title={getCombinedDeliveryError(item)}
                        >
                          <ExclamationCircleOutlined aria-hidden="true" /> 异常
                        </span>
                      ) : null}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right Reading Pane */}
        <div className="office-mailbox-reader-pane">
          <div className="office-mailbox-reader-scroll">
            {folder === 'threads' ? (
              selectedThread ? (
                <div className="office-mailbox-thread-view">
                  <header className="office-mailbox-thread-header">
                    <div>
                      <span className="office-mailbox-eyebrow">
                        THREAD // {selectedThread.messageCount} MESSAGES
                      </span>
                      <h2 className="office-mailbox-subject">
                        {selectedThread.subjectLine || '(无主题会话串)'}
                      </h2>
                    </div>
                    <div className="office-mailbox-meta-badges">
                      <Tag icon={<BranchesOutlined />} color="blue">
                        时间线共 {selectedThread.messageCount} 封
                      </Tag>
                      {selectedThread.isCrossProject ? (
                        <Tag icon={<SwapOutlined />} color="cyan">
                          跨项目会话串
                        </Tag>
                      ) : null}
                      {selectedThread.hasPending ? (
                        <Tag color="gold">含待投递</Tag>
                      ) : null}
                      {selectedThread.hasFailed ? (
                        <Tag color="red">含投递失败</Tag>
                      ) : null}
                    </div>
                  </header>

                  <div className="office-mailbox-thread-timeline">
                    {sortedThreadMessages.map((threadMsg, index) => (
                      <div key={threadMsg.id} className="office-mailbox-thread-step">
                        <div className="office-mailbox-thread-step-label">
                          <span>
                            #{index + 1} · {formatOfficeTimestamp(threadMsg.raw.createdAt)}
                          </span>
                        </div>
                        <MailDetailArticle
                          messageItem={threadMsg}
                          allMessages={allMessages}
                          allRooms={allRooms}
                          focusedSession={focusedSession}
                          activeRoom={activeRoom}
                          bodyMode={bodyMode}
                          onBodyModeChange={setBodyMode}
                          copiedKey={copiedKey}
                          onCopy={handleCopy}
                          onJumpToMessage={handleJumpToMessage}
                          onJumpToSession={onJumpToSession}
                          isThreadCard
                          isActiveInThread={activeThreadMessage?.id === threadMsg.id}
                          onSelectInThread={setActiveThreadMessageId}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="office-mailbox-reader-empty">
                  <HudStateView
                    code="MAIL // THREAD"
                    title="选择一组会话串"
                    description="从中间列表选择任意会话串，按时间顺序浏览全部往来邮件。"
                  />
                </div>
              )
            ) : selectedMessage ? (
              <MailDetailArticle
                messageItem={selectedMessage}
                allMessages={allMessages}
                allRooms={allRooms}
                focusedSession={focusedSession}
                activeRoom={activeRoom}
                bodyMode={bodyMode}
                onBodyModeChange={setBodyMode}
                copiedKey={copiedKey}
                onCopy={handleCopy}
                onJumpToMessage={handleJumpToMessage}
                onJumpToSession={onJumpToSession}
                onOpenThread={handleOpenThread}
              />
            ) : (
              <div className="office-mailbox-reader-empty">
                <HudStateView
                  code="MAIL // PREVIEW"
                  title="选择一封邮件查看详情"
                  description="展示收发双方会话归属、matchBasis、投递审计轨迹、完整正文与只读 CLI 回复命令。"
                />
              </div>
            )}
          </div>

          {cliTargetMessage ? (
            <footer className="office-mailbox-cli-footer" aria-label="CLI 回复命令助手">
              <div className="office-mailbox-cli-top">
                <div className="office-mailbox-cli-title">
                  <CodeOutlined aria-hidden="true" />
                  <span>CLI 回复命令助手</span>
                  <span className="office-mailbox-cli-badge">只读提示 · 非 HTTP 发送</span>
                </div>

                <div className="office-mailbox-cli-modes" role="group" aria-label="CLI 命令形式">
                  <button
                    type="button"
                    className="office-mailbox-mode-btn"
                    data-active={effectiveCliMode === 'reply' ? 'true' : undefined}
                    aria-pressed={effectiveCliMode === 'reply'}
                    onClick={() => setCliMode('reply')}
                  >
                    reply #{cliTargetMessage.shortId || cliTargetMessage.id.slice(0, 6)}
                  </button>
                  {cliSendTarget ? (
                    <button
                      type="button"
                      className="office-mailbox-mode-btn"
                      data-active={effectiveCliMode === 'send' ? 'true' : undefined}
                      aria-pressed={effectiveCliMode === 'send'}
                      onClick={() => setCliMode('send')}
                    >
                      send --to
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="office-mailbox-cli-command-row">
                <code className="office-mailbox-cli-code" title={cliCommandText}>
                  {cliCommandText}
                </code>
                <Button
                  size="small"
                  type="primary"
                  icon={
                    copiedKey === `cli:${cliTargetMessage.id}:${effectiveCliMode}` ? (
                      <CheckOutlined />
                    ) : (
                      <CopyOutlined />
                    )
                  }
                  onClick={() =>
                    handleCopy(
                      `cli:${cliTargetMessage.id}:${effectiveCliMode}`,
                      cliCommandText,
                      'CLI 回复命令已复制，可在工位终端执行',
                    )
                  }
                >
                  {copiedKey === `cli:${cliTargetMessage.id}:${effectiveCliMode}`
                    ? '已复制命令'
                    : '复制回复命令'}
                </Button>
              </div>
            </footer>
          ) : null}
        </div>
      </div>
    </section>
  );
};

export default OfficeMailbox;
