import { useCallback, useEffect, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import {
  ApartmentOutlined,
  BranchesOutlined,
  CheckCircleOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  CodeOutlined,
  CopyOutlined,
  DesktopOutlined,
  DownOutlined,
  EnvironmentOutlined,
  ExclamationCircleOutlined,
  EyeOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  HistoryOutlined,
  MailOutlined,
  MessageOutlined,
  ReloadOutlined,
  RightOutlined,
  RollbackOutlined,
  SwapOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Input, Tooltip, message } from 'antd';
import HudStateView from '@/components/hud/HudStateView';
import AppButton from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import { writeClipboardText } from '@/utils/clipboard';
import {
  buildExplicitReplyChain,
  buildRepliedMessageIdSet,
  evaluateMailLifecycle,
  formatAbsoluteTimestamp,
  resolveMailDisplayStates,
  type MailBadgeTone,
  type MailDisplayStateBadge,
} from './peer-message-presentation';
import { buildSessionMailboxView } from './session-office-model';
import type {
  EnrichedPeerMessage,
  MailboxFolder,
  MailboxScope,
  MailboxStateFilter,
  OfficeProjectRoom,
  OfficeSessionItem,
  PeerCounts,
  PeerFieldProvenance,
  PeerThreadGroup,
  ReadablePartySummary,
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
  initialMessageId?: string | null;
  compactHeader?: boolean;
}

type BodyRenderMode = 'prose' | 'mono';
type CliCommandMode = 'reply' | 'send';

const CLOCK_TICK_MS = 30_000;

function getMatchBasisLabel(basis: ResolvedPeerEndpoint['matchBasis']): string {
  switch (basis) {
    case 'nativeSessionId':
      return 'nativeSessionId（精确匹配活跃原生会话）';
    case 'sessionKey':
      return 'sessionKey（精确匹配控制台会话键）';
    case 'scopedName':
      return 'scopedName（按项目作用域名称关联）';
    case 'unresolved':
    default:
      return 'unresolved（外部或历史会话端点）';
  }
}

function getProvenanceFieldNote(source: PeerFieldProvenance): string {
  switch (source) {
    case 'explicit':
      return '结构化字段';
    case 'classified':
      return '系统归类';
    case 'extracted':
      return '原文提取';
    case 'unknown':
    default:
      return '未说明';
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
    focusedSession
      && msg.fromResolved.sessionKey === focusedSession.sessionKey
      && msg.toResolved.sessionKey !== focusedSession.sessionKey,
  );
  const party = isOutgoingFromFocused ? msg.raw.to : msg.raw.from;
  const fallbackSessionKey = isOutgoingFromFocused
    ? msg.toResolved.sessionKey
    : msg.fromResolved.sessionKey;
  return (
    party.address
    || party.name
    || party.sessionId
    || fallbackSessionKey
    || ''
  ).trim();
}

/**
 * Builds read-only CLI command templates using the unmodified message shortId/id
 * and real target endpoint.
 */
function buildCliHelperCommand(
  msg: EnrichedPeerMessage,
  mode: CliCommandMode,
  focusedSession: OfficeSessionItem | null,
): string {
  if (mode === 'send') {
    const target = resolveReplyPeerTarget(msg, focusedSession);
    if (target) {
      return `aih peer send ${shellQuoteArg(target)} "..."`;
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

function getCombinedDeliveryError(msg: EnrichedPeerMessage): string {
  const parts = [msg.raw.error, msg.raw.lastAttemptError, msg.raw.receiptError]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  return [...new Set(parts)].join(' · ');
}

function renderStateIcon(tone: MailBadgeTone, key: string): ReactNode {
  if (key === 'replied' || key === 'read') return <CheckCircleOutlined aria-hidden="true" />;
  if (key === 'awaiting-reply' || key === 'undelivered' || key === 'manual') {
    return <ClockCircleOutlined aria-hidden="true" />;
  }
  if (key === 'unread') return <MailOutlined aria-hidden="true" />;
  if (tone === 'danger') return <ExclamationCircleOutlined aria-hidden="true" />;
  if (key === 'no-reply') return <CloseCircleOutlined aria-hidden="true" />;
  return <MessageOutlined aria-hidden="true" />;
}

interface StateTagProps {
  badge: MailDisplayStateBadge;
  compact?: boolean;
}

const MailStateTag: FC<StateTagProps> = ({ badge, compact = false }) => (
  <span
    className={`office-mailbox-state-tag office-mailbox-state-tag--${badge.tone}${compact ? ' office-mailbox-state-tag--compact' : ''}`}
    title={badge.title || badge.label}
  >
    <span className="office-mailbox-state-tag-icon" aria-hidden="true">
      {renderStateIcon(badge.tone, badge.key)}
    </span>
    <span>{badge.label}</span>
  </span>
);

interface ScopeOptionItem {
  key: MailboxScope;
  label: string;
  count?: number;
  icon: typeof DesktopOutlined;
  disabled?: boolean;
  tooltip?: string;
}

interface MailboxHeaderProps {
  compactHeader: boolean;
  scope: MailboxScope;
  scopeOptions: ScopeOptionItem[];
  subtitle: string;
  searchQuery: string;
  loading: boolean;
  hasMessages: boolean;
  pendingOnly: boolean;
  pendingCount: number;
  error: string;
  onSelectScope: (scope: MailboxScope) => void;
  onTogglePending: () => void;
  onSearchChange: (value: string) => void;
  onRefresh: () => void;
}

const MailboxHeader: FC<MailboxHeaderProps> = ({
  compactHeader,
  scope,
  scopeOptions,
  subtitle,
  searchQuery,
  loading,
  hasMessages,
  pendingOnly,
  pendingCount,
  error,
  onSelectScope,
  onTogglePending,
  onSearchChange,
  onRefresh,
}) => (
  <header className="office-mailbox-header">
    <div className="office-mailbox-header-main">
      {!compactHeader ? (
        <div className="office-mailbox-heading-block">
          <h2 className="office-mailbox-title">
            <MessageOutlined aria-hidden="true" />
            <span>协作消息</span>
          </h2>
          <p className="office-mailbox-subtitle" title={subtitle}>
            {subtitle}
          </p>
        </div>
      ) : (
        <p className="office-mailbox-subtitle office-mailbox-subtitle--compact" title={subtitle}>
          {subtitle}
        </p>
      )}

      <div className="office-mailbox-toolbar-actions">
        {loading && hasMessages ? (
          <SettingStatusTag status="saving" label="同步中" compact live="polite" />
        ) : null}
        <AppButton
          size="small"
          appVariant={pendingOnly ? 'primary' : 'secondary'}
          onClick={onTogglePending}
        >
          只看待处理{pendingCount > 0 ? ` (${pendingCount})` : ''}
        </AppButton>
        <Input.Search
          size="small"
          allowClear
          className="office-mailbox-search"
          aria-label="搜索消息"
          placeholder="搜索主题、发送方、正文…"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          onSearch={onSearchChange}
        />
        <AppButton
          size="small"
          appVariant="secondary"
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={onRefresh}
        >
          刷新
        </AppButton>
      </div>
    </div>

    <div className="office-mailbox-scope-bar">
      <div
        className="office-mailbox-scope-tabs"
        role="tablist"
        aria-label="消息范围切换"
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
                onClick={() => onSelectScope(item.key)}
              >
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            </Tooltip>
          );
        })}
      </div>
    </div>

    {error ? (
      <InlineNote tone="error" className="office-mailbox-header-error">
        {error}
      </InlineNote>
    ) : null}
  </header>
);

