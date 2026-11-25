import type { FC, ReactNode } from 'react';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  MailOutlined,
  MessageOutlined,
} from '@ant-design/icons';
import {
  formatCompactAbsoluteTimestamp,
  type MailBadgeTone,
  type MailDisplayStateBadge,
  type MailDisplayStates,
} from './peer-message-presentation';
import type {
  EnrichedPeerMessage,
  MailboxScope,
  OfficeProjectRoom,
  OfficeSessionItem,
  PeerFieldProvenance,
  ResolvedPeerEndpoint,
} from './session-office-types';

export type BodyRenderMode = 'prose' | 'mono';
export type CliCommandMode = 'reply' | 'send';

export interface ScopeOptionItem {
  key: MailboxScope;
  label: string;
  count?: number;
  disabled?: boolean;
  tooltip?: string;
}

export function formatRelativeTime(ms: number | undefined | null, nowMs: number): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '-';
  const diffSec = Math.max(0, Math.floor((nowMs - value) / 1000));
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}小时前`;
  if (diffSec < 7 * 86400) return `${Math.floor(diffSec / 86400)}天前`;
  return formatCompactAbsoluteTimestamp(value);
}

export function getMatchBasisLabel(basis: ResolvedPeerEndpoint['matchBasis']): string {
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

export function getProvenanceFieldNote(source: PeerFieldProvenance): string {
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

export function shellQuoteArg(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '""';
  if (/^[a-zA-Z0-9._:/@-]+$/.test(trimmed)) return trimmed;
  return `'${trimmed.replace(/'/g, "'\\''")}'`;
}

export function resolveReplyPeerTarget(
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
export function buildCliHelperCommand(
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

export function findEndpointRoom(
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

export function getCombinedDeliveryError(msg: EnrichedPeerMessage): string {
  const parts = [msg.raw.error, msg.raw.lastAttemptError, msg.raw.receiptError]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  return [...new Set(parts)].join(' · ');
}

export function resolveScopeTitle(scope: MailboxScope): string {
  switch (scope) {
    case 'unassigned':
      return '未归属消息';
    case 'room':
      return '当前房间';
    case 'session':
      return '当前工位';
    case 'all':
    default:
      return '全部消息';
  }
}

export function resolveScopeTooltip(
  scope: MailboxScope,
  activeRoom: OfficeProjectRoom | null,
  focusedSession: OfficeSessionItem | null,
  pendingOnly: boolean,
): string {
  let base = '跨会话协作消息 · 只读查阅';
  if (scope === 'session') {
    base = focusedSession
      ? `工位 ${focusedSession.shortLabel || focusedSession.label} · 只读查阅`
      : '当前工位消息 · 只读查阅';
  } else if (scope === 'room') {
    base = activeRoom
      ? `项目房间 ${activeRoom.projectName} · 只读消息队列`
      : '当前房间消息 · 只读查阅';
  } else if (scope === 'unassigned') {
    base = '含未解析端点的跨会话协作消息 · 只读查阅';
  }
  return pendingOnly ? `${base}（当前只看待处理）` : base;
}

export function resolveRowStatusBadges(displayStates: MailDisplayStates): MailDisplayStateBadge[] {
  const { primary, reply } = displayStates;
  if (primary.key === 'canceled' || primary.key === 'expired' || primary.key === 'failed') {
    return [primary];
  }
  if (reply?.key === 'awaiting-reply') {
    return [primary, { ...reply, label: '待回复' }];
  }
  if (reply?.key === 'replied') {
    return [primary, reply];
  }
  return [primary];
}

function renderStateIcon(tone: MailBadgeTone, key: string): ReactNode {
  if (key === 'replied' || key === 'read') return <CheckCircleOutlined aria-hidden="true" />;
  if (key === 'awaiting-reply' || key === 'undelivered' || key === 'manual') {
    return <ClockCircleOutlined aria-hidden="true" />;
  }
  if (key === 'unread') return <MailOutlined aria-hidden="true" />;
  if (tone === 'danger') return <ExclamationCircleOutlined aria-hidden="true" />;
  if (key === 'no-reply' || key === 'canceled') return <CloseCircleOutlined aria-hidden="true" />;
  return <MessageOutlined aria-hidden="true" />;
}

export interface MailStateTagProps {
  badge: MailDisplayStateBadge;
  compact?: boolean;
}

export const MailStateTag: FC<MailStateTagProps> = ({ badge, compact = false }) => (
  <span
    className={`office-mailbox-state-tag office-mailbox-state-tag--${badge.tone}${
      compact ? ' office-mailbox-state-tag--compact' : ''
    }`}
    title={badge.title || badge.label}
  >
    <span className="office-mailbox-state-tag-icon" aria-hidden="true">
      {renderStateIcon(badge.tone, badge.key)}
    </span>
    <span>{badge.label}</span>
  </span>
);
