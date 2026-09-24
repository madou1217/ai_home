import { Empty, Space, Spin, Tag, Tooltip } from 'antd';
import { CodeOutlined, ReloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InstallLifecycleAction, { type InstallLifecycleActionName as TerminalAction } from './InstallLifecycleAction';
import ManagedClientIcon from './ManagedClientIcon';
import ManagedResourceCard from './ManagedResourceCard';
import {
  CLIENT_PLATFORM_LABELS as PLATFORM_LABELS,
  LIFECYCLE_ACTION_LABELS as ACTION_LABELS
} from './lifecycle-presentation';
import {
  getTerminalExecutablePresentation,
  hasManagedTerminalLifecycle
} from './terminal-presentation';
import ToolkitStatusTrack from './ToolkitStatusTrack';
import { useTerminalManager } from './use-terminal-manager';

export default function TerminalManagerPanel() {
  const {
    terminals,
    platform,
    loading,
    error,
    openingId,
    load,
    openTerminal,
    runAction,
    activeTaskFor,
    actionBusyState,
    terminalLifecycleBusy
  } = useTerminalManager();

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-terminals-title">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">TERMINAL RUNTIME</div>
          <h2 id="toolkit-terminals-title">终端管理</h2>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>重新探测</Button>
      </header>
      {error ? (
        <div className="toolkit-inline-error" role="alert">
          <span className="hud-led hud-led--err" aria-hidden="true" />
          <strong>终端清单读取失败</strong>
          <span>{error}</span>
        </div>
      ) : null}
      {loading && !terminals.length ? (
        <div className="toolkit-loading"><Spin size="large" tip="正在探测终端" /></div>
      ) : terminals.length ? (
        <>
          <ToolkitStatusTrack
            ariaLabel="终端管理状态轨道"
            items={[
              {
                label: '当前系统',
                value: platform ? PLATFORM_LABELS[platform] || platform : '当前系统',
                detail: '只展示本机支持的终端',
                tone: 'info'
              },
              {
                label: '终端资源',
                value: `${terminals.filter((terminal) => terminal.installed || terminal.default).length} / ${terminals.length} 可用`,
                detail: '安装状态来自当前主机探测',
                tone: terminals.some((terminal) => terminal.installed || terminal.default) ? 'success' : 'neutral'
              },
              {
                label: '生命周期',
                value: '后台任务',
                detail: '安装、更新、卸载统一进入任务队列',
                tone: 'neutral'
              }
            ]}
          />
          <div className="toolkit-grid">
            {terminals.map((terminal) => {
              const executable = getTerminalExecutablePresentation(terminal);
              return (
                <ManagedResourceCard
                  key={terminal.id}
                  resourceId={terminal.id}
                  name={terminal.name}
                  installed={terminal.installed}
                  icon={<ManagedClientIcon clientType="terminal" clientName={terminal.name} />}
                  badges={<Tag color={terminal.default ? 'blue' : 'default'}>{terminal.default ? '系统默认' : '可选终端'}</Tag>}
                  details={[
                    {
                      label: '程序路径',
                      value: executable.value,
                      tooltip: executable.tooltip,
                      muted: executable.muted
                    },
                    ...(terminal.sourceUrl ? [{
                      label: '官方文档',
                      value: <a href={terminal.sourceUrl} target="_blank" rel="noreferrer">安装说明</a>
                    }] : [])
                  ]}
                  actions={(
                    <Space size={6} wrap>
                      {(() => {
                        const activeTask = activeTaskFor(terminal);
                        const lifecycleBusy = terminalLifecycleBusy(terminal);
                        const updateState = actionBusyState(terminal, 'update');
                        const uninstallState = actionBusyState(terminal, 'uninstall');
                        const managedLifecycle = hasManagedTerminalLifecycle(terminal);
                        return (
                          <>
                            {activeTask ? (
                              <Tag color="processing" className="toolkit-status-tag">
                                <span className="hud-led hud-led--info hud-led--live" aria-hidden="true" />
                                {ACTION_LABELS[(activeTask.action as TerminalAction) || 'update'] || '操作'}中
                                {` ${Math.round(Number(activeTask.progress?.percent || 0))}%`}
                              </Tag>
                            ) : null}
                            {terminal.canLaunch && (terminal.installed || terminal.default) && (
                              <Tooltip title={`唤起 ${terminal.name}`}>
                                <Button
                                  size="small"
                                  shape="circle"
                                  icon={<CodeOutlined />}
                                  aria-label={`唤起 ${terminal.name}`}
                                  loading={openingId === terminal.id}
                                  disabled={lifecycleBusy}
                                  onClick={() => void openTerminal(terminal)}
                                />
                              </Tooltip>
                            )}
                            {terminal.canInstall && !terminal.installed && (
                              <InstallLifecycleAction
                                action="install"
                                size="small"
                                iconOnly
                                tooltip={`安装 ${terminal.name}`}
                                aria-label={`安装 ${terminal.name}`}
                                disabled={lifecycleBusy}
                                loading={Boolean(actionBusyState(terminal, 'install').busy)}
                                onClick={() => void runAction(terminal, 'install')}
                              />
                            )}
                            {terminal.installed && managedLifecycle && (
                              <>
                                <InstallLifecycleAction
                                  action="update"
                                  size="small"
                                  iconOnly
                                  tooltip={`更新 ${terminal.name}`}
                                  aria-label={`更新 ${terminal.name}`}
                                  disabled={lifecycleBusy}
                                  loading={Boolean(updateState.busy)}
                                  onClick={() => void runAction(terminal, 'update')}
                                />
                                <InstallLifecycleAction
                                  action="uninstall"
                                  size="small"
                                  iconOnly
                                  tooltip={`卸载 ${terminal.name}`}
                                  aria-label={`卸载 ${terminal.name}`}
                                  disabled={lifecycleBusy}
                                  loading={Boolean(uninstallState.busy)}
                                  onClick={() => void runAction(terminal, 'uninstall')}
                                />
                              </>
                            )}
                          </>
                        );
                      })()}
                    </Space>
                  )}
                />
              );
            })}
          </div>
        </>
      ) : <Empty description="当前平台没有可管理的终端" />}
    </section>
  );
}
