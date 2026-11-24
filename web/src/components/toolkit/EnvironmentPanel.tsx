import { useMemo, useState } from 'react';
import { Segmented, Select, Space, Tag } from 'antd';
import { BookOutlined, ReloadOutlined } from '@ant-design/icons';
import HudStateView from '@/components/hud/HudStateView';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import { SettingSection } from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import { buildAppHref } from '@/services/app-navigation';
import type { EnvironmentLifecycleAction } from '@/types';
import { getEnvironmentCategoryLabel } from './environment-presentation';
import InstallLifecycleAction from './InstallLifecycleAction';
import {
  CLIENT_PLATFORM_LABELS as PLATFORM_LABELS,
  LIFECYCLE_ACTION_LABELS as ACTION_LABELS
} from './lifecycle-presentation';
import ManagedResourceCard, { type ManagedResourceStatusBadge } from './ManagedResourceCard';
import { resolveRuntimePlugins, runtimePluginIcon, runtimePluginName } from './runtime-plugin-presentation';
import ToolkitEmptyState from './ToolkitEmptyState';
import ToolkitPanelHeader from './ToolkitPanelHeader';
import ToolkitStatusTrack from './ToolkitStatusTrack';
import { readToolkitTarget, writeToolkitTarget } from '@/pages/toolkit-url-state';
import { resolveOrderedDirection, useSurfaceSwitch } from '@/hooks/use-surface-switch';
import { useEnvironmentResources, useToolkitTargets } from './use-environment-resources';

function resolveEnvironmentStatusBadge(
  installed: boolean,
  activeAction?: string,
  progressPercent?: number,
  busyAction?: EnvironmentLifecycleAction
): ManagedResourceStatusBadge {
  const action = (activeAction || busyAction) as EnvironmentLifecycleAction | undefined;
  if (action) {
    const label = `${ACTION_LABELS[action] || '操作'}中${progressPercent ? ` ${Math.round(progressPercent)}%` : ''}`;
    return { status: 'saving', label };
  }
  return installed
    ? { status: 'saved', label: '已安装' }
    : { status: 'unset', label: '未安装' };
}