interface MailboxListPaneProps {
  folder: MailboxFolder;
  activeFolderLabel: string;
  visibleCount: number;
  hasActiveFilter: boolean;
  loading: boolean;
  scope: MailboxScope;
  activeRoom: OfficeProjectRoom | null;
  totalCount: number;
  threads: PeerThreadGroup[];
  messages: EnrichedPeerMessage[];
  selectedThreadId: string | null;
  selectedMessageId: string | null;
  nowMs: number;
  repliedIds: ReadonlySet<string>;
  locallyReadIds: ReadonlySet<string>;
  onResetFilters: () => void;
  onSelectScope: (scope: MailboxScope) => void;
  onSelectThread: (thread: PeerThreadGroup) => void;
  onSelectMessage: (msg: EnrichedPeerMessage) => void;
  onRefresh: () => void;
}

const MailboxListPane: FC<MailboxListPaneProps> = ({
  folder,
  activeFolderLabel,
  visibleCount,
  hasActiveFilter,
  loading,
  scope,
  activeRoom,
  totalCount,
  threads,
  messages,
  selectedThreadId,
  selectedMessageId,
  nowMs,
  repliedIds,
  locallyReadIds,
  onResetFilters,
  onSelectScope,
  onSelectThread,
  onSelectMessage,
  onRefresh,
}) => {
  const renderEmptyAction = (): ReactNode => {
    if (hasActiveFilter) {
      return (
        <AppButton size="small" appVariant="primary" onClick={onResetFilters}>
          清除筛选条件
        </AppButton>
      );
    }
    if (scope === 'session' && activeRoom) {
      return (
        <AppButton size="small" appVariant="primary" onClick={() => onSelectScope('room')}>
          切换到当前房间
        </AppButton>
      );
    }
    if (scope !== 'all' && totalCount > 0) {
      return (
        <AppButton size="small" appVariant="primary" onClick={() => onSelectScope('all')}>
          查看全部消息 ({totalCount})
        </AppButton>
      );
    }
    return (
      <AppButton size="small" appVariant="secondary" icon={<ReloadOutlined />} onClick={onRefresh}>
        刷新消息
      </AppButton>
    );
  };

  return (
    <div className="office-mailbox-list-pane">
      <div className="office-mailbox-list-head">
        <span className="office-mailbox-list-title">
          {activeFolderLabel} · {visibleCount} 条
        </span>
        {hasActiveFilter ? (
          <AppButton
            size="small"
            appVariant="quiet"
            icon={<CloseCircleOutlined />}
            onClick={onResetFilters}
          >
            清除筛选
          </AppButton>
        ) : null}
      </div>

      <div
        className="office-mailbox-list"
        role="listbox"
        aria-label="消息列表"
      >
        {loading && visibleCount === 0 ? (
          <div className="office-mailbox-list-empty">
            <HudStateView
              compact
              variant="loading"
              title="正在加载协作消息"
              description="同步会话映射与投递状态"
            />
          </div>
        ) : visibleCount === 0 ? (
          <div className="office-mailbox-list-empty">
            <HudStateView
              compact
              title={
                hasActiveFilter
                  ? '没有匹配的消息'
                  : scope === 'session'
                    ? '当前工位暂无消息'
                    : scope === 'room'
                      ? '当前房间暂无消息'
                      : scope === 'unassigned'
                        ? '暂无未归属消息'
                        : '暂无协作消息'
              }
              description={
                hasActiveFilter
                  ? '可清除筛选或修改关键词后重试。'
                  : '跨会话协作消息会显示在此处；默认只看待处理。'
              }
              extra={renderEmptyAction()}
            />
          </div>
        ) : folder === 'threads' ? (
          threads.map((thread) => {
            const isSelected = selectedThreadId === thread.threadId;
            const latest = thread.latestMessage;
            const lifecycle = evaluateMailLifecycle(latest, nowMs);
            const displayStates = resolveMailDisplayStates(
              latest,
              lifecycle,
              repliedIds,
              locallyReadIds.has(latest.id),
            );
            const partiesText = `${latest.fromReadable.shortName} → ${latest.toReadable.shortName}`;

            return (
              <button
                key={thread.threadId}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-selected={isSelected ? 'true' : undefined}
                data-unread={displayStates.isUnread ? 'true' : undefined}
                className="office-mailbox-row"
                onClick={() => onSelectThread(thread)}
              >
                <div className="office-mailbox-row-subject-line">
                  <span className="office-mailbox-row-subject" title={thread.subjectLine || '(无主题)'}>
                    {thread.subjectLine || '(无主题)'}
                  </span>
                  <span className="office-mailbox-row-count">{thread.messageCount} 条</span>
                </div>

                <div className="office-mailbox-row-meta" title={`${partiesText} · ${lifecycle.sentAbsoluteText}`}>
                  <span className="office-mailbox-row-parties">{partiesText}</span>
                  <span className="office-mailbox-row-sep" aria-hidden="true">·</span>
                  <span className="office-mailbox-row-time">{lifecycle.sentCompactText}</span>
                </div>

                <div className="office-mailbox-row-states">
                  <MailStateTag badge={displayStates.primary} compact />
                  {displayStates.reply ? <MailStateTag badge={displayStates.reply} compact /> : null}
                  {thread.isCrossProject ? (
                    <span className="office-mailbox-micro-badge">
                      <SwapOutlined aria-hidden="true" />
                      <span>跨项目</span>
                    </span>
                  ) : null}
                </div>
              </button>
            );
          })
        ) : (
          messages.map((item) => {
            const isSelected = selectedMessageId === item.id;
            const lifecycle = evaluateMailLifecycle(item, nowMs);
            const displayStates = resolveMailDisplayStates(
              item,
              lifecycle,
              repliedIds,
              locallyReadIds.has(item.id),
            );
            const partiesText = `${item.fromReadable.shortName} → ${item.toReadable.shortName}`;

            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-selected={isSelected ? 'true' : undefined}
                data-unread={displayStates.isUnread ? 'true' : undefined}
                className="office-mailbox-row"
                onClick={() => onSelectMessage(item)}
              >
                <div className="office-mailbox-row-subject-line">
                  <span className="office-mailbox-row-subject" title={item.presentation.title}>
                    {item.presentation.title}
                  </span>
                  {Number(item.raw.priority || 0) > 0 ? (
                    <span className="office-mailbox-priority-tag">加急</span>
                  ) : null}
                </div>

                <div className="office-mailbox-row-meta" title={`${partiesText} · ${lifecycle.sentAbsoluteText}`}>
                  <span className="office-mailbox-row-parties">{partiesText}</span>
                  <span className="office-mailbox-row-sep" aria-hidden="true">·</span>
                  <span className="office-mailbox-row-time">{lifecycle.sentCompactText}</span>
                </div>

                <div className="office-mailbox-row-states">
                  <MailStateTag badge={displayStates.primary} compact />
                  {displayStates.reply ? <MailStateTag badge={displayStates.reply} compact /> : null}
                  {item.isCrossProject ? (
                    <span className="office-mailbox-micro-badge">
                      <SwapOutlined aria-hidden="true" />
                      <span>跨项目</span>
                    </span>
                  ) : null}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};

interface ReadablePartyCardProps {
  roleLabel: '发送方' | '接收方';
  endpoint: ResolvedPeerEndpoint;
  readable: ReadablePartySummary;
  allRooms: OfficeProjectRoom[];
  focusedSession: OfficeSessionItem | null;
  activeRoom: OfficeProjectRoom | null;
  onJumpToSession?: (sessionKey: string, projectKey?: string | null) => void;
}

const ReadablePartyCard: FC<ReadablePartyCardProps> = ({
  roleLabel,
  endpoint,
  readable,
  allRooms,
  focusedSession,
  activeRoom,
  onJumpToSession,
}) => {
  const matchedRoom = useMemo(
    () => findEndpointRoom(endpoint, allRooms),
    [allRooms, endpoint],
  );
  const projectDisplay = endpoint.projectName || matchedRoom?.projectName || readable.projectLabel;
  const projectPathHint = endpoint.projectPath || matchedRoom?.projectPath || projectDisplay;
  const isCurrentDesk = Boolean(
    focusedSession?.sessionKey
      && endpoint.sessionKey
      && focusedSession.sessionKey === endpoint.sessionKey,
  );
  const isCrossRoomJump = Boolean(
    endpoint.projectKey
      && activeRoom?.projectKey
      && endpoint.projectKey !== activeRoom.projectKey,
  );

  return (
    <section className="office-mailbox-party-card" aria-label={roleLabel}>
      <div className="office-mailbox-party-head">
        <span className="office-mailbox-party-role">
          <UserOutlined aria-hidden="true" />
          <span>{roleLabel}</span>
          <span className="office-mailbox-party-provider">{readable.providerLabel}</span>
        </span>
        {readable.shortIdentity ? (
          <span className="office-mailbox-party-short-id">{readable.shortIdentity}</span>
        ) : null}
      </div>

      <div className="office-mailbox-party-main">
        <strong className="office-mailbox-party-name" title={readable.shortName}>
          {readable.shortName}
        </strong>
        <div className="office-mailbox-party-foot">
          <Tooltip title={projectPathHint}>
            <span
              className={`office-mailbox-project-badge${
                readable.hasKnownProject || matchedRoom ? '' : ' office-mailbox-project-badge--muted'
              }`}
            >
              {readable.hasKnownProject || matchedRoom ? (
                <FolderOpenOutlined aria-hidden="true" />
              ) : (
                <HistoryOutlined aria-hidden="true" />
              )}
              <span>{projectDisplay}</span>
            </span>
          </Tooltip>

          {endpoint.sessionKey && onJumpToSession ? (
            <AppButton
              size="small"
              appVariant="secondary"
              disabled={isCurrentDesk}
              icon={isCrossRoomJump ? <EnvironmentOutlined /> : <DesktopOutlined />}
              onClick={(event) => {
                event.stopPropagation();
                onJumpToSession(endpoint.sessionKey!, endpoint.projectKey);
              }}
            >
              {isCurrentDesk ? '当前工位' : isCrossRoomJump ? '前往房间' : '前往工位'}
            </AppButton>
          ) : null}
        </div>
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
  nowMs: number;
  repliedIds: ReadonlySet<string>;
  isLocallyRead: boolean;
  onToggleLocalRead: (messageId: string) => void;
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
  nowMs,
  repliedIds,
  isLocallyRead,
  onToggleLocalRead,
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
  const [rawExpanded, setRawExpanded] = useState(false);
  const [techExpanded, setTechExpanded] = useState(false);

  useEffect(() => {
    setRawExpanded(false);
    setTechExpanded(false);
  }, [messageItem.id]);

  const lifecycle = useMemo(
    () => evaluateMailLifecycle(messageItem, nowMs),
    [messageItem, nowMs],
  );
  const displayStates = useMemo(
    () => resolveMailDisplayStates(messageItem, lifecycle, repliedIds, isLocallyRead),
    [isLocallyRead, lifecycle, messageItem, repliedIds],
  );
  const deliveryError = useMemo(
    () => getCombinedDeliveryError(messageItem),
    [messageItem],
  );
  const explicitChain = useMemo(
    () =>
      isThreadCard
        ? { hasExplicitChain: false, rootMissingShortId: '', nodes: [] }
        : buildExplicitReplyChain(messageItem, allMessages),
    [allMessages, isThreadCard, messageItem],
  );

  const supersedesMessage = useMemo(() => {
    const ref = String(messageItem.raw.supersedes ?? '').trim();
    if (!ref) return null;
    return allMessages.find((item) => item.id === ref || item.shortId === ref) ?? null;
  }, [allMessages, messageItem.raw.supersedes]);

  const { presentation, fromReadable, toReadable } = messageItem;
  const shortMsgId = messageItem.shortId || messageItem.id.slice(0, 8);
  const idCopyKey = `id:${messageItem.id}`;
  const bodyCopyKey = `body:${messageItem.id}`;
  const replyCmdKey = `inline-reply:${messageItem.id}`;
  const replyCommand = useMemo(
    () => buildCliHelperCommand(messageItem, 'reply', focusedSession),
    [focusedSession, messageItem],
  );
  const rawBodyVerbatim = messageItem.raw.body;
  const canMarkRead = lifecycle.kind !== 'read';
  const showSummarySeparately =
    Boolean(presentation.summary)
    && presentation.summary !== presentation.purpose
    && presentation.summary !== presentation.title;

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
      {/* 1. Subject, States & Quick Actions First */}
      <header className="office-mailbox-article-head">
        <div className="office-mailbox-subject-row">
          <h2 className="office-mailbox-subject">{presentation.title}</h2>
          <div className="office-mailbox-head-actions">
            <span className="office-mailbox-short-id" title={`完整 ID: ${messageItem.id}`}>
              #{shortMsgId}
            </span>
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
                {isActiveInThread ? '当前回复目标' : '设为回复目标'}
              </button>
            ) : null}
          </div>
        </div>

        <div className="office-mailbox-meta-row">
          <div className="office-mailbox-meta-badges">
            <MailStateTag badge={displayStates.primary} />
            {displayStates.reply ? <MailStateTag badge={displayStates.reply} /> : null}
            {Number(messageItem.raw.priority || 0) > 0 ? (
              <span className="office-mailbox-priority-tag">加急</span>
            ) : null}
            {messageItem.isCrossProject ? (
              <span className="office-mailbox-micro-badge">
                <SwapOutlined aria-hidden="true" />
                <span>跨项目</span>
              </span>
            ) : null}
            {messageItem.isFullyUnassigned ? (
              <span className="office-mailbox-micro-badge">
                <HistoryOutlined aria-hidden="true" />
                <span>历史 / 外部</span>
              </span>
            ) : null}
            {messageItem.raw.supersedes ? (
              supersedesMessage ? (
                <AppButton
                  size="small"
                  appVariant="quiet"
                  onClick={(event) => {
                    event.stopPropagation();
                    onJumpToMessage(supersedesMessage);
                  }}
                >
                  替代 #{supersedesMessage.shortId}
                </AppButton>
              ) : (
                <span className="office-mailbox-micro-badge">
                  替代 #{messageItem.raw.supersedes.slice(0, 8)}
                </span>
              )
            ) : null}
            {messageItem.supersededByIds.length > 0 ? (
              <span className="office-mailbox-micro-badge">
                已被 #{messageItem.supersededByIds.join(', #')} 替代
              </span>
            ) : null}
          </div>

          <div className="office-mailbox-article-actions" onClick={(event) => event.stopPropagation()}>
            <AppButton
              size="small"
              appVariant="primary"
              icon={copiedKey === replyCmdKey ? <CheckOutlined /> : <CopyOutlined />}
              onClick={() =>
                onCopy(replyCmdKey, replyCommand, '已复制回复命令，可在终端执行')
              }
            >
              {copiedKey === replyCmdKey ? '已复制命令' : '复制回复命令'}
            </AppButton>
            {canMarkRead ? (
              <AppButton
                size="small"
                appVariant="secondary"
                icon={<EyeOutlined />}
                onClick={() => onToggleLocalRead(messageItem.id)}
              >
                {isLocallyRead ? '标为未读' : '标记已读'}
              </AppButton>
            ) : null}
          </div>
        </div>
      </header>

      {/* 2. Sender -> Recipient */}
      <div className="office-mailbox-parties">
        <ReadablePartyCard
          roleLabel="发送方"
          endpoint={messageItem.fromResolved}
          readable={fromReadable}
          allRooms={allRooms}
          focusedSession={focusedSession}
          activeRoom={activeRoom}
          onJumpToSession={onJumpToSession}
        />
        <ReadablePartyCard
          roleLabel="接收方"
          endpoint={messageItem.toResolved}
          readable={toReadable}
          allRooms={allRooms}
          focusedSession={focusedSession}
          activeRoom={activeRoom}
          onJumpToSession={onJumpToSession}
        />
      </div>

      {/* 3. Structured Purpose, Expected Action, Timing & State */}
      <section className="office-mailbox-digest" aria-label="消息核心信息">
        <div className="office-mailbox-digest-grid">
          <div className="office-mailbox-digest-item">
            <div className="office-mailbox-digest-label">
              <span>联系目的</span>
              {presentation.purposeSource !== 'unknown' ? (
                <span className="office-mailbox-digest-tag">
                  {getProvenanceFieldNote(presentation.purposeSource)}
                </span>
              ) : null}
            </div>
            <div
              className={`office-mailbox-digest-value${
                presentation.purposeSource === 'unknown' ? ' is-unknown' : ''
              }`}
            >
              {presentation.purpose}
            </div>
          </div>

          <div className="office-mailbox-digest-item">
            <div className="office-mailbox-digest-label">
              <span>期望行动</span>
              {presentation.actionSource !== 'unknown' ? (
                <span className="office-mailbox-digest-tag">
                  {getProvenanceFieldNote(presentation.actionSource)}
                </span>
              ) : null}
            </div>
            <div
              className={`office-mailbox-digest-value${
                presentation.actionSource === 'unknown' ? ' is-unknown' : ''
              }`}
            >
              {presentation.actionText}
            </div>
          </div>

          <div className="office-mailbox-digest-item">
            <div className="office-mailbox-digest-label">
              <ClockCircleOutlined aria-hidden="true" />
              <span>时间记录</span>
            </div>
            <div className="office-mailbox-time-pair">
              <span>
                <em>发送</em>
                <strong>{lifecycle.sentAbsoluteText}</strong>
              </span>
              <span>
                <em>送达</em>
                <strong className={lifecycle.isUndelivered ? 'is-undelivered' : undefined}>
                  {lifecycle.deliveredAbsoluteText}
                </strong>
              </span>
              {messageItem.raw.readAt > 0 ? (
                <span>
                  <em>已读</em>
                  <strong>{lifecycle.readAbsoluteText}</strong>
                </span>
              ) : null}
            </div>
          </div>

          <div className="office-mailbox-digest-item">
            <div className="office-mailbox-digest-label">
              <span>投递与时效</span>
            </div>
            <div className="office-mailbox-digest-value">
              <span>{lifecycle.validitySummary}</span>
            </div>
          </div>
        </div>

        {showSummarySeparately ? (
          <div className="office-mailbox-summary-row">
            <span className="office-mailbox-digest-label">摘要</span>
            <p className="office-mailbox-summary-text">{presentation.summary}</p>
          </div>
        ) : null}

        {presentation.jargonHints.length > 0 ? (
          <div className="office-mailbox-jargon-row" aria-label="术语参考">
            <span className="office-mailbox-jargon-label">术语：</span>
            {presentation.jargonHints.map((hint) => (
              <span key={hint.term} className="office-mailbox-jargon-chip">
                <code>{hint.term}</code>
                <span>{hint.meaning}</span>
              </span>
            ))}
          </div>
        ) : null}

        {deliveryError ? (
          <InlineNote tone="error" className="office-mailbox-delivery-error">
            投递异常：{deliveryError}
          </InlineNote>
        ) : null}
      </section>

      {/* 4. Explicit replyTo Chain (only when explicit links exist) */}
      {!isThreadCard && explicitChain.hasExplicitChain ? (
        <section className="office-mailbox-chain-box" aria-label="回复链">
          <div className="office-mailbox-chain-head">
            <span className="office-mailbox-chain-title">
              <BranchesOutlined aria-hidden="true" />
              <span>回复链（{explicitChain.nodes.length} 条）</span>
            </span>
            {onOpenThread && explicitChain.nodes.length > 1 ? (
              <AppButton
                size="small"
                appVariant="quiet"
                icon={<BranchesOutlined />}
                onClick={() => onOpenThread(messageItem.threadRootId)}
              >
                展开回复链
              </AppButton>
            ) : null}
          </div>

          <div className="office-mailbox-chain-list">
            {explicitChain.rootMissingShortId ? (
              <div className="office-mailbox-chain-missing">
                <RollbackOutlined aria-hidden="true" />
                <span>父消息 #{explicitChain.rootMissingShortId} 不在当前缓存中</span>
              </div>
            ) : null}

            {explicitChain.nodes.map((node, index) => {
              const nodeLifecycle = evaluateMailLifecycle(node.message, nowMs);
              const nodeStates = resolveMailDisplayStates(node.message, nodeLifecycle, repliedIds);
              return (
                <button
                  key={node.message.id}
                  type="button"
                  className="office-mailbox-chain-node"
                  data-current={node.isCurrent ? 'true' : undefined}
                  data-depth={String(node.depth)}
                  onClick={() => {
                    if (!node.isCurrent) {
                      onJumpToMessage(node.message);
                    }
                  }}
                >
                  <span className="office-mailbox-chain-step">#{index + 1}</span>
                  <span className="office-mailbox-chain-parties">
                    {node.message.fromReadable.shortName} → {node.message.toReadable.shortName}
                  </span>
                  <span className="office-mailbox-chain-subject">
                    {node.parentShortId ? `↩ #${node.parentShortId} · ` : ''}
                    {node.message.presentation.title}
                  </span>
                  <span className="office-mailbox-chain-meta">
                    <span>{nodeLifecycle.sentCompactText}</span>
                    <MailStateTag badge={nodeStates.primary} compact />
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* 5. Collapsed Disclosure: Original Raw Body */}
      <section className="office-mailbox-disclosure" aria-label="原始正文">
        <button
          type="button"
          className="office-mailbox-disclosure-toggle"
          aria-expanded={rawExpanded}
          onClick={(event) => {
            event.stopPropagation();
            setRawExpanded((prev) => !prev);
          }}
        >
          <span className="office-mailbox-disclosure-left">
            {rawExpanded ? <DownOutlined aria-hidden="true" /> : <RightOutlined aria-hidden="true" />}
            <FileTextOutlined aria-hidden="true" />
            <span>原始正文</span>
            <span className="office-mailbox-disclosure-meta">
              {rawBodyVerbatim.length > 0 ? `${rawBodyVerbatim.length} 字符` : '空正文'}
            </span>
          </span>
          <span className="office-mailbox-disclosure-hint">{rawExpanded ? '收起' : '展开原文'}</span>
        </button>

        {rawExpanded ? (
          <div className="office-mailbox-disclosure-body" onClick={(event) => event.stopPropagation()}>
            <div className="office-mailbox-body-toolbar">
              <div className="office-mailbox-mode-toggle" role="group" aria-label="正文排版模式">
                <button
                  type="button"
                  className="office-mailbox-mode-btn"
                  data-active={bodyMode === 'prose' ? 'true' : undefined}
                  aria-pressed={bodyMode === 'prose'}
                  onClick={() => onBodyModeChange('prose')}
                >
                  阅读
                </button>
                <button
                  type="button"
                  className="office-mailbox-mode-btn"
                  data-active={bodyMode === 'mono' ? 'true' : undefined}
                  aria-pressed={bodyMode === 'mono'}
                  onClick={() => onBodyModeChange('mono')}
                >
                  等宽
                </button>
              </div>
              <AppButton
                size="small"
                appVariant="quiet"
                icon={copiedKey === bodyCopyKey ? <CheckOutlined /> : <CopyOutlined />}
                onClick={() => onCopy(bodyCopyKey, rawBodyVerbatim, '原始正文已复制')}
              >
                {copiedKey === bodyCopyKey ? '已复制' : '复制原文'}
              </AppButton>
            </div>

            <pre className="office-mailbox-body-content" data-mode={bodyMode}>
              {rawBodyVerbatim.length > 0 ? rawBodyVerbatim : '(空正文)'}
            </pre>
          </div>
        ) : null}
      </section>

      {/* 6. Collapsed Disclosure: Technical & Delivery Metadata */}
      <section className="office-mailbox-disclosure" aria-label="技术详情与原始字段">
        <button
          type="button"
          className="office-mailbox-disclosure-toggle"
          aria-expanded={techExpanded}
          onClick={(event) => {
            event.stopPropagation();
            setTechExpanded((prev) => !prev);
          }}
        >
          <span className="office-mailbox-disclosure-left">
            {techExpanded ? <DownOutlined aria-hidden="true" /> : <RightOutlined aria-hidden="true" />}
            <CodeOutlined aria-hidden="true" />
            <span>技术详情与投递审计</span>
            <span className="office-mailbox-disclosure-meta">
              尝试 {lifecycle.attemptCount} 次 · 检查 {lifecycle.probeCount ?? '-'}
            </span>
          </span>
          <span className="office-mailbox-disclosure-hint">{techExpanded ? '收起' : '展开'}</span>
        </button>

        {techExpanded ? (
          <div className="office-mailbox-tech-body" onClick={(event) => event.stopPropagation()}>
            <div className="office-mailbox-tech-actions">
              <AppButton
                size="small"
                appVariant="secondary"
                icon={copiedKey === idCopyKey ? <CheckOutlined /> : <CopyOutlined />}
                onClick={() => onCopy(idCopyKey, messageItem.id, '完整消息 ID 已复制')}
              >
                {copiedKey === idCopyKey ? '已复制 ID' : '复制完整 ID'}
              </AppButton>
            </div>

            <div className="office-mailbox-audit-grid">
              <div>
                <span>队列 / 通知状态</span>
                <strong>
                  {messageItem.raw.state || '-'} / {messageItem.raw.notificationState || '-'}
                </strong>
              </div>
              <div>
                <span>尝试 / 目标检查</span>
                <strong>
                  {lifecycle.attemptCount} / {lifecycle.probeCount ?? '未记录'}
                </strong>
              </div>
              <div>
                <span>自动通知窗口</span>
                <strong>{formatAbsoluteTimestamp(messageItem.raw.autoDeliverUntil)}</strong>
              </div>
              <div>
                <span>语义过期</span>
                <strong>
                  {messageItem.raw.expiresAt
                    ? formatAbsoluteTimestamp(messageItem.raw.expiresAt)
                    : '无限制'}
                </strong>
              </div>
              <div>
                <span>忙碌起始 / 调度原因</span>
                <strong>
                  {messageItem.raw.busySince ? formatAbsoluteTimestamp(messageItem.raw.busySince) : '-'}
                  {messageItem.raw.waitingReason ? ` · ${messageItem.raw.waitingReason}` : ''}
                </strong>
              </div>
              <div>
                <span>下次重试</span>
                <strong>{formatAbsoluteTimestamp(messageItem.raw.nextAttemptAt)}</strong>
              </div>
            </div>

            <dl className="office-mailbox-tech-kv">
              <div>
                <dt>完整消息 ID</dt>
                <dd><code>{messageItem.id}</code></dd>
              </div>
              <div>
                <dt>replyTo / supersedes</dt>
                <dd>
                  <code>
                    replyTo={messageItem.raw.replyTo || '-'} · supersedes={messageItem.raw.supersedes || '-'}
                  </code>
                </dd>
              </div>
              <div>
                <dt>字段来源</dt>
                <dd>
                  标题={getProvenanceFieldNote(presentation.titleSource)} · 目的={getProvenanceFieldNote(presentation.purposeSource)} · 行动={getProvenanceFieldNote(presentation.actionSource)} · 回复={getProvenanceFieldNote(presentation.replyPolicySource)}
                </dd>
              </div>
              <div>
                <dt>发送方端点</dt>
                <dd>
                  <code>
                    {messageItem.raw.from.provider || '-'} · {messageItem.raw.from.name || '-'} · {messageItem.raw.from.address || messageItem.raw.from.sessionId || '-'}
                  </code>
                  <span className="office-mailbox-tech-basis">
                    {getMatchBasisLabel(messageItem.fromResolved.matchBasis)}
                  </span>
                </dd>
              </div>
              <div>
                <dt>接收方端点</dt>
                <dd>
                  <code>
                    {messageItem.raw.to.provider || '-'} · {messageItem.raw.to.name || '-'} · {messageItem.raw.to.address || messageItem.raw.to.sessionId || '-'}
                  </code>
                  <span className="office-mailbox-tech-basis">
                    {getMatchBasisLabel(messageItem.toResolved.matchBasis)}
                  </span>
                </dd>
              </div>
            </dl>
          </div>
        ) : null}
      </section>
    </article>
  );
};

interface MailboxCliFooterProps {
  targetMessage: EnrichedPeerMessage;
  cliMode: CliCommandMode;
  cliSendTarget: string;
  cliCommandText: string;
  copiedKey: string | null;
  onModeChange: (mode: CliCommandMode) => void;
  onCopy: (key: string, text: string, successLabel: string) => void;
}

const MailboxCliFooter: FC<MailboxCliFooterProps> = ({
  targetMessage,
  cliMode,
  cliSendTarget,
  cliCommandText,
  copiedKey,
  onModeChange,
  onCopy,
}) => {
  const effectiveMode: CliCommandMode = cliMode === 'send' && cliSendTarget ? 'send' : 'reply';
  const copyId = `cli:${targetMessage.id}:${effectiveMode}`;
  const isCopied = copiedKey === copyId;

  return (
    <footer className="office-mailbox-cli-footer" aria-label="CLI 回复命令">
      <div className="office-mailbox-cli-top">
        <span className="office-mailbox-cli-title">
          <CodeOutlined aria-hidden="true" />
          <span>CLI 命令</span>
        </span>
        <div className="office-mailbox-cli-modes" role="group" aria-label="CLI 命令类型">
          <button
            type="button"
            className="office-mailbox-mode-btn"
            data-active={effectiveMode === 'reply' ? 'true' : undefined}
            aria-pressed={effectiveMode === 'reply'}
            onClick={() => onModeChange('reply')}
          >
            回复 #{targetMessage.shortId || targetMessage.id.slice(0, 6)}
          </button>
          {cliSendTarget ? (
            <button
              type="button"
              className="office-mailbox-mode-btn"
              data-active={effectiveMode === 'send' ? 'true' : undefined}
              aria-pressed={effectiveMode === 'send'}
              onClick={() => onModeChange('send')}
            >
              发给对方
            </button>
          ) : null}
        </div>
      </div>

      <div className="office-mailbox-cli-command-row">
        <code className="office-mailbox-cli-code" title={cliCommandText}>
          {cliCommandText}
        </code>
        <AppButton
          size="small"
          appVariant="primary"
          icon={isCopied ? <CheckOutlined /> : <CopyOutlined />}
          onClick={() =>
            onCopy(copyId, cliCommandText, '已复制 CLI 命令，可在终端填写正文后执行')
          }
        >
          {isCopied ? '已复制' : '复制命令'}
        </AppButton>
      </div>
    </footer>
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
  initialMessageId,
  compactHeader = false,
}) => {
  const folder: MailboxFolder = 'all';
  const [stateFilter, setStateFilter] = useState<MailboxStateFilter>('attention');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(
    () => initialMessageId ?? null,
  );
  const [pinnedMessageId, setPinnedMessageId] = useState<string | null>(
    () => initialMessageId ?? null,
  );
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [activeThreadMessageId, setActiveThreadMessageId] = useState<string | null>(null);
  const [locallyReadIds, setLocallyReadIds] = useState<Set<string>>(() => new Set());
  const [bodyMode, setBodyMode] = useState<BodyRenderMode>('prose');
  const [cliMode, setCliMode] = useState<CliCommandMode>('reply');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, CLOCK_TICK_MS);
    return () => {
      window.clearInterval(timer);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setNowMs(Date.now());
  }, [allMessages]);

  useEffect(() => {
    if (initialMessageId) {
      setSelectedMessageId(initialMessageId);
      setPinnedMessageId(initialMessageId);
    }
  }, [initialMessageId]);

  const repliedIds = useMemo(() => buildRepliedMessageIdSet(allMessages), [allMessages]);

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
        'all',
        nowMs,
      ),
    [activeRoom, allMessages, focusedSession, folder, nowMs, scope, searchQuery, stateFilter],
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

  const handleToggleLocalRead = useCallback((messageId: string) => {
    setLocallyReadIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  const handleSelectScope = useCallback(
    (nextScope: MailboxScope) => {
      setPinnedMessageId(null);
      onScopeChange(nextScope);
    },
    [onScopeChange],
  );

  const handleSelectStateFilter = useCallback((nextState: MailboxStateFilter) => {
    setPinnedMessageId(null);
    setStateFilter((current) => (current === nextState && nextState !== 'all' ? 'all' : nextState));
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setPinnedMessageId(null);
    setSearchQuery(value);
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

  const scopeOptions = useMemo<ScopeOptionItem[]>(() => {
    const items: ScopeOptionItem[] = [];

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
      count: activeRoom?.roomMessages.length,
      icon: ApartmentOutlined,
      disabled: !activeRoom,
      tooltip: activeRoom
        ? `${activeRoom.projectName} · ${activeRoom.roomMessages.length} 条消息`
        : '当前未选择项目房间',
    });

    items.push({
      key: 'unassigned',
      label: '未归属',
      count: unassignedMessages.length,
      icon: HistoryOutlined,
      tooltip: `含未解析端点 ${unassignedMessages.length} 条（完全未归属 ${fullyUnassignedCount} 条）`,
    });

    items.push({
      key: 'all',
      label: '全部',
      count: counts.total,
      icon: GlobalOutlined,
      tooltip: `当前服务器全部 ${counts.total} 条协作消息`,
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

  const activeFolderLabel = stateFilter === 'attention' ? '待处理消息' : '全部消息';

  const headerSubtitle = useMemo(() => {
    let scopePart = '全部消息';
    if (scope === 'session') {
      scopePart = focusedSession
        ? `工位 · ${focusedSession.shortLabel || focusedSession.label}`
        : '工位范围（未选中）';
    } else if (scope === 'room') {
      scopePart = activeRoom ? `房间 · ${activeRoom.projectName}` : '项目房间（未选择）';
    } else if (scope === 'unassigned') {
      scopePart = '未归属消息';
    }
    return stateFilter === 'attention' ? `${scopePart} · 只看待处理` : scopePart;
  }, [activeRoom, focusedSession, scope, stateFilter]);

  const visibleCount = mailboxView.filteredMessages.length;

  const hasActiveFilter =
    stateFilter !== 'all'
    || searchQuery.trim().length > 0;

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
      aria-label="协作消息"
    >
      <MailboxHeader
        compactHeader={compactHeader}
        scope={scope}
        scopeOptions={scopeOptions}
        subtitle={headerSubtitle}
        searchQuery={searchQuery}
        loading={loading}
        hasMessages={allMessages.length > 0}
        pendingOnly={stateFilter === 'attention'}
        pendingCount={mailboxView.attentionCount}
        error={error}
        onSelectScope={handleSelectScope}
        onTogglePending={() => handleSelectStateFilter('attention')}
        onSearchChange={handleSearchChange}
        onRefresh={onRefresh}
      />

      <div className="office-mailbox-body">
        <MailboxListPane
          folder={folder}
          activeFolderLabel={activeFolderLabel}
          visibleCount={visibleCount}
          hasActiveFilter={hasActiveFilter}
          loading={loading}
          scope={scope}
          activeRoom={activeRoom}
          totalCount={counts.total}
          threads={mailboxView.threads}
          messages={mailboxView.filteredMessages}
          selectedThreadId={selectedThread?.threadId ?? null}
          selectedMessageId={selectedMessage?.id ?? null}
          nowMs={nowMs}
          repliedIds={repliedIds}
          locallyReadIds={locallyReadIds}
          onResetFilters={handleResetFilters}
          onSelectScope={handleSelectScope}
          onSelectThread={(thread) => {
            setPinnedMessageId(null);
            setSelectedThreadId(thread.threadId);
            setActiveThreadMessageId(thread.latestMessage.id);
          }}
          onSelectMessage={(item) => {
            setPinnedMessageId(null);
            setSelectedMessageId(item.id);
          }}
          onRefresh={onRefresh}
        />

        <div className="office-mailbox-reader-pane">
          <div className="office-mailbox-reader-scroll">
            {folder === 'threads' ? (
              selectedThread ? (
                <div className="office-mailbox-thread-view">
                  <header className="office-mailbox-thread-header">
                    <h2 className="office-mailbox-subject">
                      {selectedThread.subjectLine || '(无主题会话串)'}
                    </h2>
                    <div className="office-mailbox-meta-badges">
                      <span className="office-mailbox-micro-badge">
                        <BranchesOutlined aria-hidden="true" />
                        <span>共 {selectedThread.messageCount} 条</span>
                      </span>
                      {selectedThread.isCrossProject ? (
                        <span className="office-mailbox-micro-badge">
                          <SwapOutlined aria-hidden="true" />
                          <span>跨项目</span>
                        </span>
                      ) : null}
                    </div>
                  </header>

                  <div className="office-mailbox-thread-timeline">
                    {sortedThreadMessages.map((threadMsg, index) => (
                      <div key={threadMsg.id} className="office-mailbox-thread-step">
                        <div className="office-mailbox-thread-step-label">
                          #{index + 1} · {formatAbsoluteTimestamp(threadMsg.raw.createdAt)}
                        </div>
                        <MailDetailArticle
                          messageItem={threadMsg}
                          allMessages={allMessages}
                          allRooms={allRooms}
                          focusedSession={focusedSession}
                          activeRoom={activeRoom}
                          nowMs={nowMs}
                          repliedIds={repliedIds}
                          isLocallyRead={locallyReadIds.has(threadMsg.id)}
                          onToggleLocalRead={handleToggleLocalRead}
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
                    title="选择一组回复链"
                    description="从左侧列表选择回复链以按时间顺序查看。"
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
                nowMs={nowMs}
                repliedIds={repliedIds}
                isLocallyRead={locallyReadIds.has(selectedMessage.id)}
                onToggleLocalRead={handleToggleLocalRead}
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
                  title="选择一条消息查看详情"
                  description="查看联系目的、期望行动、投递状态与原文记录。"
                />
              </div>
            )}
          </div>

          {cliTargetMessage ? (
            <MailboxCliFooter
              targetMessage={cliTargetMessage}
              cliMode={cliMode}
              cliSendTarget={cliSendTarget}
              cliCommandText={cliCommandText}
              copiedKey={copiedKey}
              onModeChange={setCliMode}
              onCopy={handleCopy}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
};

export default OfficeMailbox;
