import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import {
  ApartmentOutlined,
  BranchesOutlined,
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
  InboxOutlined,
  InfoCircleOutlined,
  LockOutlined,
  MailOutlined,
  ReloadOutlined,
  RightOutlined,
  RollbackOutlined,
  SendOutlined,
  SwapOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Button, Input, Tooltip, message } from 'antd';
import HudStateView from '@/components/hud/HudStateView';
import { writeClipboardText } from '@/utils/clipboard';
import {
  buildExplicitReplyChain,
  evaluateMailLifecycle,
  formatAbsoluteTimestamp,
} from './peer-message-presentation';
import { buildSessionMailboxView } from './session-office-model';
import type {
  EnrichedPeerMessage,
  MailboxFolder,
  MailboxReplyFilter,
  MailboxScope,
  MailboxStateFilter,
  OfficeProjectRoom,
  OfficeSessionItem,
  PeerCounts,
  PeerFieldProvenance,
  PeerThreadGroup,
  ReadablePartySummary,
  ResolvedPeerEndpoint,
  ResolvedReplyPolicyKind,
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

const CLOCK_TICK_MS = 30_000;

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
      return 'unresolved（外部或历史会话端点，未猜测归属）';
  }
}

function getProvenanceFieldNote(source: PeerFieldProvenance): string {
  switch (source) {
    case 'explicit':
      return '结构化字段';
    case 'classified':
      return '系统归类';
    case 'extracted':
      return '原文明示/提取';
    case 'unknown':
    default:
      return '未说明';
  }
}