export default function EnvironmentPanel() {
  const [runtime, setRuntime] = useState('node');
  const [target, setTarget] = useState(() => readToolkitTarget());
  const { surfaceRef: gridSurfaceRef, switchSurface: switchGridSurface } = useSurfaceSwitch<HTMLDivElement>();
  const targets = useToolkitTargets();
  const remote = target !== 'local';
  const { data, loading, error, load, activeTaskFor, busyActionFor, runAction } = useEnvironmentResources(target);

  const changeTarget = (value: string) => {
    switchGridSurface(() => {
      setTarget(value);
      writeToolkitTarget(value);
    }, {
      slot: 'target',
      current: target,
      next: value
    });
  };

  const runtimePlugins = useMemo(
    () => resolveRuntimePlugins(data?.runtimePlugins, data?.resources),
    [data]
  );

  const resources = useMemo(
    () => (data?.resources || []).filter((resource) => resource.runtime === runtime),
    [data, runtime]
  );
  const installedCount = resources.filter((resource) => resource.installed).length;
  const runtimeSummary = data?.runtimes[runtime];

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-environment-title">
      <ToolkitPanelHeader
        titleId="toolkit-environment-title"
        title="运行环境"
        subtitle="查看本机或 SSH 远端的语言运行时与版本管理器，并执行安装更新。"
        extra={(
          <>
            <Select
              aria-label="执行目标"
              value={target}
              onChange={changeTarget}
              popupMatchSelectWidth={false}
              style={{ minWidth: 180 }}
              options={targets.map((item) => ({
                value: item.id,
                label: item.kind === 'local' ? item.label : `${item.label}（SSH）`,
                title: item.host || item.label
              }))}
            />
            <Button icon={<BookOutlined />} href={buildAppHref('/toolkit/install-guide')}>
              安装指南
            </Button>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load({ refresh: true })}>
              重新探测
            </Button>
          </>
        )}
      />

      {error ? (
        <InlineNote
          tone="error"
          description={error}
          action={<Button size="small" onClick={() => void load({ refresh: true })}>重试</Button>}
        >
          {remote ? '远端运行环境读取失败' : '运行环境读取失败'}
        </InlineNote>
      ) : null}

      {loading && !data ? (
        <HudStateView
          variant="loading"
          code="ENV // PROBE"
          title={remote ? '正在经 SSH 探测远端运行环境...' : '正在探测本机运行环境...'}
          compact
        />
      ) : data ? (
        <div className="toolkit-panel-stack">
          <ToolkitStatusTrack
            ariaLabel="运行环境状态轨道"
            items={[
              {
                label: remote ? `远端 · ${data.target?.label || ''}` : '执行目标',
                value: `${PLATFORM_LABELS[data.platform] || data.platform}${data.target?.arch ? ` · ${data.target.arch}` : ''}`,
                detail: remote ? '经 SSH 执行探测与管理' : '本机执行探测与管理',
                tone: 'info'
              },
              {
                label: runtimePluginName(runtimePlugins, runtime),
                value: runtimeSummary?.currentVersion || '未安装',
                detail: runtimeSummary?.activePath || '当前 PATH 未检测到运行时',
                tone: runtimeSummary?.currentVersion ? 'success' : 'warning'
              },
              {
                label: '工具资源',
                value: `${installedCount} / ${resources.length} 已安装`,
                detail: '生命周期变更通过后台任务执行',
                tone: installedCount ? 'success' : 'neutral'
              }
            ]}
          />

          <SettingSection
            title="受管运行时工具"
            description="按语言切换查看已探测工具与受管版本。"
            status={(
              <SettingStatusTag
                status={installedCount ? 'saved' : 'unset'}
                label={`已安装 ${installedCount} / ${resources.length}`}
                compact
              />
            )}
          >
            <div className="toolkit-panel-section-toolbar" style={{ paddingTop: 12 }}>
              <div className="toolkit-filter-scroll">
                <Segmented
                  aria-label="运行环境类型"
                  value={runtime}
                  onChange={(value) => {
                    const nextRuntime = String(value);
                    const order = runtimePlugins.map((plugin) => plugin.id);
                    switchGridSurface(() => setRuntime(nextRuntime), {
                      slot: 'runtime',
                      current: runtime,
                      next: nextRuntime,
                      direction: resolveOrderedDirection(order, runtime, nextRuntime)
                    });
                  }}
                  options={runtimePlugins.map((plugin) => ({
                    label: plugin.name,
                    value: plugin.id,
                    icon: runtimePluginIcon(plugin.id)
                  }))}
                />
              </div>
              <span className="toolkit-result-count">当前显示 {resources.length} 项</span>
            </div>

            <div ref={gridSurfaceRef} style={{ paddingBottom: 12 }}>
              {resources.length ? (
                <div className="toolkit-grid">
                  {resources.map((resource) => {
                    const activeTask = activeTaskFor(resource);
                    const busyAction = busyActionFor(resource);
                    const installedVersion = resource.version || (resource.installed ? '未探测到' : '未安装');
                    const statusBadge = resolveEnvironmentStatusBadge(
                      resource.installed,
                      activeTask?.action,
                      Number(activeTask?.progress?.percent || 0),
                      busyAction
                    );
                    return (
                      <ManagedResourceCard
                        key={resource.id}
                        resourceId={resource.id}
                        name={resource.name}
                        installed={resource.installed}
                        statusBadge={statusBadge}
                        icon={(
                          <span className="toolkit-client-glyph" aria-hidden="true">
                            {runtimePluginIcon(resource.runtime)}
                          </span>
                        )}
                        badges={<Tag>{getEnvironmentCategoryLabel(resource.category)}</Tag>}
                        details={[
                          { label: '当前版本', value: installedVersion, muted: !resource.installed },
                          ...(resource.installed ? [{
                            label: '程序路径',
                            value: resource.executablePath || '未探测到',
                            tooltip: resource.executablePath || '未探测到可执行路径',
                            ellipsis: true
                          }] : []),
                          ...(resource.managedVersions.length ? [{
                            label: '受管版本',
                            value: resource.managedVersions.join('、')
                          }] : [])
                        ]}
                        actions={(
                          <Space size={6} wrap>
                            {!resource.installed ? (
                              <InstallLifecycleAction
                                action="install"
                                size="small"
                                iconOnly
                                tooltip={`安装 ${resource.name}`}
                                aria-label={`安装 ${resource.name}`}
                                loading={busyAction === 'install'}
                                disabled={Boolean(busyAction) || !resource.canInstall}
                                onClick={() => void runAction(resource, 'install')}
                              />
                            ) : (
                              <>
                                <InstallLifecycleAction
                                  action="update"
                                  size="small"
                                  iconOnly
                                  tooltip={`更新 ${resource.name}`}
                                  aria-label={`更新 ${resource.name}`}
                                  loading={busyAction === 'update'}
                                  disabled={Boolean(busyAction) || !resource.canUpdate}
                                  onClick={() => void runAction(resource, 'update')}
                                />
                                <InstallLifecycleAction
                                  action="uninstall"
                                  size="small"
                                  iconOnly
                                  tooltip={`卸载 ${resource.name}`}
                                  aria-label={`卸载 ${resource.name}`}
                                  loading={busyAction === 'uninstall'}
                                  disabled={Boolean(busyAction) || !resource.canUninstall}
                                  onClick={() => void runAction(resource, 'uninstall')}
                                />
                              </>
                            )}
                          </Space>
                        )}
                      />
                    );
                  })}
                </div>
              ) : (
                <ToolkitEmptyState
                  title={remote ? '该远端系统暂无可管理的运行环境工具' : '当前运行时暂无可管理项'}
                  description="可前往安装指南查看手动安装命令，或切换其它运行环境分类。"
                  action={(
                    <Button type="primary" size="small" icon={<BookOutlined />} href={buildAppHref('/toolkit/install-guide')}>
                      查看安装指南
                    </Button>
                  )}
                />
              )}
            </div>
          </SettingSection>
        </div>
      ) : null}
    </section>
  );
}
