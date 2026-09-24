import { useMemo, useState } from 'react';
import { Empty, Segmented, Space, Spin, Tag } from 'antd';
import {
  BookOutlined,
  CodeOutlined,
  ExperimentOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { buildAppHref } from '@/services/app-navigation';
import type { EnvironmentLifecycleAction } from '@/types';
import { getEnvironmentCategoryLabel } from './environment-presentation';
import InstallLifecycleAction from './InstallLifecycleAction';
import {
  CLIENT_PLATFORM_LABELS as PLATFORM_LABELS,
  LIFECYCLE_ACTION_LABELS as ACTION_LABELS
} from './lifecycle-presentation';
import ManagedResourceCard from './ManagedResourceCard';
import ToolkitStatusTrack from './ToolkitStatusTrack';
import { useEnvironmentResources } from './use-environment-resources';

type RuntimeId = 'node' | 'python';

const RUNTIME_LABELS: Record<RuntimeId, string> = {
  node: 'Node.js',
  python: 'Python'
};

export default function EnvironmentPanel() {
  const [runtime, setRuntime] = useState<RuntimeId>('node');
  const { data, loading, error, load, activeTaskFor, busyActionFor, runAction } = useEnvironmentResources();

  const resources = useMemo(
    () => (data?.resources || []).filter((resource) => resource.runtime === runtime),
    [data, runtime]
  );
  const runtimeSummary = data?.runtimes[runtime];

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-environment-title">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">RUNTIME INVENTORY</div>
          <h2 id="toolkit-environment-title">运行环境</h2>
        </div>
        <div className="toolkit-header-actions">
          <Button
            icon={<BookOutlined />}
            href={buildAppHref('/toolkit/install-guide')}
          >
            安装指南与命令
          </Button>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>重新探测</Button>
        </div>
      </header>

      {error ? (
        <div className="toolkit-inline-error" role="alert">
          <span className="hud-led hud-led--err" aria-hidden="true" />
          <strong>运行环境读取失败</strong>
          <span>{error}</span>
        </div>
      ) : null}

      {loading && !data ? (
        <div className="toolkit-loading"><Spin size="large" tip="正在探测运行环境" /></div>
      ) : data ? (
        <>
          <ToolkitStatusTrack
            ariaLabel="运行环境状态轨道"
            items={[
              {
                label: '当前系统',
                value: PLATFORM_LABELS[data.platform] || data.platform,
                detail: '只展示本机可执行的管理方式',
                tone: 'info'
              },
              {
                label: RUNTIME_LABELS[runtime],
                value: runtimeSummary?.currentVersion || '未检测到',
                detail: runtimeSummary?.activePath || '当前 PATH 未发现运行时',
                tone: runtimeSummary?.currentVersion ? 'success' : 'warning'
              },
              {
                label: '工具资源',
                value: `${resources.filter((resource) => resource.installed).length} / ${resources.length} 已安装`,
                detail: '安装、更新、卸载均进入后台任务队列',
                tone: resources.some((resource) => resource.installed) ? 'success' : 'neutral'
              }
            ]}
          />

          <div className="toolkit-category-bar">
            <div className="toolkit-filter-scroll">
              <Segmented
                aria-label="运行环境类型"
                value={runtime}
                onChange={(value) => setRuntime(value as RuntimeId)}
                options={[
                  { label: 'Node.js', value: 'node', icon: <CodeOutlined /> },
                  { label: 'Python', value: 'python', icon: <ExperimentOutlined /> }
                ]}
              />
            </div>
            <span className="toolkit-result-count">当前显示 {resources.length} 项</span>
          </div>

          {resources.length ? (
            <div className="toolkit-grid">
              {resources.map((resource) => {
                const activeTask = activeTaskFor(resource);
                const busyAction = busyActionFor(resource);
                const installedVersion = resource.version || (resource.installed ? '未探测到' : '未安装');
                return (
                  <ManagedResourceCard
                    key={resource.id}
                    resourceId={resource.id}
                    name={resource.name}
                    installed={resource.installed}
                    icon={(
                      <span className="toolkit-client-glyph" aria-hidden="true">
                        {resource.runtime === 'node' ? <CodeOutlined /> : <ExperimentOutlined />}
                      </span>
                    )}
                    badges={<Tag>{getEnvironmentCategoryLabel(resource.category)}</Tag>}
                    details={[
                      { label: '当前版本', value: installedVersion, muted: !resource.installed },
                      ...(resource.installed ? [{
                        label: '程序路径',
                        value: resource.executablePath || '未探测到',
                        tooltip: resource.executablePath || '未探测到可执行路径'
                      }] : []),
                      ...(resource.managedVersions.length ? [{
                        label: '受管版本',
                        value: resource.managedVersions.join('、')
                      }] : [])
                    ]}
                    actions={(
                      <Space size={6} wrap>
                        {activeTask ? (
                          <Tag color="processing" className="toolkit-status-tag">
                            <span className="hud-led hud-led--info hud-led--live" aria-hidden="true" />
                            {ACTION_LABELS[(activeTask.action as EnvironmentLifecycleAction) || 'update'] || '操作'}中
                            {` ${Math.round(Number(activeTask.progress?.percent || 0))}%`}
                          </Tag>
                        ) : null}
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
          ) : <Empty description="当前系统没有可管理的运行环境工具" />}
        </>
      ) : null}
    </section>
  );
}