function getReplyPolicyPillTone(kind: ResolvedReplyPolicyKind): 'warning' | 'info' | 'neutral' {
  switch (kind) {
    case 'required':
      return 'warning';
    case 'optional':
      return 'info';
    case 'none':
    case 'unknown':
    default:
      return 'neutral';
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
 * and real target endpoint. Human display summaries never replace raw message body.
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

interface ReadablePartyCardProps {
  roleLabel: '发件方' | '收件方';
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
          <Tooltip title="短会话标识（完整 UUID 请见下方技术详情）">
            <span className="office-mailbox-party-short-id">{readable.shortIdentity}</span>
          </Tooltip>
        ) : null}
      </div>

      <div className="office-mailbox-party-main">
        <strong className="office-mailbox-party-name" title={readable.shortName}>
          {readable.shortName}
        </strong>
        <div className="office-mailbox-party-foot">
          {readable.hasKnownProject || matchedRoom ? (
            <Tooltip title={projectPathHint}>
              <span className="office-mailbox-project-badge">
                <FolderOpenOutlined aria-hidden="true" />
                <span>{projectDisplay}</span>
              </span>
            </Tooltip>
          ) : (
            <span className="office-mailbox-project-badge office-mailbox-project-badge--muted">
              <HistoryOutlined aria-hidden="true" />
              <span>{projectDisplay}</span>
            </span>
          )}

          {endpoint.sessionKey && onJumpToSession ? (
            <Button
              size="small"
              type="default"
              disabled={isCurrentDesk}
              icon={isCrossRoomJump ? <EnvironmentOutlined /> : <DesktopOutlined />}
              onClick={(event) => {
                event.stopPropagation();
                onJumpToSession(endpoint.sessionKey!, endpoint.projectKey);
              }}
            >
              {isCurrentDesk ? '当前工位' : isCrossRoomJump ? '前往对方房间' : '前往工位'}
            </Button>
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
  const [techExpanded, setTechExpanded] = useState(false);

  const lifecycle = useMemo(
    () => evaluateMailLifecycle(messageItem, nowMs),
    [messageItem, nowMs],
  );
  const deliveryError = useMemo(
    () => getCombinedDeliveryError(messageItem),
    [messageItem],
  );
  const explicitChain = useMemo(
    () => (isThreadCard ? { hasExplicitChain: false, rootMissingShortId: '', nodes: [] } : buildExplicitReplyChain(messageItem, allMessages)),
    [allMessages, isThreadCard, messageItem],
  );

  const supersedesMessage = useMemo(() => {
    const ref = String(messageItem.raw.supersedes ?? '').trim();
    if (!ref) return null;
    return allMessages.find((item) => item.id === ref || item.shortId === ref) ?? null;
  }, [allMessages, messageItem.raw.supersedes]);

  const { presentation, fromReadable, toReadable } = messageItem;
  const replyPolicyTone = getReplyPolicyPillTone(presentation.replyPolicyKind);
  const shortMsgId = messageItem.shortId || messageItem.id.slice(0, 8);
  const idCopyKey = `id:${messageItem.id}`;
  const bodyCopyKey = `body:${messageItem.id}`;
  const rawBodyVerbatim = messageItem.raw.body;

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
      {/* 1. Readable Title + Status & Provenance Header */}
      <header className="office-mailbox-article-head">
        <div className="office-mailbox-subject-row">
          <h2 className="office-mailbox-subject">
            {presentation.title}
          </h2>

          <div className="office-mailbox-head-actions">
            <span className="office-mailbox-provenance-chip" title="摘要字段来源说明">
              {presentation.provenanceLabel}
            </span>
            <Tooltip title="短消息标识；展开底部技术详情可查看完整 UUID">
              <span className="office-mailbox-short-id">#{shortMsgId}</span>
            </Tooltip>
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

        <div className="office-mailbox-meta-badges">
          <span className={`office-mailbox-state-pill office-mailbox-state-pill--${lifecycle.pillTone}`}>
            <span
              className={`hud-led hud-led--${lifecycle.ledTone === 'neutral' ? 'info' : lifecycle.ledTone}`}
              aria-hidden="true"
            />
            <span>{lifecycle.label}</span>
          </span>

          <span className={`office-mailbox-state-pill office-mailbox-state-pill--${replyPolicyTone}`}>
            <span>回复要求：{presentation.replyPolicyLabel}</span>
          </span>

          {messageItem.isCrossProject ? (
            <span className="office-mailbox-micro-badge office-mailbox-micro-badge--accent">
              <SwapOutlined aria-hidden="true" />
              <span>跨项目协作</span>
            </span>
          ) : null}

          {messageItem.isFullyUnassigned ? (
            <span className="office-mailbox-micro-badge office-mailbox-micro-badge--warn">
              <HistoryOutlined aria-hidden="true" />
              <span>历史 / 外部消息</span>
            </span>
          ) : messageItem.hasUnresolvedParty ? (
            <span className="office-mailbox-micro-badge office-mailbox-micro-badge--muted">
              <HistoryOutlined aria-hidden="true" />
              <span>含历史或外部会话</span>
            </span>
          ) : null}

          {messageItem.raw.supersedes ? (
            supersedesMessage ? (
              <Button
                size="small"
                type="link"
                className="office-mailbox-reply-link"
                onClick={(event) => {
                  event.stopPropagation();
                  onJumpToMessage(supersedesMessage);
                }}
              >
                替代旧消息 #{supersedesMessage.shortId}
              </Button>
            ) : (
              <span className="office-mailbox-micro-badge office-mailbox-micro-badge--muted">
                替代 #{messageItem.raw.supersedes.slice(0, 8)}
              </span>
            )
          ) : null}

          {messageItem.supersededByIds.length > 0 ? (
            <span className="office-mailbox-micro-badge office-mailbox-micro-badge--warn">
              已被新消息 #{messageItem.supersededByIds.join(', #')} 替代
            </span>
          ) : null}
        </div>
      </header>

      {/* 2. Readable Sender / Project & Recipient / Project */}
      <div className="office-mailbox-parties">
        <ReadablePartyCard
          roleLabel="发件方"
          endpoint={messageItem.fromResolved}
          readable={fromReadable}
          allRooms={allRooms}
          focusedSession={focusedSession}
          activeRoom={activeRoom}
          onJumpToSession={onJumpToSession}
        />
        <ReadablePartyCard
          roleLabel="收件方"
          endpoint={messageItem.toResolved}
          readable={toReadable}
          allRooms={allRooms}
          focusedSession={focusedSession}
          activeRoom={activeRoom}
          onJumpToSession={onJumpToSession}
        />
      </div>

      {/* 3. Structured Human Digest: Purpose, Action Required, Timing & Validity */}
      <section className="office-mailbox-digest" aria-label="邮件可读要点">
        <div className="office-mailbox-digest-grid">
          <div className="office-mailbox-digest-item">
            <div className="office-mailbox-digest-label">
              <span>联系目的（为何联系）</span>
              {presentation.purposeSource === 'classified' ? (
                <span className="office-mailbox-digest-tag office-mailbox-digest-tag--classified">系统归类</span>
              ) : presentation.purposeSource === 'extracted' ? (
                <span className="office-mailbox-digest-tag">原文明示/提取</span>
              ) : null}
            </div>
            <div
              className={`office-mailbox-digest-value${presentation.purposeSource === 'unknown' ? ' is-unknown' : ''}`}
            >
              {presentation.purpose}
            </div>
          </div>

          <div className="office-mailbox-digest-item">
            <div className="office-mailbox-digest-label">
              <span>收件会话待办 / 行动说明</span>
              {presentation.actionSource === 'classified' ? (
                <span className="office-mailbox-digest-tag office-mailbox-digest-tag--classified">系统归类</span>
              ) : presentation.actionSource === 'extracted' ? (
                <span className="office-mailbox-digest-tag">原文标注</span>
              ) : null}
            </div>
            <div
              className={`office-mailbox-digest-value${presentation.actionSource === 'unknown' ? ' is-unknown' : ''}`}
            >
              <span>{presentation.actionText}</span>
              {presentation.actionSource !== 'unknown' ? (
                <span className="office-mailbox-caveat">
                  仅转述发送方对收件会话的请求说明，不构成超出当前批准任务的额外授权。
                </span>
              ) : null}
            </div>
          </div>

          <div className="office-mailbox-digest-item">
            <div className="office-mailbox-digest-label">
              <ClockCircleOutlined aria-hidden="true" />
              <span>发送时间 vs 送达时间（绝对时间）</span>
            </div>
            <div className="office-mailbox-time-pair">
              <span>
                <em>发送：</em>
                <strong>{lifecycle.sentAbsoluteText}</strong>
              </span>
              <span>
                <em>送达：</em>
                <strong className={lifecycle.isUndelivered ? 'is-undelivered' : undefined}>
                  {lifecycle.deliveredAbsoluteText}
                </strong>
              </span>
              {messageItem.raw.readAt > 0 ? (
                <span>
                  <em>读取记录：</em>
                  <strong>{lifecycle.readAbsoluteText}</strong>
                </span>
              ) : null}
            </div>
          </div>

          <div className="office-mailbox-digest-item">
            <div className="office-mailbox-digest-label">
              <InfoCircleOutlined aria-hidden="true" />
              <span>时效与状态说明</span>
            </div>
            <div className="office-mailbox-digest-value">
              <span>{lifecycle.validitySummary}</span>
              <span className="office-mailbox-caveat">{lifecycle.processingCaveat}</span>
            </div>
          </div>
        </div>

        <div className="office-mailbox-summary-row">
          <span className="office-mailbox-digest-label">
            <span>可读摘要</span>
            <span
              className={`office-mailbox-digest-tag${presentation.summarySource === 'classified' ? ' office-mailbox-digest-tag--classified' : ''}`}
            >
              {presentation.summarySource === 'classified'
                ? '系统归类（可核对原文）'
                : getProvenanceFieldNote(presentation.summarySource)}
            </span>
          </span>
          <p className="office-mailbox-summary-text">{presentation.summary}</p>
        </div>

        {presentation.jargonHints.length > 0 ? (
          <div className="office-mailbox-jargon-row" aria-label="原文常见术语说明">
            <span className="office-mailbox-jargon-label">原文术语参考：</span>
            {presentation.jargonHints.map((hint) => (
              <span key={hint.term} className="office-mailbox-jargon-chip">
                <code>{hint.term}</code>
                <span>= {hint.meaning}</span>
              </span>
            ))}
          </div>
        ) : null}

        {deliveryError ? (
          <div className="office-mailbox-delivery-error" role="status">
            <span className="hud-led hud-led--err" aria-hidden="true" />
            <ExclamationCircleOutlined aria-hidden="true" />
            <span className="office-mailbox-delivery-error-label">投递异常记录：</span>
            <span className="office-mailbox-delivery-error-text">{deliveryError}</span>
          </div>
        ) : null}
      </section>

      {/* 4. Explicit replyTo Threaded Chain (only when explicit replyTo links exist) */}
      {!isThreadCard && explicitChain.hasExplicitChain ? (
        <section className="office-mailbox-chain-box" aria-label="显式回复链">
          <div className="office-mailbox-chain-head">
            <span className="office-mailbox-chain-title">
              <BranchesOutlined aria-hidden="true" />
              <span>显式回复链（按 replyTo 串联 · 共 {explicitChain.nodes.length} 封）</span>
            </span>
            {onOpenThread && explicitChain.nodes.length > 1 ? (
              <Button
                size="small"
                type="text"
                icon={<BranchesOutlined />}
                onClick={() => onOpenThread(messageItem.threadRootId)}
              >
                在会话串视图展开
              </Button>
            ) : null}
          </div>

          <div className="office-mailbox-chain-list">
            {explicitChain.rootMissingShortId ? (
              <div className="office-mailbox-chain-missing">
                <RollbackOutlined aria-hidden="true" />
                <span>早期父消息 #{explicitChain.rootMissingShortId} 不在当前队列缓存中</span>
              </div>
            ) : null}

            {explicitChain.nodes.map((node, index) => {
              const nodeLifecycle = evaluateMailLifecycle(node.message, nowMs);
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
                    <span className={`office-mailbox-state-pill office-mailbox-state-pill--${nodeLifecycle.pillTone}`}>
                      {nodeLifecycle.shortLabel}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* 5. Unchanged Original Body */}
      <div className="office-mailbox-body-panel">
        <div className="office-mailbox-body-toolbar">
          <span className="office-mailbox-body-title">
            <FileTextOutlined aria-hidden="true" />
            <span>原始正文（完整未改写）</span>
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
                onCopy(bodyCopyKey, rawBodyVerbatim, '原始正文已原样复制');
              }}
            >
              {copiedKey === bodyCopyKey ? '已复制原文' : '复制原文'}
            </Button>
          </div>
        </div>

        <pre className="office-mailbox-body-content" data-mode={bodyMode}>
          {rawBodyVerbatim.length > 0 ? rawBodyVerbatim : '(空正文)'}
        </pre>
      </div>

      {/* 6. Expandable Technical & Delivery Provenance Details */}
      <section className="office-mailbox-tech-panel" aria-label="技术详情与投递审计">
        <button
          type="button"
          className="office-mailbox-tech-toggle"
          aria-expanded={techExpanded}
          onClick={(event) => {
            event.stopPropagation();
            setTechExpanded((prev) => !prev);
          }}
        >
          <span className="office-mailbox-tech-toggle-left">
            {techExpanded ? <DownOutlined aria-hidden="true" /> : <RightOutlined aria-hidden="true" />}
            <span>技术详情与投递审计（完整 UUID · 历史累计尝试 {lifecycle.attemptCount} 次 / 目标检查 {lifecycle.probeCount ?? '未记录'}）</span>
          </span>
          <span className="office-mailbox-tech-toggle-hint">
            {techExpanded ? '收起' : '展开'}
          </span>
        </button>

        {techExpanded ? (
          <div className="office-mailbox-tech-body" onClick={(event) => event.stopPropagation()}>
            <div className="office-mailbox-tech-actions">
              <Button
                size="small"
                icon={copiedKey === idCopyKey ? <CheckOutlined /> : <CopyOutlined />}
                onClick={() => onCopy(idCopyKey, messageItem.id, '完整消息 ID 已复制')}
              >
                {copiedKey === idCopyKey ? '已复制完整消息 ID' : '复制完整消息 ID'}
              </Button>
            </div>

            <div className="office-mailbox-audit-grid">
              <div>
                <span>历史累计尝试 (attemptCount)</span>
                <strong>{lifecycle.attemptCount} 次（旧版可能包含忙碌检查，不代表实际发送次数）</strong>
              </div>
              <div>
                <span>目标检查 (probeCount)</span>
                <strong>
                  {lifecycle.probeCount !== null
                    ? `${lifecycle.probeCount} 次（目标级忙碌检查，不是本消息发送次数）`
                    : '未记录（目标级忙碌检查，不是本消息发送次数）'}
                </strong>
              </div>
              <div>
                <span>队列状态 / 调度状态</span>
                <strong>
                  state={messageItem.raw.state || '-'} · notification={messageItem.raw.notificationState || '未记录'}
                </strong>
              </div>
              <div>
                <span>自动通知窗口 (autoDeliverUntil)</span>
                <strong>{formatAbsoluteTimestamp(messageItem.raw.autoDeliverUntil)}</strong>
              </div>
              <div>
                <span>语义过期时间 (expiresAt)</span>
                <strong>
                  {messageItem.raw.expiresAt
                    ? formatAbsoluteTimestamp(messageItem.raw.expiresAt)
                    : '无语义过期 (0)'}
                </strong>
              </div>
              <div>
                <span>取消时间 (canceledAt)</span>
                <strong>{formatAbsoluteTimestamp(messageItem.raw.canceledAt)}</strong>
              </div>
              <div>
                <span>忙碌起始 / 调度原因 (waitingReason)</span>
                <strong>
                  {messageItem.raw.busySince ? formatAbsoluteTimestamp(messageItem.raw.busySince) : '-'}
                  {messageItem.raw.waitingReason ? ` · ${messageItem.raw.waitingReason}` : ''}
                </strong>
              </div>
              <div>
                <span>下次重试时间 (nextAttemptAt)</span>
                <strong>{formatAbsoluteTimestamp(messageItem.raw.nextAttemptAt)}</strong>
              </div>
            </div>

            <dl className="office-mailbox-tech-kv">
              <div>
                <dt>完整消息 ID</dt>
                <dd><code>{messageItem.id}</code></dd>
              </div>
              <div>
                <dt>replyTo 原始值</dt>
                <dd><code>{messageItem.raw.replyTo || '无'}</code></dd>
              </div>
              <div>
                <dt>supersedes 原始值</dt>
                <dd><code>{messageItem.raw.supersedes || '无'}</code></dd>
              </div>
              <div>
                <dt>可读字段来源</dt>
                <dd>
                  标题={getProvenanceFieldNote(presentation.titleSource)} · 摘要={getProvenanceFieldNote(presentation.summarySource)} · 目的={getProvenanceFieldNote(presentation.purposeSource)} · 行动={getProvenanceFieldNote(presentation.actionSource)} · 回复策略={getProvenanceFieldNote(presentation.replyPolicySource)}
                </dd>
              </div>
              <div>
                <dt>发件方原始标识</dt>
                <dd>
                  <code>
                    channel={messageItem.raw.from.channel || '-'} · provider={messageItem.raw.from.provider || '-'} · name={messageItem.raw.from.name || '-'} · address={messageItem.raw.from.address || '-'} · sessionId={messageItem.raw.from.sessionId || '-'}
                    {messageItem.fromResolved.sessionKey ? ` · sessionKey=${messageItem.fromResolved.sessionKey}` : ''}
                  </code>
                  <span className="office-mailbox-tech-basis">
                    {getMatchBasisLabel(messageItem.fromResolved.matchBasis)}
                  </span>
                </dd>
              </div>
              <div>
                <dt>收件方原始标识</dt>
                <dd>
                  <code>
                    channel={messageItem.raw.to.channel || '-'} · provider={messageItem.raw.to.provider || '-'} · name={messageItem.raw.to.name || '-'} · address={messageItem.raw.to.address || '-'} · sessionId={messageItem.raw.to.sessionId || '-'}
                    {messageItem.toResolved.sessionKey ? ` · sessionKey=${messageItem.toResolved.sessionKey}` : ''}
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
  const [stateFilter, setStateFilter] = useState<MailboxStateFilter>('all');
  const [replyFilter, setReplyFilter] = useState<MailboxReplyFilter>('all');
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
        replyFilter,
        nowMs,
      ),
    [activeRoom, allMessages, focusedSession, folder, nowMs, replyFilter, scope, searchQuery, stateFilter],
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

  const handleToggleStateFilter = useCallback((nextState: MailboxStateFilter) => {
    setPinnedMessageId(null);
    setStateFilter((current) => (current === nextState && nextState !== 'all' ? 'all' : nextState));
  }, []);

  const handleToggleReplyFilter = useCallback((nextReply: MailboxReplyFilter) => {
    setPinnedMessageId(null);
    setReplyFilter((current) => (current === nextReply && nextReply !== 'all' ? 'all' : nextReply));
  }, []);

  const handleResetFilters = useCallback(() => {
    setPinnedMessageId(null);
    setStateFilter('all');
    setReplyFilter('all');
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
        setReplyFilter('all');
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
      return `完全未归属 ${fullyUnassignedCount} · 单端历史 ${partialCount}`;
    }
    return `全量消息队列 (${counts.total})`;
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

  const stateFilterItems: ReadonlyArray<{
    key: MailboxStateFilter;
    label: string;
    count?: number;
    ledTone?: 'warn' | 'info' | 'ok' | 'err';
  }> = [
    { key: 'all', label: '全部状态', count: folder === 'threads' ? mailboxView.threadCount : mailboxView.allCount },
    { key: 'undelivered', label: '尚未送达', count: mailboxView.undeliveredCount, ledTone: 'warn' },
    { key: 'stale', label: '滞留 / 待人工', count: mailboxView.staleCount, ledTone: 'warn' },
    { key: 'delivered', label: '已送达 / 已读', count: mailboxView.deliveredOrReadCount, ledTone: 'ok' },
    { key: 'attention', label: '失败 / 过期 / 取消', count: mailboxView.attentionCount, ledTone: 'err' },
  ];

  const replyFilterItems: ReadonlyArray<{
    key: MailboxReplyFilter;
    label: string;
    count?: number;
  }> = [
    { key: 'all', label: '全部回复要求' },
    { key: 'required', label: '明确需回复', count: mailboxView.replyRequiredCount },
    { key: 'none', label: '无需回复', count: mailboxView.noReplyCount },
    { key: 'threaded', label: '显式回复链', count: mailboxView.threadedMsgCount },
    { key: 'unspecified', label: '未说明要求', count: mailboxView.unspecifiedReplyCount },
  ];

  const visibleCount =
    folder === 'threads'
      ? mailboxView.threads.length
      : mailboxView.filteredMessages.length;

  const hasActiveFilter =
    stateFilter !== 'all'
    || replyFilter !== 'all'
    || searchQuery.trim().length > 0;
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
                  <span>协作邮箱</span>
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
              placeholder="搜索标题、目的、行动、项目、原文…"
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
          <div className="office-mailbox-summary-pills" aria-label="当前目录投递状态快筛">
            <button
              type="button"
              className="office-mailbox-summary-pill"
              data-active={stateFilter === 'all' ? 'true' : undefined}
              aria-pressed={stateFilter === 'all'}
              onClick={() => handleToggleStateFilter('all')}
            >
              当前范围 {mailboxView.allCount}
            </button>
            <button
              type="button"
              className="office-mailbox-summary-pill office-mailbox-summary-pill--warn"
              data-active={stateFilter === 'undelivered' ? 'true' : undefined}
              aria-pressed={stateFilter === 'undelivered'}
              onClick={() => handleToggleStateFilter('undelivered')}
            >
              <span className="hud-led hud-led--warn" aria-hidden="true" />
              尚未送达 {mailboxView.undeliveredCount}
            </button>
            <button
              type="button"
              className="office-mailbox-summary-pill office-mailbox-summary-pill--warn"
              data-active={stateFilter === 'stale' ? 'true' : undefined}
              aria-pressed={stateFilter === 'stale'}
              onClick={() => handleToggleStateFilter('stale')}
            >
              滞留/待人工 {mailboxView.staleCount}
            </button>
            <button
              type="button"
              className="office-mailbox-summary-pill office-mailbox-summary-pill--ok"
              data-active={stateFilter === 'delivered' ? 'true' : undefined}
              aria-pressed={stateFilter === 'delivered'}
              onClick={() => handleToggleStateFilter('delivered')}
            >
              <span className="hud-led hud-led--ok" aria-hidden="true" />
              已送达/已读 {mailboxView.deliveredOrReadCount}
            </button>
            <button
              type="button"
              className="office-mailbox-summary-pill office-mailbox-summary-pill--err"
              data-active={stateFilter === 'attention' ? 'true' : undefined}
              aria-pressed={stateFilter === 'attention'}
              onClick={() => handleToggleStateFilter('attention')}
            >
              <span className="hud-led hud-led--err" aria-hidden="true" />
              失败/过期/取消 {mailboxView.attentionCount}
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
        {/* Left Folder & Multi-Dimension Filter Rail */}
        <aside className="office-mailbox-rail" aria-label="文件夹与筛选">
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
            <div className="office-mailbox-rail-heading">投递与时效</div>
            <div className="office-mailbox-filter-list" role="group" aria-label="按投递状态筛选">
              {stateFilterItems.map((item) => {
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
                    <span className="office-mailbox-folder-left">
                      {item.ledTone ? (
                        <span className={`hud-led hud-led--${item.ledTone}`} aria-hidden="true" />
                      ) : (
                        <EyeOutlined aria-hidden="true" />
                      )}
                      <span>{item.label}</span>
                    </span>
                    {typeof item.count === 'number' ? (
                      <span className="office-mailbox-folder-count">{item.count}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="office-mailbox-rail-section">
            <div className="office-mailbox-rail-heading">回复与线程</div>
            <div className="office-mailbox-filter-list" role="group" aria-label="按回复要求筛选">
              {replyFilterItems.map((item) => {
                const active = replyFilter === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    className="office-mailbox-filter-btn"
                    data-active={active ? 'true' : undefined}
                    aria-pressed={active}
                    onClick={() => handleToggleReplyFilter(item.key)}
                  >
                    <span className="office-mailbox-folder-left">
                      <span>{item.label}</span>
                    </span>
                    {typeof item.count === 'number' ? (
                      <span className="office-mailbox-folder-count">{item.count}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="office-mailbox-readonly-note" role="note">
            <LockOutlined aria-hidden="true" />
            <span>只读查阅队列 · “已送达/已读”仅反映传输状态，不代表已处理完成</span>
          </div>
        </aside>

        {/* Middle Compact Mail / Thread List Pane */}
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
                  title="正在读取协作邮件"
                  description="同步会话映射、可读摘要与最新投递状态"
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
                            : '暂无协作邮件'
                  }
                  description={
                    hasActiveFilter
                      ? '可调整状态/回复筛选条件或清空搜索关键词。'
                      : scope === 'session' && activeRoom
                        ? '可切换到「当前房间」或「全量消息」浏览同项目与历史往来。'
                        : '由 aih peer send / reply 发送的跨会话消息会显示在这里。'
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
                const latestLifecycle = evaluateMailLifecycle(latest, nowMs);
                const hasExplicitReplies =
                  thread.messageCount > 1
                  || Boolean(latest.raw.replyTo || latest.raw.replyToShort);

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
                        title={`${latest.fromReadable.shortName} (${latest.fromReadable.projectLabel}) → ${latest.toReadable.shortName} (${latest.toReadable.projectLabel})`}
                      >
                        <span className="office-mailbox-row-party-text">
                          {latest.fromReadable.shortName}
                          <em className="office-mailbox-row-proj">[{latest.fromReadable.projectLabel}]</em>
                          {' → '}
                          {latest.toReadable.shortName}
                          <em className="office-mailbox-row-proj">[{latest.toReadable.projectLabel}]</em>
                        </span>
                      </span>
                      <span className="office-mailbox-row-id">{thread.messageCount} 封</span>
                    </div>

                    <div className="office-mailbox-row-subject-line">
                      <span className="office-mailbox-row-subject">
                        {thread.subjectLine || '(无标题)'}
                      </span>
                    </div>

                    <div className="office-mailbox-row-intent">
                      <span>目的：{latest.presentation.purpose}</span>
                      <span>·</span>
                      <span>行动：{latest.presentation.actionText}</span>
                    </div>

                    <div className="office-mailbox-row-times">
                      <span>发 {latestLifecycle.sentCompactText}</span>
                      <span>·</span>
                      <span className={latestLifecycle.isUndelivered ? 'is-undelivered' : undefined}>
                        {latestLifecycle.isUndelivered
                          ? latestLifecycle.deliveredCompactText
                          : `达 ${latestLifecycle.deliveredCompactText}`}
                      </span>
                    </div>

                    <div className="office-mailbox-row-badges">
                      <span
                        className={`office-mailbox-state-pill office-mailbox-state-pill--${latestLifecycle.pillTone}`}
                      >
                        <span
                          className={`hud-led hud-led--${latestLifecycle.ledTone === 'neutral' ? 'info' : latestLifecycle.ledTone}`}
                          aria-hidden="true"
                        />
                        {latestLifecycle.shortLabel}
                      </span>
                      {hasExplicitReplies ? (
                        <span className="office-mailbox-micro-badge office-mailbox-micro-badge--accent">
                          <BranchesOutlined aria-hidden="true" /> 回复链
                        </span>
                      ) : null}
                      {thread.isCrossProject ? (
                        <span className="office-mailbox-micro-badge office-mailbox-micro-badge--accent">
                          <SwapOutlined aria-hidden="true" /> 跨项目
                        </span>
                      ) : null}
                    </div>
                  </button>
                );
              })
            ) : (
              mailboxView.filteredMessages.map((item) => {
                const isSelected = selectedMessage?.id === item.id;
                const lifecycle = evaluateMailLifecycle(item, nowMs);
                const direction = getDirectionIndicator(item, focusedSession);
                const hasError = Boolean(getCombinedDeliveryError(item));
                const { presentation, fromReadable, toReadable } = item;

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
                        title={`${fromReadable.shortName} (${fromReadable.projectLabel}) → ${toReadable.shortName} (${toReadable.projectLabel})`}
                      >
                        {direction.code ? (
                          <span className={`office-mailbox-dir-chip office-mailbox-dir-chip--${direction.code}`}>
                            {direction.label}
                          </span>
                        ) : null}
                        <span className="office-mailbox-row-party-text">
                          {fromReadable.shortName}
                          <em className="office-mailbox-row-proj">[{fromReadable.projectLabel}]</em>
                          {' → '}
                          {toReadable.shortName}
                          <em className="office-mailbox-row-proj">[{toReadable.projectLabel}]</em>
                        </span>
                      </span>
                    </div>

                    <div className="office-mailbox-row-subject-line">
                      <span className="office-mailbox-row-subject">
                        {presentation.title}
                      </span>
                    </div>

                    <div className="office-mailbox-row-intent">
                      <span>目的：{presentation.purpose}</span>
                      <span>·</span>
                      <span>行动：{presentation.actionText}</span>
                    </div>

                    <div
                      className="office-mailbox-row-times"
                      title={`发送: ${lifecycle.sentAbsoluteText} | 送达: ${lifecycle.deliveredAbsoluteText}`}
                    >
                      <span>发 {lifecycle.sentCompactText}</span>
                      <span>·</span>
                      <span className={lifecycle.isUndelivered ? 'is-undelivered' : undefined}>
                        {lifecycle.isUndelivered
                          ? lifecycle.deliveredCompactText
                          : `达 ${lifecycle.deliveredCompactText}`}
                      </span>
                    </div>

                    <div className="office-mailbox-row-badges">
                      <span
                        className={`office-mailbox-state-pill office-mailbox-state-pill--${lifecycle.pillTone}`}
                      >
                        <span
                          className={`hud-led hud-led--${lifecycle.ledTone === 'neutral' ? 'info' : lifecycle.ledTone}`}
                          aria-hidden="true"
                        />
                        {lifecycle.shortLabel}
                      </span>

                      {presentation.legacyCategory ? (
                        <span className="office-mailbox-micro-badge">
                          系统归类
                        </span>
                      ) : null}

                      {presentation.replyPolicyKind === 'required' ? (
                        <span className="office-mailbox-micro-badge office-mailbox-micro-badge--warn">
                          需回复
                        </span>
                      ) : presentation.replyPolicyKind === 'none' ? (
                        <span className="office-mailbox-micro-badge office-mailbox-micro-badge--muted">
                          {presentation.replyPolicyLabel}
                        </span>
                      ) : presentation.replyPolicyKind === 'optional' ? (
                        <span className="office-mailbox-micro-badge">
                          可选回复
                        </span>
                      ) : null}

                      {item.raw.replyTo || item.raw.replyToShort ? (
                        <span className="office-mailbox-micro-badge office-mailbox-micro-badge--accent">
                          ↩ 回复 #{item.raw.replyToShort || item.raw.replyTo.slice(0, 6)}
                        </span>
                      ) : null}

                      {item.isCrossProject ? (
                        <span className="office-mailbox-micro-badge office-mailbox-micro-badge--accent">
                          <SwapOutlined aria-hidden="true" /> 跨项目
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

        {/* Right Human-First Reading Pane */}
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
                      <span className="office-mailbox-micro-badge office-mailbox-micro-badge--accent">
                        <BranchesOutlined aria-hidden="true" />
                        <span>时间线共 {selectedThread.messageCount} 封</span>
                      </span>
                      {selectedThread.isCrossProject ? (
                        <span className="office-mailbox-micro-badge office-mailbox-micro-badge--accent">
                          <SwapOutlined aria-hidden="true" />
                          <span>跨项目会话串</span>
                        </span>
                      ) : null}
                    </div>
                  </header>

                  <div className="office-mailbox-thread-timeline">
                    {sortedThreadMessages.map((threadMsg, index) => (
                      <div key={threadMsg.id} className="office-mailbox-thread-step">
                        <div className="office-mailbox-thread-step-label">
                          <span>
                            #{index + 1} · 发送于 {formatAbsoluteTimestamp(threadMsg.raw.createdAt)}
                          </span>
                        </div>
                        <MailDetailArticle
                          messageItem={threadMsg}
                          allMessages={allMessages}
                          allRooms={allRooms}
                          focusedSession={focusedSession}
                          activeRoom={activeRoom}
                          nowMs={nowMs}
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
                    description="从中间列表选择会话串，按发送时间顺序查阅完整往来。"
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
                  description="默认展示可读发收件人、联系目的、所需行动与绝对时间，并保留完整原文与技术详情。"
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
                  <span className="office-mailbox-cli-badge">
                    只读模板 · 保留原始标识，建议写清主题/目的/待办/回复要求
                  </span>
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
                      发送给此会话
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
                      'CLI 回复命令模板已复制，可在工位终端填写正文后执行',
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
