import { useState } from 'react';
import { Space, Spin, Tag } from 'antd';
import {
  EditOutlined,
  ReloadOutlined,
  ToolOutlined
} from '@ant-design/icons';
import { toolkitAPI } from '@/services/api';
import type {
  ManagedToolItem,
  ManagedToolLifecycleAction,
  ToolkitToolCategoryId,
} from '@/types';
import Button from '@/components/ui/AppButton';
import InstallLifecycleAction from './InstallLifecycleAction';
import ManagedResourceCard from './ManagedResourceCard';
import ManagedToolConfigModal from './ManagedToolConfigModal';
import ManagedToolLogsModal from './ManagedToolLogsModal';
import ToolkitStatusTrack from './ToolkitStatusTrack';
import { ToolServiceActions, ToolServicePolicy } from './ToolServiceControls';
import { serviceSummary } from './tool-service-presentation';
import { useToolService } from './use-tool-service';
import { LIFECYCLE_ACTION_LABELS as ACTION_LABELS } from './lifecycle-presentation';
import {
  MANAGED_TOOL_CAPABILITY_LABELS as CAPABILITY_LABELS,
  MANAGED_TOOL_DISCOVERY_SOURCE_LABELS as DISCOVERY_SOURCE_LABELS,
  managedToolConfigSummary as configSummary,
  managedToolRuntimeSummary as runtimeSummary,
  useManagedTools
} from './use-managed-tools';

interface ManagedToolsPanelProps {
  category: ToolkitToolCategoryId;
}

const MANAGEMENT_LABELS: Record<string, string> = {
  aih: 'AIH 管理',
  homebrew: 'Homebrew 管理',
  external: '外部安装'
};

