import { useState } from 'react';
import { Space, Tag } from 'antd';
import { EditOutlined, ReloadOutlined, ToolOutlined } from '@ant-design/icons';
import HudStateView from '@/components/hud/HudStateView';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import { SettingSection } from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import { toolkitAPI } from '@/services/api';
import type {
  ManagedToolItem,
  ManagedToolLifecycleAction,
  ToolkitToolCategoryId,
} from '@/types';
import InstallLifecycleAction from './InstallLifecycleAction';
import ManagedResourceCard, { type ManagedResourceStatusBadge } from './ManagedResourceCard';
import ManagedToolConfigModal from './ManagedToolConfigModal';
import ManagedToolLogsModal from './ManagedToolLogsModal';
import ToolkitEmptyState from './ToolkitEmptyState';
import ToolkitPanelHeader from './ToolkitPanelHeader';
import ToolkitStatusTrack from './ToolkitStatusTrack';
import { ToolServiceActions, ToolServicePolicy } from './ToolServiceControls';
import { serviceSummary } from './tool-service-presentation';
import { useToolService } from './use-tool-service';
import { LIFECYCLE_ACTION_LABELS as ACTION_LABELS } from './lifecycle-presentation';
import {
  MANAGED_TOOL_CAPABILITY_LABELS as CAPABILITY_LABELS,
  MANAGED_TOOL_DISCOVERY_SOURCE_LABELS as DISCOVERY_SOURCE_LABELS,
  MANAGED_TOOL_MANAGEMENT_LABELS as MANAGEMENT_LABELS,
  managedToolConfigSummary as configSummary,
  managedToolRuntimeSummary as runtimeSummary,
  useManagedTools
} from './use-managed-tools';

interface ManagedToolsPanelProps {
  category: ToolkitToolCategoryId;
}

