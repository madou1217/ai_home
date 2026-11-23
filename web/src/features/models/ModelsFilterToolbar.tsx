import { memo } from 'react';
import { Input, Segmented, Select } from 'antd';
import ProviderIcon, { providerNames } from '@/components/chat/ProviderIcon';
import Reveal from '@/components/ui/Reveal';
import {
  MODEL_PROVIDERS,
  MODEL_STATUS_FILTER_OPTIONS,
  getAccountLabel,
  type AccountFilter,
  type ModelStatusFilter,
  type ProviderFilter
} from './model-catalog';
import type { ModelGroupFilter } from './account-models';
import type { WebUiOpenAIModelAccount } from '@/types';

export interface ModelsFilterToolbarProps {
  accountScoped: boolean;
  providerFilter: ProviderFilter;
  providerCounts: Record<string, number>;
  accountFilter: AccountFilter;
  accountOptions: WebUiOpenAIModelAccount[];
  keyword: string;
  isOpenCodeScoped: boolean;
  groupFilter: ModelGroupFilter;
  totalScopedCount: number;
  openCodeGoCount: number;
  openCodeZenCount: number;
  openCodeFreeCount: number;
  statusFilter: ModelStatusFilter;
  onProviderChange: (next: ProviderFilter) => void;
  onAccountChange: (next: AccountFilter) => void;
  onKeywordChange: (next: string) => void;
  onGroupChange: (next: ModelGroupFilter) => void;
  onStatusChange: (next: ModelStatusFilter) => void;
}

/**
 * 模型目录筛选工具栏：Provider 芯片可自动折行且保持可读，
 * 账号、关键词、OpenCode 分组与状态筛选整齐排布。
 */
export const ModelsFilterToolbar = memo(function ModelsFilterToolbar({
  accountScoped,
  providerFilter,
  providerCounts,
  accountFilter,
  accountOptions,
  keyword,
  isOpenCodeScoped,
  groupFilter,
  totalScopedCount,
  openCodeGoCount,
  openCodeZenCount,
  openCodeFreeCount,
  statusFilter,
  onProviderChange,
  onAccountChange,
  onKeywordChange,
  onGroupChange,
  onStatusChange
}: ModelsFilterToolbarProps) {
  return (
    <div className="models-filter-toolbar" role="region" aria-label="模型筛选条件">
      {!accountScoped ? (
        <div className="models-provider-chips" role="radiogroup" aria-label="按 Provider 筛选">
          <button
            type="button"
            role="radio"
            aria-checked={providerFilter === 'all'}
            className={`models-provider-chip${providerFilter === 'all' ? ' models-provider-chip--active' : ''}`}
            onClick={() => onProviderChange('all')}
          >
            <span>全部</span>
            <span className="models-provider-chip-count">{providerCounts.all || 0}</span>
          </button>
          {MODEL_PROVIDERS.map((provider) => {
            const active = providerFilter === provider;
            const count = providerCounts[provider] || 0;
            return (
              <button
                key={provider}
                type="button"
                role="radio"
                aria-checked={active}
                className={`models-provider-chip${active ? ' models-provider-chip--active' : ''}${count === 0 && !active ? ' models-provider-chip--empty' : ''}`}
                onClick={() => onProviderChange(provider)}
              >
                <ProviderIcon provider={provider} size={13} />
                <span>{providerNames[provider]}</span>
                <span className="models-provider-chip-count">{count}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="models-filter-controls">
        {!accountScoped ? (
          <Select
            className="models-account-filter"
            value={accountFilter}
            onChange={(value) => onAccountChange(value)}
            options={[
              { label: '全部账号', value: 'all' },
              ...accountOptions
                .filter((account) => providerFilter === 'all' || account.provider === providerFilter)
                .map((account) => ({
                  label: (
                    <span className="models-account-option">
                      <ProviderIcon provider={account.provider} size={14} />
                      <span>{getAccountLabel(account)}</span>
                    </span>
                  ),
                  value: account.accountRef
                }))
            ]}
          />
        ) : null}

        <Input.Search
          allowClear
          className="models-search"
          placeholder={accountScoped ? '搜索模型' : '搜索模型 ID'}
          value={keyword}
          onChange={(event) => onKeywordChange(event.target.value)}
        />

        <Reveal open={isOpenCodeScoped}>
          <Segmented
            value={groupFilter}
            onChange={(value) => onGroupChange(value as ModelGroupFilter)}
            options={[
              { label: `全部分组 (${totalScopedCount})`, value: 'all' },
              { label: `Go 订阅 (${openCodeGoCount})`, value: 'go' },
              { label: `Zen 按量 (${openCodeZenCount})`, value: 'zen' },
              ...(openCodeFreeCount > 0 ? [{ label: `Free 免费 (${openCodeFreeCount})`, value: 'free' }] : [])
            ]}
          />
        </Reveal>

        <Segmented
          value={statusFilter}
          onChange={(value) => onStatusChange(value as ModelStatusFilter)}
          options={MODEL_STATUS_FILTER_OPTIONS}
        />
      </div>
    </div>
  );
});

export default ModelsFilterToolbar;
