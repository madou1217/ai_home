import { useEffect, useMemo, useState, type FC, type ReactNode, type RefObject } from 'react';
import {
  ArrowLeftOutlined,
  BranchesOutlined,
  CheckOutlined,
  CodeOutlined,
  CopyOutlined,
  DesktopOutlined,
  DownOutlined,
  EnvironmentOutlined,
  EyeOutlined,
  HistoryOutlined,
  RightOutlined,
  RollbackOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { Tooltip } from 'antd';
import HudStateView from '@/components/hud/HudStateView';
import AppButton from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import {
  MailStateTag,
  buildCliHelperCommand,
  findEndpointRoom,
  formatRelativeTime,
  getCombinedDeliveryError,
  getMatchBasisLabel,
  getProvenanceFieldNote,
  type BodyRenderMode,
} from './mailbox-helpers';
import {
  buildExplicitReplyChain,
  evaluateMailLifecycle,
  formatAbsoluteTimestamp,
  resolveMailDisplayStates,
} from './peer-message-presentation';
import type {
  EnrichedPeerMessage,
  OfficeProjectRoom,
  OfficeSessionItem,
  ReadablePartySummary,
  ResolvedPeerEndpoint,
} from './session-office-types';

interface PartyInlineValueProps {
  endpoint: ResolvedPeerEndpoint;
  readable: ReadablePartySummary;
  focusedSession: OfficeSessionItem | null;
  activeRoom: OfficeProjectRoom | null;
  onJumpToSession?: (sessionKey: string, projectKey?: string | null) => void;
}

const PartyInlineValue: FC<PartyInlineValueProps> = ({
  endpoint,
  readable,
  focusedSession,
  activeRoom,
  onJumpToSession,
}) => {
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
    <span className="office-mailbox-meta-party">
      <strong className="office-mailbox-meta-party-name" title={readable.shortName}>
        {readable.shortName}
      </strong>
      <span className="office-mailbox-meta-party-sub">
        {readable.providerLabel}
        {readable.shortIdentity ? ` ${readable.shortIdentity}` : ''}
      </span>
      {endpoint.sessionKey && onJumpToSession ? (
        <AppButton
          size="small"
          appVariant="quiet"
          className="office-mailbox-jump-btn"
          disabled={isCurrentDesk}
          aria-label={isCurrentDesk ? '当前工位' : isCrossRoomJump ? '前往对应房间' : '前往对应工位'}
          icon={isCrossRoomJump ? <EnvironmentOutlined /> : <DesktopOutlined />}
          onClick={() => onJumpToSession(endpoint.sessionKey!, endpoint.projectKey)}
        >
          {isCurrentDesk ? '当前工位' : isCrossRoomJump ? '前往房间' : '前往工位'}
        </AppButton>
      ) : null}
    </span>
  );
};

function resolveSessionContextSummary(
  msg: EnrichedPeerMessage,
  allRooms: OfficeProjectRoom[],
): { text: string; tooltip: string } {
  const fromRoom = findEndpointRoom(msg.fromResolved, allRooms);
  const toRoom = findEndpointRoom(msg.toResolved, allRooms);
  const fromProject = msg.fromResolved.projectName || fromRoom?.projectName || '';
  const toProject = msg.toResolved.projectName || toRoom?.projectName || '';
  const fromPath = msg.fromResolved.projectPath || fromRoom?.projectPath || '';
  const toPath = msg.toResolved.projectPath || toRoom?.projectPath || '';

  if (msg.isFullyUnassigned) {
    return {
      text: '未归属（外部或历史会话）',
      tooltip: '发送方与接收方均未匹配当前活跃项目房间',
    };
  }
  if (fromProject && toProject) {
    if (fromProject === toProject) {
      return {
        text: fromProject,
        tooltip: fromPath || fromProject,
      };
    }
    return {
      text: `${fromProject} → ${toProject}（跨项目）`,
      tooltip: [fromPath || fromProject, toPath || toProject].filter(Boolean).join(' → '),
    };
  }
  const knownProject = fromProject || toProject;
  const knownPath = fromPath || toPath;
  if (knownProject) {
    return {
      text: msg.hasUnresolvedParty ? `${knownProject} · 对端未归属` : knownProject,
      tooltip: knownPath || knownProject,
    };
  }
  return {
    text: '未指定项目目录',
    tooltip: '会话未关联具体工作目录',
  };
}

