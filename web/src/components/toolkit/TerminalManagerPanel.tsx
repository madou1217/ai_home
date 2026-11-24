import { Space, Tag, Tooltip } from 'antd';
import { CodeOutlined, ReloadOutlined } from '@ant-design/icons';
import HudStateView from '@/components/hud/HudStateView';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import { SettingSection } from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import InstallLifecycleAction, { type InstallLifecycleActionName as TerminalAction } from './InstallLifecycleAction';
import ManagedClientIcon from './ManagedClientIcon';
import ManagedResourceCard, { type ManagedResourceStatusBadge } from './ManagedResourceCard';
import ToolkitEmptyState from './ToolkitEmptyState';
import ToolkitPanelHeader from './ToolkitPanelHeader';
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

function resolveTerminalStatusBadge(
  installed: boolean,
  activeAction?: string,
  progressPercent?: number,
  busyAction?: TerminalAction
): ManagedResourceStatusBadge {
  const action = (activeAction || busyAction) as TerminalAction | undefined;
  if (action) {
    const label = `${ACTION_LABELS[action] || '操作'}中${progressPercent ? ` ${Math.round(progressPercent)}%` : ''}`;
    return { status: 'saving', label };
  }
  return installed
    ? { status: 'saved', label: '已安装' }
    : { status: 'unset', label: '未安装' };
}

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

  const availableCount = terminals.filter((terminal) => terminal.installed || terminal.default).length;

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-terminals-title">
      <ToolkitPanelHeader
        titleId="toolkit-terminals-title"
        title="终端管理"
        subtitle="管理本机受支持终端的安装状态与快捷唤起。"
        extra={(
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            重新探测
          </Button>
        )}
      />

      {error ? (
        <InlineNote
          tone="error"
          description={error}
          action={<Button size="small" onClick={() => void load()}>重试</Button>}
        >
          终端清单读取失败
        </InlineNote>
      ) : null}

      {loading && !terminals.length ? (
        <HudStateView variant="loading" code="TERMINAL // PROBE" title="正在探测本机终端..." compact />
      ) : terminals.length ? (
        <div className="toolkit-panel-stack">
          <ToolkitStatusTrack
            ariaLabel="终端管理状态轨道"
            items={[
              {
                label: '当前系统',
                value: platform ? PLATFORM_LABELS[platform] || platform : '当前系统',
                detail: '仅展示当前系统支持的终端',
                tone: 'info'
              },
              {
                label: '安装状态',
                value: `${availableCount} / ${terminals.length} 可用`,
                detail: `${terminals.length - availableCount} 个未安装`,
                tone: availableCount ? 'success' : 'neutral'
              },
              {
                label: '生命周期',
                value: '后台队列',
                detail: '安装、更新、卸载异步执行',
                tone: 'neutral'
              }
            ]}
          />

          <SettingSection
            title="终端列表"
            description="已安装终端可直接唤起，受管终端支持更新与卸载。"
            status={(
              <SettingStatusTag
                status={availableCount ? 'saved' : 'unset'}
                label={`可用 ${availableCount} / ${terminals.length}`}
                compact
              />
            )}
          >
            <div className="toolkit-grid" style={{ padding: '12px 0' }}>
              {terminals.map((terminal) => {
                const executable = getTerminalExecutablePresentation(terminal);
                const activeTask = activeTaskFor(terminal);
                const lifecycleBusy = terminalLifecycleBusy(terminal);
                const installState = actionBusyState(terminal, 'install');
                const updateState = actionBusyState(terminal, 'update');
                const uninstallState = actionBusyState(terminal, 'uninstall');
                const busyAction: TerminalAction | undefined = installState.busy
                  ? 'install'
                  : updateState.busy
                    ? 'update'
                    : uninstallState.busy
                      ? 'uninstall'
                      : undefined;
                const managedLifecycle = hasManagedTerminalLifecycle(terminal);
                const statusBadge = resolveTerminalStatusBadge(
                  terminal.installed,
                  activeTask?.action,
                  Number(activeTask?.progress?.percent || 0),
                  busyAction
                );

                return (
                  <ManagedResourceCard
                    key={terminal.id}
                    resourceId={terminal.id}
                    name={terminal.name}
                    installed={terminal.installed}
                    statusBadge={statusBadge}
                    icon={<ManagedClientIcon clientType="terminal" clientName={terminal.name} />}
                    badges={<Tag color={terminal.default ? 'blue' : 'default'}>{terminal.default ? '系统默认' : '可选终端'}</Tag>}
                    details={[
                      {
                        label: '程序路径',
                        value: executable.value,
                        tooltip: executable.tooltip,
                        muted: executable.muted,
                        ellipsis: true
                      },
                      ...(terminal.sourceUrl ? [{
                        label: '官方文档',
                        value: <a href={terminal.sourceUrl} target="_blank" rel="noreferrer">安装说明</a>
                      }] : [])
                    ]}
                    actions={(
                      <Space size={6} wrap>
                        {terminal.canLaunch && (terminal.installed || terminal.default) ? (
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
                        ) : null}
                        {terminal.canInstall && !terminal.installed ? (
                          <InstallLifecycleAction
                            action="install"
                            size="small"
                            iconOnly
                            tooltip={`安装 ${terminal.name}`}
                            aria-label={`安装 ${terminal.name}`}
                            disabled={lifecycleBusy}
                            loading={Boolean(installState.busy)}
                            onClick={() => void runAction(terminal, 'install')}
                          />
                        ) : null}
                        {terminal.installed && managedLifecycle ? (
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
                        ) : null}
                      </Space>
                    )}
                  />
                );
              })}
            </div>
          </SettingSection>
        </div>
      ) : (
        <ToolkitEmptyState
          title="当前平台没有可管理的终端"
          description="重新探测可刷新本机可用终端清单。"
          action={(
            <Button type="primary" size="small" icon={<ReloadOutlined />} onClick={() => void load()}>
              重新探测
            </Button>
          )}
        />
      )}
    </section>
  );
}