function resolveToolStatusBadge(
  tool: ManagedToolItem,
  activeAction?: string,
  progressPercent?: number,
  busyAction?: ManagedToolLifecycleAction
): ManagedResourceStatusBadge {
  const action = (activeAction || busyAction) as ManagedToolLifecycleAction | undefined;
  if (action) {
    const label = `${ACTION_LABELS[action] || '操作'}中${progressPercent ? ` ${Math.round(progressPercent)}%` : ''}`;
    return { status: 'saving', label };
  }
  if (tool.service?.lastError) {
    return { status: 'error', label: '失败', detail: tool.service.lastError };
  }
  if (tool.installed) {
    return { status: 'saved', label: '已安装' };
  }
  return { status: 'unset', label: '未安装' };
}

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

  const categoryTitle = categoryInfo?.label || category;

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby={`toolkit-tools-${category}`}>
      <ToolkitPanelHeader
        titleId={`toolkit-tools-${category}`}
        title={categoryTitle}
        subtitle="管理本机受管工具的安装生命周期、守护策略与配置文件。"
        extra={(
          <Button icon={<ReloadOutlined />} loading={loading} onClick={fetchTools}>
            重新探测
          </Button>
        )}
      />

      {error ? (
        <InlineNote
          tone="error"
          description={error}
          action={<Button size="small" onClick={fetchTools}>重试</Button>}
        >
          工具状态读取失败
        </InlineNote>
      ) : null}

      {loading && !data ? (
        <HudStateView variant="loading" code="TOOLKIT // PROBE" title="正在探测主机受管工具..." compact />
      ) : data ? (
        <div className="toolkit-panel-stack">
          <ToolkitStatusTrack
            ariaLabel={`${categoryTitle} 状态轨道`}
            items={[
              { label: '已探测', value: `${tools.length} 个工具`, detail: '本机平台支持清单', tone: tools.length ? 'info' : 'neutral' },
              { label: '安装状态', value: `${installedCount} 个已安装`, detail: editableCount ? `${editableCount} 个可编辑配置` : '暂无可编辑配置', tone: installedCount ? 'success' : 'warning' },
              {
                label: '生命周期',
                value: lifecycleCount ? `${lifecycleCount} 个可托管` : '仅探测',
                detail: lifecycleCount ? '支持后台安装、更新与卸载' : '仅展示实测状态',
                tone: lifecycleCount ? 'success' : 'neutral'
              }
            ]}
          />

          <SettingSection
            title="受管工具清单"
            description="展示工具安装状态、守护控制与配置入口。"
            status={(
              <SettingStatusTag
                status={installedCount ? 'saved' : 'unset'}
                label={`已安装 ${installedCount} / ${tools.length}`}
                compact
              />
            )}
          >
            <div style={{ padding: '12px 0' }}>
              {tools.length ? (
                <div className="toolkit-grid">
                  {tools.map((tool) => {
                    const activeTask = activeTaskFor(tool);
                    const busyAction = busyActionFor(tool);
                    const startupSources = tool.startupManaged
                      ? tool.startupSources.map((source) => DISCOVERY_SOURCE_LABELS[source] || source).join('、')
                      : '';
                    const statusBadge = resolveToolStatusBadge(
                      tool,
                      activeTask?.action,
                      Number(activeTask?.progress?.percent || 0),
                      busyAction
                    );

                    return (
                      <ManagedResourceCard
                        key={tool.id}
                        resourceId={tool.id}
                        name={tool.name}
                        installed={tool.installed}
                        statusBadge={statusBadge}
                        icon={(
                          <span className="toolkit-client-glyph" aria-hidden="true">
                            <ToolOutlined />
                          </span>
                        )}
                        badges={(
                          <>
                            {tool.runtimeInspectable ? (
                              <Tag color={tool.running ? 'success' : 'default'}>
                                {tool.running ? '已启用' : '未启用'}
                              </Tag>
                            ) : null}
                            {tool.managedBy ? <Tag>{MANAGEMENT_LABELS[tool.managedBy] || tool.managedBy}</Tag> : null}
                            {tool.requiresElevation && tool.configEditable ? <Tag color="warning">保存需授权</Tag> : null}
                          </>
                        )}
                        details={[
                          { label: '作用', value: tool.role },
                          { label: '当前版本', value: tool.installed ? tool.version : '未安装', muted: !tool.installed },
                          {
                            label: '程序',
                            value: tool.executablePath || tool.binaryName,
                            tooltip: tool.executablePath || tool.binaryName,
                            muted: !tool.installed,
                            ellipsis: true
                          },
                          ...(tool.runtimeInspectable ? [{
                            label: '运行状态',
                            value: `${runtimeSummary(tool)}${startupSources ? `；自启：${startupSources}` : ''}`
                          }] : []),
                          ...(tool.configEditable || tool.configState !== 'none' || tool.runtimeInspectable ? [{
                            label: '配置',
                            value: configSummary(tool)
                          }] : []),
                          ...(tool.installed && tool.service ? [{
                            label: '服务',
                            value: `${serviceSummary(tool.service)}${tool.service.message ? `；${tool.service.message}` : ''}`,
                            tooltip: tool.service.lastError || tool.service.message || undefined
                          }, {
                            label: '守护策略',
                            value: (
                              <ToolServicePolicy
                                installed={tool.installed}
                                service={tool.service}
                                busy={toolService.busyFor(tool)}
                                onChange={(settings) => void toolService.updateSettings(tool, settings)}
                              />
                            )
                          }] : [])
                        ]}
                        actions={(
                          <Space size={6} wrap>
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
                                aria-label={`${tool.configExists ? '编辑' : '新建'} ${tool.name} 配置`}
                                title={`${tool.configExists ? '编辑' : '新建'} ${tool.name} 配置`}
                                onClick={() => setEditingTool(tool)}
                              />
                            ) : null}
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
              ) : (
                <ToolkitEmptyState
                  title="当前分类暂无受管工具"
                  description="重新探测以检查本机可用工具。"
                  action={(
                    <Button type="primary" size="small" icon={<ReloadOutlined />} onClick={fetchTools}>
                      重新探测
                    </Button>
                  )}
                />
              )}
            </div>
          </SettingSection>
        </div>
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