export interface MailboxDetailPaneProps {
  messageItem: EnrichedPeerMessage | null;
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
  onFocusReplyCli: () => void;
  showMobileBack: boolean;
  onMobileBack: () => void;
  readerScrollRef: RefObject<HTMLDivElement>;
  onReaderScroll: () => void;
  cliFooter: ReactNode;
}

export const MailboxDetailPane: FC<MailboxDetailPaneProps> = ({
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
  onFocusReplyCli,
  showMobileBack,
  onMobileBack,
  readerScrollRef,
  onReaderScroll,
  cliFooter,
}) => {
  const [techExpanded, setTechExpanded] = useState(false);

  useEffect(() => {
    setTechExpanded(false);
  }, [messageItem?.id]);

  const lifecycle = useMemo(
    () => (messageItem ? evaluateMailLifecycle(messageItem, nowMs) : null),
    [messageItem, nowMs],
  );
  const displayStates = useMemo(
    () =>
      messageItem && lifecycle
        ? resolveMailDisplayStates(messageItem, lifecycle, repliedIds, isLocallyRead)
        : null,
    [isLocallyRead, lifecycle, messageItem, repliedIds],
  );
  const deliveryError = useMemo(
    () => (messageItem ? getCombinedDeliveryError(messageItem) : ''),
    [messageItem],
  );
  const explicitChain = useMemo(
    () =>
      messageItem
        ? buildExplicitReplyChain(messageItem, allMessages)
        : { hasExplicitChain: false, rootMissingShortId: '', nodes: [] },
    [allMessages, messageItem],
  );
  const supersedesMessage = useMemo(() => {
    if (!messageItem) return null;
    const ref = String(messageItem.raw.supersedes ?? '').trim();
    if (!ref) return null;
    return allMessages.find((item) => item.id === ref || item.shortId === ref) ?? null;
  }, [allMessages, messageItem]);
  const replyCommand = useMemo(
    () => (messageItem ? buildCliHelperCommand(messageItem, 'reply', focusedSession) : ''),
    [focusedSession, messageItem],
  );
  const sessionContext = useMemo(
    () => (messageItem ? resolveSessionContextSummary(messageItem, allRooms) : null),
    [allRooms, messageItem],
  );

  if (!messageItem || !lifecycle || !displayStates || !sessionContext) {
    return (
      <div className="office-mailbox-reader-pane">
        {showMobileBack ? (
          <div className="office-mailbox-mobile-back-bar">
            <button
              type="button"
              className="office-mailbox-mobile-back-btn"
              aria-label="返回消息列表"
              onClick={onMobileBack}
            >
              <ArrowLeftOutlined aria-hidden="true" />
              <span>返回列表</span>
            </button>
          </div>
        ) : null}
        <div
          ref={readerScrollRef}
          className="office-mailbox-reader-scroll"
          onScroll={onReaderScroll}
        >
          <div className="office-mailbox-reader-empty">
            <HudStateView
              compact
              title="选择一条消息查看详情"
              description="查看发送方、投递状态、联系目的与正文记录。"
            />
          </div>
        </div>
      </div>
    );
  }

  const { presentation, fromReadable, toReadable } = messageItem;
  const shortMsgId = messageItem.shortId || messageItem.id.slice(0, 8);
  const idCopyKey = `id:${messageItem.id}`;
  const bodyCopyKey = `body:${messageItem.id}`;
  const replyCmdKey = `inline-reply:${messageItem.id}`;
  const rawBodyVerbatim = messageItem.raw.body;
  const canMarkRead = lifecycle.kind !== 'read';
  const relativeSent = formatRelativeTime(messageItem.raw.createdAt, nowMs);
  const showSummarySeparately =
    Boolean(presentation.summary)
    && presentation.summary !== presentation.purpose
    && presentation.summary !== presentation.title;

  return (
    <div className="office-mailbox-reader-pane">
      {showMobileBack ? (
        <div className="office-mailbox-mobile-back-bar">
          <button
            type="button"
            className="office-mailbox-mobile-back-btn"
            aria-label="返回消息列表"
            onClick={onMobileBack}
          >
            <ArrowLeftOutlined aria-hidden="true" />
            <span>返回列表</span>
          </button>
        </div>
      ) : null}

      <div
        ref={readerScrollRef}
        className="office-mailbox-reader-scroll"
        onScroll={onReaderScroll}
      >
        <article className="office-mailbox-article">
          {/* 1. Detail Header: Title + #shortId + Status Tags + Right Actions */}
          <header className="office-mailbox-article-head">
            <div className="office-mailbox-subject-row">
              <h3 className="office-mailbox-subject">{presentation.title}</h3>
              <span className="office-mailbox-short-id" title={`完整 ID: ${messageItem.id}`}>
                #{shortMsgId}
              </span>
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
                    <span>外部 / 历史</span>
                  </span>
                ) : null}
                {messageItem.raw.supersedes ? (
                  supersedesMessage ? (
                    <AppButton
                      size="small"
                      appVariant="quiet"
                      onClick={() => onJumpToMessage(supersedesMessage)}
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

              <div className="office-mailbox-article-actions">
                <AppButton
                  size="small"
                  appVariant="secondary"
                  aria-label="复制 CLI 回复命令"
                  icon={copiedKey === replyCmdKey ? <CheckOutlined /> : <CopyOutlined />}
                  onClick={() =>
                    onCopy(replyCmdKey, replyCommand, '已复制回复命令，可在终端执行')
                  }
                >
                  {copiedKey === replyCmdKey ? '已复制' : '复制命令'}
                </AppButton>
                {canMarkRead ? (
                  <AppButton
                    size="small"
                    appVariant="secondary"
                    aria-label={isLocallyRead ? '标为未读' : '标记已读'}
                    icon={<EyeOutlined />}
                    onClick={() => onToggleLocalRead(messageItem.id)}
                  >
                    {isLocallyRead ? '标为未读' : '标记已读'}
                  </AppButton>
                ) : null}
                <Tooltip title="展开底部 CLI 回复命令（只读视图通过终端回复）">
                  <AppButton
                    size="small"
                    appVariant="primary"
                    aria-label="展开 CLI 回复命令"
                    icon={<CodeOutlined />}
                    onClick={onFocusReplyCli}
                  >
                    回复
                  </AppButton>
                </Tooltip>
              </div>
            </div>
          </header>

          {/* 2. Meta Info: Two-Column Definition Grid with 1px Dividers (No per-item cards) */}
          <dl className="office-mailbox-meta-grid" aria-label="消息元信息">
            <div className="office-mailbox-meta-item">
              <dt>发送方</dt>
              <dd>
                <PartyInlineValue
                  endpoint={messageItem.fromResolved}
                  readable={fromReadable}
                  focusedSession={focusedSession}
                  activeRoom={activeRoom}
                  onJumpToSession={onJumpToSession}
                />
              </dd>
            </div>

            <div className="office-mailbox-meta-item">
              <dt>接收方</dt>
              <dd>
                <PartyInlineValue
                  endpoint={messageItem.toResolved}
                  readable={toReadable}
                  focusedSession={focusedSession}
                  activeRoom={activeRoom}
                  onJumpToSession={onJumpToSession}
                />
              </dd>
            </div>

            <div className="office-mailbox-meta-item">
              <dt>所属会话</dt>
              <dd>
                <Tooltip title={sessionContext.tooltip}>
                  <span className="office-mailbox-meta-session">{sessionContext.text}</span>
                </Tooltip>
              </dd>
            </div>

            <div className="office-mailbox-meta-item">
              <dt>时间</dt>
              <dd className="office-mailbox-meta-times">
                <span>
                  <em>发送</em> {lifecycle.sentAbsoluteText}
                  <span className="office-mailbox-meta-relative">({relativeSent})</span>
                </span>
                <span>
                  <em>送达</em>{' '}
                  <span className={lifecycle.isUndelivered ? 'is-undelivered' : undefined}>
                    {lifecycle.deliveredAbsoluteText}
                  </span>
                </span>
                {messageItem.raw.readAt > 0 ? (
                  <span>
                    <em>已读</em> {lifecycle.readAbsoluteText}
                  </span>
                ) : null}
              </dd>
            </div>

            <div className="office-mailbox-meta-item">
              <dt>投递状态</dt>
              <dd className="office-mailbox-meta-delivery">
                <span className="office-mailbox-meta-delivery-main">{lifecycle.label}</span>
                {lifecycle.validitySummary ? (
                  <span className="office-mailbox-meta-delivery-sub">
                    {lifecycle.validitySummary}
                  </span>
                ) : null}
                {deliveryError ? (
                  <InlineNote tone="error" className="office-mailbox-delivery-error">
                    投递异常：{deliveryError}
                  </InlineNote>
                ) : null}
              </dd>
            </div>
          </dl>

          {/* 3. Body Area: Inline Structured Fields ("标签：值") + Readable Body */}
          <section className="office-mailbox-body-section" aria-label="消息正文">
            <div className="office-mailbox-inline-fields">
              <p className="office-mailbox-inline-field">
                <span className="office-mailbox-inline-label">联系目的：</span>
                <span
                  className={
                    presentation.purposeSource === 'unknown'
                      ? 'office-mailbox-inline-value is-unknown'
                      : 'office-mailbox-inline-value'
                  }
                >
                  {presentation.purpose}
                </span>
              </p>

              <p className="office-mailbox-inline-field">
                <span className="office-mailbox-inline-label">期望行动：</span>
                <span
                  className={
                    presentation.actionSource === 'unknown'
                      ? 'office-mailbox-inline-value is-unknown'
                      : 'office-mailbox-inline-value'
                  }
                >
                  {presentation.actionText}
                </span>
              </p>

              {showSummarySeparately ? (
                <p className="office-mailbox-inline-field">
                  <span className="office-mailbox-inline-label">摘要：</span>
                  <span className="office-mailbox-inline-value">{presentation.summary}</span>
                </p>
              ) : null}

              {presentation.jargonHints.length > 0 ? (
                <p className="office-mailbox-inline-field office-mailbox-inline-jargon">
                  <span className="office-mailbox-inline-label">术语：</span>
                  <span className="office-mailbox-inline-value">
                    {presentation.jargonHints.map((hint, idx) => (
                      <span key={hint.term}>
                        {idx > 0 ? ' · ' : ''}
                        <code>{hint.term}</code> {hint.meaning}
                      </span>
                    ))}
                  </span>
                </p>
              ) : null}
            </div>

            <div className="office-mailbox-body-toolbar">
              <span className="office-mailbox-body-heading">
                正文
                <span className="office-mailbox-body-len">
                  {rawBodyVerbatim.length > 0 ? `${rawBodyVerbatim.length} 字` : '空'}
                </span>
              </span>

              <div className="office-mailbox-body-controls">
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
                  aria-label="复制消息原文"
                  icon={copiedKey === bodyCopyKey ? <CheckOutlined /> : <CopyOutlined />}
                  onClick={() => onCopy(bodyCopyKey, rawBodyVerbatim, '原始正文已复制')}
                >
                  {copiedKey === bodyCopyKey ? '已复制' : '复制'}
                </AppButton>
              </div>
            </div>

            <pre className="office-mailbox-body-content" data-mode={bodyMode}>
              {rawBodyVerbatim.length > 0 ? rawBodyVerbatim : '(空正文)'}
            </pre>
          </section>

          {/* 4. Explicit replyTo Chain (only when explicit links exist) */}
          {explicitChain.hasExplicitChain ? (
            <section className="office-mailbox-chain-section" aria-label="回复链">
              <div className="office-mailbox-section-head">
                <span className="office-mailbox-section-title">
                  <BranchesOutlined aria-hidden="true" />
                  <span>回复链（{explicitChain.nodes.length} 条）</span>
                </span>
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
                  const nodeStates = resolveMailDisplayStates(
                    node.message,
                    nodeLifecycle,
                    repliedIds,
                  );
                  return (
                    <button
                      key={node.message.id}
                      type="button"
                      className="office-mailbox-chain-node"
                      data-current={node.isCurrent ? 'true' : undefined}
                      data-depth={String(node.depth)}
                      aria-label={`回复链第 ${index + 1} 条：${node.message.presentation.title}`}
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
                        <span>{formatRelativeTime(node.message.raw.createdAt, nowMs)}</span>
                        <MailStateTag badge={nodeStates.primary} compact />
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}

          {/* 5. Collapsed Disclosure: Technical & Delivery Audit */}
          <section className="office-mailbox-disclosure" aria-label="技术详情与原始字段">
            <button
              type="button"
              className="office-mailbox-disclosure-toggle"
              aria-expanded={techExpanded}
              onClick={() => setTechExpanded((prev) => !prev)}
            >
              <span className="office-mailbox-disclosure-left">
                {techExpanded ? <DownOutlined aria-hidden="true" /> : <RightOutlined aria-hidden="true" />}
                <span>技术详情与投递审计</span>
                <span className="office-mailbox-disclosure-meta">
                  尝试 {lifecycle.attemptCount} 次 · 检查 {lifecycle.probeCount ?? '-'}
                </span>
              </span>
              <span className="office-mailbox-disclosure-hint">{techExpanded ? '收起' : '展开'}</span>
            </button>

            {techExpanded ? (
              <div className="office-mailbox-tech-body">
                <div className="office-mailbox-tech-actions">
                  <AppButton
                    size="small"
                    appVariant="secondary"
                    aria-label="复制完整消息 ID"
                    icon={copiedKey === idCopyKey ? <CheckOutlined /> : <CopyOutlined />}
                    onClick={() => onCopy(idCopyKey, messageItem.id, '完整消息 ID 已复制')}
                  >
                    {copiedKey === idCopyKey ? '已复制 ID' : '复制完整 ID'}
                  </AppButton>
                </div>

                <dl className="office-mailbox-tech-kv">
                  <div>
                    <dt>队列 / 通知</dt>
                    <dd>
                      <code>
                        {messageItem.raw.state || '-'} / {messageItem.raw.notificationState || '-'}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>尝试 / 检查</dt>
                    <dd>
                      <code>
                        {lifecycle.attemptCount} / {lifecycle.probeCount ?? '未记录'}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>通知窗口</dt>
                    <dd>
                      <code>{formatAbsoluteTimestamp(messageItem.raw.autoDeliverUntil)}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>语义过期</dt>
                    <dd>
                      <code>
                        {messageItem.raw.expiresAt
                          ? formatAbsoluteTimestamp(messageItem.raw.expiresAt)
                          : '无限制'}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>调度 / 重试</dt>
                    <dd>
                      <code>
                        {messageItem.raw.busySince ? formatAbsoluteTimestamp(messageItem.raw.busySince) : '-'}
                        {messageItem.raw.waitingReason ? ` · ${messageItem.raw.waitingReason}` : ''}
                        {messageItem.raw.nextAttemptAt
                          ? ` · 下次 ${formatAbsoluteTimestamp(messageItem.raw.nextAttemptAt)}`
                          : ''}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>完整 ID</dt>
                    <dd><code>{messageItem.id}</code></dd>
                  </div>
                  <div>
                    <dt>关联引用</dt>
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
      </div>

      {cliFooter}
    </div>
  );
};
