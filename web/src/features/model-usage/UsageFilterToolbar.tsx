import { memo } from 'react';
import { DatePicker, Segmented, Select } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import Button from '@/components/ui/AppButton';
import Reveal from '@/components/ui/Reveal';
import type { UsageProviderFilter, UsageRangeMode } from './model-usage-query';

const { RangePicker } = DatePicker;

export interface UsageModelSelectOption {
  label: string;
  title: string;
  value: string;
}

export interface UsageFilterToolbarProps {
  rangeMode: UsageRangeMode;
  rangeOptions: Array<{ label: string; value: UsageRangeMode }>;
  range: [Dayjs, Dayjs];
  provider: UsageProviderFilter;
  providerOptions: Array<{ label: string; value: UsageProviderFilter }>;
  model: string;
  modelOptions: UsageModelSelectOption[];
  loading: boolean;
  onRangeModeChange: (mode: UsageRangeMode) => void;
  onRangeChange: (value: null | [Dayjs | null, Dayjs | null]) => void;
  onProviderChange: (provider: UsageProviderFilter) => void;
  onModelChange: (model: string | undefined) => void;
  onRefresh: () => void;
}

/**
 * 模型用量筛选工具栏：时间范围、模型与查询动作一行紧凑排布，Provider 芯片独立换行区，
 * 窄屏自动折叠不产生横向页面溢出。
 */
export const UsageFilterToolbar = memo(function UsageFilterToolbar({
  rangeMode,
  rangeOptions,
  range,
  provider,
  providerOptions,
  model,
  modelOptions,
  loading,
  onRangeModeChange,
  onRangeChange,
  onProviderChange,
  onModelChange,
  onRefresh
}: UsageFilterToolbarProps) {
  return (
    <div className="usage-filter-toolbar" role="region" aria-label="用量筛选条件">
      <div className="usage-filter-row">
        <div className="usage-filter-group">
          <span className="usage-filter-label">时间范围</span>
          <Segmented
            value={rangeMode}
            options={rangeOptions}
            onChange={(value) => onRangeModeChange(value as UsageRangeMode)}
          />
          <Reveal open={rangeMode === 'custom'}>
            <RangePicker
              value={range}
              onChange={onRangeChange}
              allowClear={false}
              disabledDate={(current) => Boolean(current && current > dayjs().endOf('day'))}
              showTime={{ format: 'HH:mm' }}
              format="YYYY-MM-DD HH:mm"
              className="usage-filter-range-picker"
            />
          </Reveal>
        </div>

        <div className="usage-filter-group usage-filter-group--model">
          <span className="usage-filter-label">模型</span>
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="全部模型"
            value={model || undefined}
            onChange={onModelChange}
            className="usage-filter-model-select"
            options={modelOptions}
          />
          <Button icon={<ReloadOutlined />} onClick={onRefresh} loading={loading}>
            查询
          </Button>
        </div>
      </div>

      <div className="usage-filter-row usage-filter-row--providers">
        <span className="usage-filter-label">Provider</span>
        <div className="usage-provider-chips" role="radiogroup" aria-label="按 Provider 筛选">
          {providerOptions.map((option) => {
            const active = option.value === provider;
            return (
              <button
                key={option.value || 'all'}
                type="button"
                role="radio"
                aria-checked={active}
                className={`usage-provider-chip${active ? ' usage-provider-chip--active' : ''}`}
                onClick={() => onProviderChange(option.value)}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
});

export default UsageFilterToolbar;
