import { useState } from 'react';
import { CodeOutlined, DeleteOutlined, DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { CLIENT_PLATFORM_LABELS } from '@/components/toolkit/lifecycle-presentation';
import {
  getTerminalExecutablePresentation,
  hasManagedTerminalLifecycle
} from '@/components/toolkit/terminal-presentation';
import { useTerminalManager } from '@/components/toolkit/use-terminal-manager';
import MobileBoot from '@/mobile/MobileBoot';
import { DetailSheet, EmptySignal, HudSection, KeyValue, MonoList, SwipeRow } from '@/mobile/ui';
import type { SwipeAction } from '@/mobile/ui';
import type { ClientTerminalItem } from '@/types';
import { ActionButton, InlineError, PanelToolbar, StatusText, TaskStatus } from './toolkit-parts';
import styles from '../MobileToolkit.module.css';

/** 终端管理：本机终端清单 + 唤起 / 安装 / 更新 / 卸载（均与桌面同一计划确认与任务队列）。 */
export default function TerminalsPanel() {
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
  const [detailId, setDetailId] = useState('');
  const detail = terminals.find((terminal) => terminal.id === detailId) || null;

  const available = terminals.filter((terminal) => terminal.installed || terminal.default).length;

  const actionsFor = (terminal: ClientTerminalItem): SwipeAction[] => {
    const busy = terminalLifecycleBusy(terminal);
    const actions: SwipeAction[] = [];
    if (terminal.canLaunch && (terminal.installed || terminal.default)) {
      actions.push({
        key: 'launch',
        label: openingId === terminal.id ? '唤起中' : '唤起',
        icon: <CodeOutlined />,
        tone: 'primary',
        disabled: busy || openingId === terminal.id,
        onAction: () => void openTerminal(terminal)
      });
    }
    if (terminal.canInstall && !terminal.installed) {
      actions.push({
        key: 'install',
        label: '安装',
        icon: <DownloadOutlined />,
        tone: 'primary',
        disabled: busy,
        onAction: () => void runAction(terminal, 'install')
      });
    }
    if (terminal.installed && hasManagedTerminalLifecycle(terminal)) {
      actions.push({
        key: 'update',
        label: '更新',
        icon: <ReloadOutlined />,
        disabled: busy,
        onAction: () => void runAction(terminal, 'update')
      });
      actions.push({
        key: 'uninstall',
        label: '卸载',
        icon: <DeleteOutlined />,
        tone: 'danger',
        disabled: busy,
        onAction: () => void runAction(terminal, 'uninstall')
      });
    }
    return actions;
  };

  const statusFor = (terminal: ClientTerminalItem) => {
    const task = activeTaskFor(terminal);
    if (task) return <TaskStatus task={task} />;
    if (terminal.installed) return <StatusText tone="ok">已安装</StatusText>;
    if (terminal.default) return <StatusText tone="info">系统默认</StatusText>;
    return <StatusText tone="muted">未安装</StatusText>;
  };

  if (loading && !terminals.length) return <MobileBoot label="PROBING TERMINALS" />;

  return (
    <>
      <PanelToolbar
        status={platform ? `${CLIENT_PLATFORM_LABELS[platform] || platform} · ${available} / ${terminals.length} 可用` : null}
        refreshLabel="重新探测"
        refreshing={loading}
        onRefresh={() => void load()}
      />
      {error ? <InlineError title="终端清单读取失败" detail={error} onRetry={() => void load()} retrying={loading} /> : null}

      <HudSection title="终端" code="TERM" count={terminals.length}>
        {terminals.length ? (
          <MonoList ariaLabel="终端清单">
            {terminals.map((terminal) => (
              <SwipeRow
                key={terminal.id}
                actions={actionsFor(terminal)}
                onTap={() => setDetailId(terminal.id)}
                ariaLabel={`${terminal.name} 详情`}
              >
                <span className="mhud-row__icon"><CodeOutlined /></span>
                <span className="mhud-row__main">
                  <span className="mhud-row__title">{terminal.name}</span>
                  <span className="mhud-row__meta">{getTerminalExecutablePresentation(terminal).value}</span>
                </span>
                <span className="mhud-row__side">{statusFor(terminal)}</span>
              </SwipeRow>
            ))}
          </MonoList>
        ) : (
          <EmptySignal description="当前平台没有可管理的终端" />
        )}
      </HudSection>

      <DetailSheet
        open={Boolean(detail)}
        onClose={() => setDetailId('')}
        code="TERMINAL"
        title={detail?.name || '终端'}
        footer={detail ? (
          <TerminalFooter
            terminal={detail}
            busy={terminalLifecycleBusy(detail)}
            opening={openingId === detail.id}
            installBusy={actionBusyState(detail, 'install').busy}
            updateBusy={actionBusyState(detail, 'update').busy}
            uninstallBusy={actionBusyState(detail, 'uninstall').busy}
            onLaunch={() => void openTerminal(detail)}
            onAction={(action) => void runAction(detail, action)}
          />
        ) : null}
      >
        {detail ? (
          <div className={styles.sheetStack}>
            <KeyValue
              rows={[
                { key: 'status', label: '状态', value: statusFor(detail) },
                { key: 'role', label: '类型', value: detail.default ? '系统默认' : '可选终端', mono: false },
                { key: 'path', label: '程序路径', value: getTerminalExecutablePresentation(detail).value, tone: getTerminalExecutablePresentation(detail).muted ? 'muted' : undefined },
                ...(detail.sourceUrl ? [{
                  key: 'docs',
                  label: '官方文档',
                  value: <a href={detail.sourceUrl} target="_blank" rel="noreferrer">安装说明</a>,
                  mono: false
                }] : [])
              ]}
            />
          </div>
        ) : null}
      </DetailSheet>
    </>
  );
}

function TerminalFooter({ terminal, busy, opening, installBusy, updateBusy, uninstallBusy, onLaunch, onAction }: {
  terminal: ClientTerminalItem;
  busy: boolean;
  opening: boolean;
  installBusy: boolean;
  updateBusy: boolean;
  uninstallBusy: boolean;
  onLaunch: () => void;
  onAction: (action: 'install' | 'update' | 'uninstall') => void;
}) {
  const launchable = terminal.canLaunch && (terminal.installed || terminal.default);
  const managed = terminal.installed && hasManagedTerminalLifecycle(terminal);
  const installable = terminal.canInstall && !terminal.installed;
  if (!launchable && !managed && !installable) {
    return <span className={styles.footerNote}>该终端不提供受管操作</span>;
  }
  return (
    <>
      {launchable ? <ActionButton icon={<CodeOutlined />} label="唤起" tone="primary" loading={opening} disabled={busy} onClick={onLaunch} /> : null}
      {installable ? <ActionButton icon={<DownloadOutlined />} label="安装" tone={launchable ? 'default' : 'primary'} loading={installBusy} disabled={busy} onClick={() => onAction('install')} /> : null}
      {managed ? (
        <>
          <ActionButton icon={<ReloadOutlined />} label="更新" loading={updateBusy} disabled={busy} onClick={() => onAction('update')} />
          <ActionButton icon={<DeleteOutlined />} label="卸载" tone="danger" loading={uninstallBusy} disabled={busy} onClick={() => onAction('uninstall')} />
        </>
      ) : null}
    </>
  );
}
