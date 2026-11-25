import type { FC } from 'react';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Input, Tooltip } from 'antd';
import AppButton from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import type { ScopeOptionItem } from './mailbox-helpers';
import type { MailboxScope } from './session-office-types';

export interface MailboxHeaderProps {
  compactHeader: boolean;
  scope: MailboxScope;
  scopeOptions: ScopeOptionItem[];
  title: string;
  titleTooltip: string;
  visibleCount: number;
  scopeTotalCount: number;
  searchQuery: string;
  loading: boolean;
  error: string;
  onSelectScope: (scope: MailboxScope) => void;
  onSearchChange: (value: string) => void;
  onRefresh: () => void;
}

export const MailboxHeader: FC<MailboxHeaderProps> = ({
  compactHeader,
  scope,
  scopeOptions,
  title,
  titleTooltip,
  visibleCount,
  scopeTotalCount,
  searchQuery,
  loading,
  error,
  onSelectScope,
  onSearchChange,
  onRefresh,
}) => (
  <header className="office-mailbox-header">
    <div className="office-mailbox-header-row">
      <div className="office-mailbox-header-identity">
        {!compactHeader ? (
          <Tooltip title={titleTooltip}>
            <h2 className="office-mailbox-title">{title}</h2>
          </Tooltip>
        ) : null}
        <Tooltip title={`当前显示 ${visibleCount} 条 / 范围内共 ${scopeTotalCount} 条`}>
          <span
            className="office-mailbox-count-badge"
            aria-label={`当前显示 ${visibleCount} 条消息`}
          >
            {visibleCount}
          </span>
        </Tooltip>
      </div>

      <div
        className="office-mailbox-segmented"
        role="tablist"
        aria-label="消息范围切换"
      >
        {scopeOptions.map((item) => {
          const active = scope === item.key;
          return (
            <Tooltip key={item.key} title={item.tooltip}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                disabled={item.disabled}
                data-active={active ? 'true' : undefined}
                className="office-mailbox-seg-btn"
                onClick={() => onSelectScope(item.key)}
              >
                <span>{item.label}</span>
              </button>
            </Tooltip>
          );
        })}
      </div>

      <div className="office-mailbox-header-controls">
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined className="office-mailbox-search-icon" aria-hidden="true" />}
          className="office-mailbox-search"
          aria-label="搜索消息"
          placeholder="搜索消息…"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        <Tooltip title={loading ? '正在同步消息…' : '刷新消息'}>
          <AppButton
            size="small"
            appVariant="icon"
            className="office-mailbox-refresh-btn"
            aria-label="刷新消息"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={onRefresh}
          />
        </Tooltip>
      </div>
    </div>

    {error ? (
      <InlineNote tone="error" className="office-mailbox-header-error">
        {error}
      </InlineNote>
    ) : null}
  </header>
);