export default function ManagedToolsPanel({ category }: ManagedToolsPanelProps) {
  const {
    data,
    loading,
    error,
    fetchTools,
    tools,
    categoryInfo,
    installedCount,
    editableCount,
    lifecycleCount,
    activeTaskFor,
    busyActionFor,
    runAction
  } = useManagedTools(category, {
    plan: toolkitAPI.planManagedToolAction,
    execute: toolkitAPI.executeManagedToolAction
  });
  const [editingTool, setEditingTool] = useState<ManagedToolItem | null>(null);
  const toolService = useToolService(fetchTools);


  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby={`toolkit-tools-${category}`}>
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">MANAGED TOOL INVENTORY</div>
          <h2 id={`toolkit-tools-${category}`}>{categoryInfo?.label || category}</h2>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={fetchTools}>重新探测</Button>
      </header>

      {error ? (
        <div className="toolkit-inline-error" role="alert">
          <span className="hud-led hud-led--err" aria-hidden="true" />
          <strong>工具状态读取失败</strong>
          <span>{error}</span>
        </div>
      ) : null}

      {loading && !data ? (
        <div className="toolkit-loading"><Spin size="large" /></div>
      ) : data ? (
        <>
          <ToolkitStatusTrack
            ariaLabel={`${categoryInfo?.label || category} 状态轨道`}
            items={[
              { label: '实测', value: `${tools.length} 个工具记录`, detail: '来自当前主机与平台探测结果', tone: tools.length ? 'info' : 'neutral' },
              { label: '配置', value: `${installedCount} 个已安装`, detail: editableCount ? `${editableCount} 个可编辑配置` : '暂无可编辑配置', tone: installedCount ? 'success' : 'warning' },
              {
                label: '生命周期',
                value: lifecycleCount ? `${lifecycleCount} 个可管理` : '仅探测',
                detail: lifecycleCount ? '安装、更新、卸载均进入后台任务队列' : '当前资源不提供自动安装操作',
                tone: lifecycleCount ? 'success' : 'neutral'
              }
            ]}
          />
          <div className="toolkit-grid">
            {tools.map((tool) => {
              const activeTask = activeTaskFor(tool);
              const busyAction = busyActionFor(tool);
              const startupSources = tool.startupManaged
                ? tool.startupSources.map((source) => DISCOVERY_SOURCE_LABELS[source] || source).join('、')
                : '';
              return (
                <ManagedResourceCard
                  key={tool.id}
                  resourceId={tool.id}
                  name={tool.name}
                  installed={tool.installed}
                  icon={(
                    <span className="toolkit-client-glyph" aria-hidden="true">
                      <ToolOutlined />
                    </span>
                  )}
                  badges={(
                    <>
                      {tool.runtimeInspectable && tool.running ? (
                        <Tag color="processing" className="toolkit-status-tag">
                          <span className="hud-led hud-led--ok hud-led--live" aria-hidden="true" />
                          运行中
                        </Tag>
                      ) : null}
                      {tool.managedBy ? <Tag>{MANAGEMENT_LABELS[tool.managedBy] || tool.managedBy}</Tag> : null}
                    </>
                  )}
                  details={[
                    { label: '作用', value: tool.role },
                    { label: '当前版本', value: tool.installed ? tool.version : '未安装', muted: !tool.installed },
                    {
                      label: '程序',
                      value: tool.executablePath || tool.binaryName,
                      tooltip: tool.executablePath || tool.binaryName,
                      muted: !tool.installed
                    },
                    ...(tool.runtimeInspectable ? [{
                      label: '运行状态',
                      value: `${runtimeSummary(tool)}${startupSources ? `；自动启动：${startupSources}` : ''}`
                    }] : []),
                    ...(tool.configState !== 'none' || tool.runtimeInspectable ? [{
                      label: '配置',
                      value: configSummary(tool)
                    }] : []),
                    ...(tool.service ? [{
                      label: '服务',
                      value: `${serviceSummary(tool.service)}${tool.service.message ? `；${tool.service.message}` : ''}`,
                      tooltip: tool.service.lastError || tool.service.message || undefined
                    }, {
                      label: '守护策略',
                      value: (
                        <ToolServicePolicy
                          service={tool.service}
                          busy={toolService.busyFor(tool)}
                          onChange={(settings) => void toolService.updateSettings(tool, settings)}
                        />
                      )
                    }] : [])
                  ]}
                  actions={(
                    <Space size={6} wrap>
                      {activeTask ? (
                        <Tag color="processing" className="toolkit-status-tag">
                          <span className="hud-led hud-led--info hud-led--live" aria-hidden="true" />
                          {ACTION_LABELS[(activeTask.action as ManagedToolLifecycleAction) || 'update'] || '操作'}中
                          {` ${Math.round(Number(activeTask.progress?.percent || 0))}%`}
                        </Tag>
                      ) : null}
                      {tool.service ? (
                        <ToolServiceActions
                          tool={tool}
                          service={tool.service}
                          busy={toolService.busyFor(tool)}
                          onControl={(action) => toolService.control(tool, action)}
                          onCreateConfig={() => void toolService.createConfig(tool)}
                          onOpenLogs={() => void toolService.openLogs(tool)}
                        />
                      ) : null}
                      {!tool.installed && tool.canInstall ? (
                        <InstallLifecycleAction
                          action="install"
                          size="small"
                          iconOnly
                          tooltip={`安装 ${tool.name}`}
                          aria-label={`安装 ${tool.name}`}
                          loading={busyAction === 'install'}
                          disabled={Boolean(busyAction)}
                          onClick={() => void runAction(tool, 'install')}
                        />
                      ) : null}
                      {tool.installed && tool.canUpdate ? (
                        <InstallLifecycleAction
                          action="update"
                          size="small"
                          iconOnly
                          tooltip={`更新 ${tool.name}`}
                          aria-label={`更新 ${tool.name}`}
                          loading={busyAction === 'update'}
                          disabled={Boolean(busyAction)}
                          onClick={() => void runAction(tool, 'update')}
                        />
                      ) : null}
                      {tool.installed && tool.canUninstall ? (
                        <InstallLifecycleAction
                          action="uninstall"
                          size="small"
                          iconOnly
                          tooltip={`卸载 ${tool.name}`}
                          aria-label={`卸载 ${tool.name}`}
                          loading={busyAction === 'uninstall'}
                          disabled={Boolean(busyAction)}
                          onClick={() => void runAction(tool, 'uninstall')}
                        />
                      ) : null}
                      {tool.configEditable ? (
                        <Button
                          size="small"
                          shape="circle"
                          icon={<EditOutlined />}
                          aria-label={`编辑 ${tool.name} 配置`}
                          title={`编辑 ${tool.name} 配置`}
                          onClick={() => setEditingTool(tool)}
                        />
                      ) : null}
                      {tool.requiresElevation && tool.configEditable ? <Tag color="warning">保存需授权</Tag> : null}
                    </Space>
                  )}
                  footer={(
                    <span className="toolkit-capabilities">
                      {tool.capabilities.map((capability) => CAPABILITY_LABELS[capability] || capability).join(' · ')}
                    </span>
                  )}
                />
              );
            })}
          </div>
        </>
      ) : null}

      <ManagedToolConfigModal
        tool={editingTool}
        onClose={() => setEditingTool(null)}
        onSaved={() => void fetchTools()}
      />
      <ManagedToolLogsModal
        logs={toolService.logs}
        onReload={(tool) => void toolService.openLogs(tool)}
        onClose={toolService.closeLogs}
      />
    </section>
  );
}
