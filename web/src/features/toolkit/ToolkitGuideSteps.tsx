import { memo } from 'react';
import { Segmented } from 'antd';
import { SettingRow, SettingSection } from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import { runtimePluginIcon } from '@/components/toolkit/runtime-plugin-presentation';
import type { ClientPlatform, EnvironmentGuideResponse } from '@/types';

export interface GuideRuntimeOption {
  id: string;
  name: string;
}

export interface ToolkitGuideStepsProps {
  platforms: EnvironmentGuideResponse['platforms'];
  currentPlatform: ClientPlatform;
  selectedPlatform: ClientPlatform | '';
  runtimeOptions: GuideRuntimeOption[];
  selectedRuntime: string;
  selectedToolName?: string;
  hasTool: boolean;
  onPlatformChange: (nextPlatform: ClientPlatform) => void;
  onRuntimeChange: (nextRuntime: string) => void;
}

export const ToolkitGuideSteps = memo(function ToolkitGuideSteps({
  platforms,
  currentPlatform,
  selectedPlatform,
  runtimeOptions,
  selectedRuntime,
  selectedToolName,
  hasTool,
  onPlatformChange,
  onRuntimeChange
}: ToolkitGuideStepsProps) {
  const platformDone = Boolean(selectedPlatform);
  const runtimeDone = Boolean(selectedRuntime) && runtimeOptions.some((item) => item.id === selectedRuntime);

  return (
    <SettingSection
      title="安装步骤"
      description="按顺序选择目标系统、工具链与工具，然后复制命令。"
      status={(
        <SettingStatusTag
          compact
          status={platformDone && runtimeDone && hasTool ? 'applied' : 'unset'}
          label={platformDone && runtimeDone && hasTool ? '命令就绪' : '待选择'}
        />
      )}
      className="toolkit-guide-steps"
    >
      <SettingRow
        title="1. 选择目标系统"
        description="选择要执行命令的操作系统，仅生成对应系统命令。"
        status={(
          <SettingStatusTag
            compact
            status={platformDone ? 'saved' : 'unset'}
            label={platformDone ? '已完成' : '待完成'}
          />
        )}
        layout="stacked"
        control={(
          <Segmented
            aria-label="目标系统"
            value={selectedPlatform}
            options={platforms.map((item) => ({
              label: item.id === currentPlatform ? `${item.label}（本机）` : item.label,
              value: item.id
            }))}
            onChange={(value) => onPlatformChange(value as ClientPlatform)}
          />
        )}
      />
      <SettingRow
        title="2. 选择语言工具链"
        description="切换到需要配置的语言运行时，筛选对应安装工具。"
        status={(
          <SettingStatusTag
            compact
            status={runtimeDone ? 'saved' : 'unset'}
            label={runtimeDone ? '已完成' : '待完成'}
          />
        )}
        layout="stacked"
        control={(
          <Segmented
            aria-label="工具链"
            value={selectedRuntime}
            options={runtimeOptions.map((plugin) => ({
              label: plugin.name,
              value: plugin.id,
              icon: runtimePluginIcon(plugin.id)
            }))}
            onChange={(value) => onRuntimeChange(String(value))}
          />
        )}
      />
      <SettingRow
        title="3. 选择工具并复制命令"
        description="在下方选中工具，填写必填参数后复制生成的命令。"
        status={(
          <SettingStatusTag
            compact
            status={hasTool ? 'applied' : 'unset'}
            label={hasTool ? `已选：${selectedToolName}` : '待选择'}
          />
        )}
        control={null}
        className="toolkit-guide-step-summary"
      />
    </SettingSection>
  );
});

export default ToolkitGuideSteps;
