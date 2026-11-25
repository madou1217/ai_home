import { useCallback, type FC, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import {
  CloseCircleOutlined,
  MailOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import HudStateView from '@/components/hud/HudStateView';
import AppButton from '@/components/ui/AppButton';
import {
  MailStateTag,
  formatRelativeTime,
  resolveRowStatusBadges,
} from './mailbox-helpers';
import {
  evaluateMailLifecycle,
  resolveMailDisplayStates,
} from './peer-message-presentation';
import type {
  EnrichedPeerMessage,
  MailboxScope,
  MailboxStateFilter,
  OfficeProjectRoom,
} from './session-office-types';

interface StateFilterChip {
  key: MailboxStateFilter;
  label: string;
  count: number;
  tooltip: string;
}

export interface MailboxListPaneProps {
  stateFilter: MailboxStateFilter;
  attentionCount: number;
  undeliveredCount: number;
  deliveredOrReadCount: number;
  scopeAllCount: number;
  visibleCount: number;
  hasActiveFilter: boolean;
  loading: boolean;
  scope: MailboxScope;
  activeRoom: OfficeProjectRoom | null;
  totalCount: number;
  messages: EnrichedPeerMessage[];
  selectedMessageId: string | null;
  nowMs: number;
  repliedIds: ReadonlySet<string>;
  locallyReadIds: ReadonlySet<string>;
  listRef: RefObject<HTMLDivElement>;
  onListScroll: () => void;
  onSelectStateFilter: (nextState: MailboxStateFilter) => void;
  onResetFilters: () => void;
  onSelectScope: (scope: MailboxScope) => void;
  onSelectMessage: (msg: EnrichedPeerMessage) => void;
  onRefresh: () => void;
}

export const MailboxListPane: FC<MailboxListPaneProps> = ({
  stateFilter,
  attentionCount,
  undeliveredCount,
  deliveredOrReadCount,
  scopeAllCount,
  visibleCount,
  hasActiveFilter,
  loading,
  scope,
  activeRoom,
  totalCount,
  messages,
  selectedMessageId,
  nowMs,
  repliedIds,
  locallyReadIds,
  listRef,
  onListScroll,
  onSelectStateFilter,
  onResetFilters,
  onSelectScope,
  onSelectMessage,
  onRefresh,
}) => {
  const filterChips: StateFilterChip[] = [
    {
      key: 'attention',
      label: '待处理',
      count: attentionCount,
      tooltip: '只看待处理（默认；再次点击显示全部）',
    },
    {
      key: 'undelivered',
      label: '未送达',
      count: undeliveredCount,
      tooltip: '尚未送达收件终端的消息',
    },
    {
      key: 'delivered',
      label: '已送达',
      count: deliveredOrReadCount,
      tooltip: '已送达或已读的消息',
    },
    {
      key: 'all',
      label: '全部',
      count: scopeAllCount,
      tooltip: '显示当前范围全部消息',
    },
  ];

  const handleRowKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const container = listRef.current;
    if (!container) return;
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button.office-mailbox-row'),
    );
    const currentIndex = buttons.indexOf(event.currentTarget);
    if (currentIndex < 0) return;
    const nextIndex = event.key === 'ArrowDown'
      ? Math.min(buttons.length - 1, currentIndex + 1)
      : Math.max(0, currentIndex - 1);
    if (nextIndex !== currentIndex) {
      event.preventDefault();
      buttons[nextIndex]?.focus();
    }
  }, [listRef]);

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
        <div
          className="office-mailbox-filter-strip"
          role="group"
          aria-label="状态筛选"
        >
          {filterChips.map((chip) => {
            const active = stateFilter === chip.key;
            return (
              <button
                key={chip.key}
                type="button"
                aria-pressed={active}
                title={chip.tooltip}
                data-active={active ? 'true' : undefined}
                className="office-mailbox-filter-chip"
                onClick={() => onSelectStateFilter(chip.key)}
              >
                <span>{chip.label}</span>
                {chip.key === 'attention' && chip.count > 0 ? (
                  <span className="office-mailbox-filter-count">{chip.count}</span>
                ) : null}
              </button>
            );
          })}
        </div>

        {hasActiveFilter && visibleCount === 0 ? (
          <button
            type="button"
            className="office-mailbox-clear-btn"
            aria-label="清除筛选条件"
            title="清除筛选条件"
            onClick={onResetFilters}
          >
            <CloseCircleOutlined aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div
        ref={listRef}
        className="office-mailbox-list"
        role="listbox"
        aria-label="消息列表"
        onScroll={onListScroll}
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
            const rowBadges = resolveRowStatusBadges(displayStates);
            const partiesText = `${item.fromReadable.shortName} → ${item.toReadable.shortName}`;
            const relativeTime = formatRelativeTime(item.raw.createdAt, nowMs);
            const showUnreadDot = !isSelected && (displayStates.isUnread || lifecycle.isAttention);

            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                aria-label={`${item.presentation.title}，${partiesText}，${relativeTime}`}
                data-selected={isSelected ? 'true' : undefined}
                data-unread={displayStates.isUnread ? 'true' : undefined}
                className="office-mailbox-row"
                onClick={() => onSelectMessage(item)}
                onKeyDown={handleRowKeyDown}
              >
                <div className="office-mailbox-row-subject-line">
                  {isSelected ? (
                    <MailOutlined className="office-mailbox-row-selected-icon" aria-hidden="true" />
                  ) : showUnreadDot ? (
                    <span
                      className={`office-mailbox-unread-dot${
                        lifecycle.isAttention ? ' office-mailbox-unread-dot--attention' : ''
                      }`}
                      aria-hidden="true"
                    />
                  ) : null}
                  <span className="office-mailbox-row-subject" title={item.presentation.title}>
                    {item.presentation.title}
                  </span>
                  {Number(item.raw.priority || 0) > 0 ? (
                    <span className="office-mailbox-priority-tag" title="加急消息">急</span>
                  ) : null}
                </div>

                <div
                  className="office-mailbox-row-meta"
                  title={`${partiesText} · ${lifecycle.sentAbsoluteText}`}
                >
                  <span className="office-mailbox-row-parties">{partiesText}</span>
                  <span className="office-mailbox-row-sep" aria-hidden="true">·</span>
                  <span className="office-mailbox-row-time">{relativeTime}</span>
                </div>

                <div className="office-mailbox-row-states">
                  {rowBadges.map((badge) => (
                    <MailStateTag key={badge.key} badge={badge} compact />
                  ))}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};
