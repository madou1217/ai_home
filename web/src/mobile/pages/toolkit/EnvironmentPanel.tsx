import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { history } from '@umijs/max';
import {
  BookOutlined,
  CodeOutlined,
  DeleteOutlined,
  DownloadOutlined,
  ExperimentOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import { getEnvironmentCategoryLabel } from '@/components/toolkit/environment-presentation';
import { CLIENT_PLATFORM_LABELS } from '@/components/toolkit/lifecycle-presentation';
import { useEnvironmentResources } from '@/components/toolkit/use-environment-resources';
import MobileBoot from '@/mobile/MobileBoot';
import {
  DetailSheet,
  EmptySignal,
  HudChips,
  HudIconButton,
  HudSection,
  KeyValue,
  MonoList,
  SwipeRow,
  TelemetryGrid,
  TelemetryTile
} from '@/mobile/ui';
import type { SwipeAction } from '@/mobile/ui';
import type { EnvironmentLifecycleAction, EnvironmentResourceItem } from '@/types';
import { ActionButton, InlineError, PanelToolbar, StatusText, TaskStatus } from './toolkit-parts';
import styles from '../MobileToolkit.module.css';

type RuntimeId = 'node' | 'python';

const RUNTIME_LABELS: Record<RuntimeId, string> = {
  node: 'Node.js',
  python: 'Python'
};

const RUNTIME_ICONS: Record<RuntimeId, ReactNode> = {
  node: <CodeOutlined />,
  python: <ExperimentOutlined />
};

/** 运行环境：Node / Python 工具链探测 + 生命周期（计划确认 → 后台任务队列），并链接安装指南。 */
export default function EnvironmentPanel() {
  const [runtime, setRuntime] = useState<RuntimeId>('node');
  const [detailId, setDetailId] = useState('');
  const { data, loading, error, load, activeTaskFor, busyActionFor, runAction } = useEnvironmentResources();

  const resources = useMemo(
    () => (data?.resources || []).filter((resource) => resource.runtime === runtime),
    [data, runtime]
  );
  const runtimeSummary = data?.runtimes[runtime];
  const detail = (data?.resources || []).find((resource) => resource.id === detailId) || null;

  const actionsFor = (resource: EnvironmentResourceItem): SwipeAction[] => {
    const busy = Boolean(busyActionFor(resource));
    if (!resource.installed) {
      return [{ key: 'install', label: '安装', icon: <DownloadOutlined />, tone: 'primary', disabled: busy || !resource.canInstall, onAction: () => void runAction(resource, 'install') }];
    }
    return [
      { key: 'update', label: '更新', icon: <ReloadOutlined />, disabled: busy || !resource.canUpdate, onAction: () => void runAction(resource, 'update') },
      { key: 'uninstall', label: '卸载', icon: <DeleteOutlined />, tone: 'danger', disabled: busy || !resource.canUninstall, onAction: () => void runAction(resource, 'uninstall') }
    ];
  };

  const statusFor = (resource: EnvironmentResourceItem) => {
    const task = activeTaskFor(resource);
    if (task) return <TaskStatus task={task} />;
    return resource.installed ? <StatusText tone="ok">已安装</StatusText> : <StatusText tone="muted">未安装</StatusText>;
  };

  if (loading && !data) return <MobileBoot label="PROBING RUNTIMES" />;

  return (
    <>
      <PanelToolbar
        status={data ? `当前系统 ${CLIENT_PLATFORM_LABELS[data.platform] || data.platform}` : null}
        refreshLabel="重新探测"
        refreshing={loading}
        onRefresh={() => void load()}
      >
        <HudIconButton icon={<BookOutlined />} label="安装指南与命令" onClick={() => history.push('/toolkit/install-guide')} />
      </PanelToolbar>
      {error ? <InlineError title="运行环境读取失败" detail={error} onRetry={() => void load()} retrying={loading} /> : null}

      {data ? (
        <>
          <HudChips
            ariaLabel="运行环境类型"
            value={runtime}
            onChange={(value) => setRuntime(value as RuntimeId)}
            items={(['node', 'python'] as RuntimeId[]).map((id) => ({ key: id, label: RUNTIME_LABELS[id], icon: RUNTIME_ICONS[id] }))}
          />

          <TelemetryGrid>
            <TelemetryTile
              wide
              label={RUNTIME_LABELS[runtime]}
              value={runtimeSummary?.currentVersion || '未检测到'}
              tone={runtimeSummary?.currentVersion ? 'ok' : 'warn'}
              led
              sub={runtimeSummary?.activePath || '当前 PATH 未发现运行时'}
            />
            <TelemetryTile
              wide
              label="工具资源"
              value={resources.filter((resource) => resource.installed).length}
              unit={`/ ${resources.length} 已安装`}
              tone={resources.some((resource) => resource.installed) ? 'ok' : 'muted'}
              sub="安装、更新、卸载均进入后台任务队列"
            />
          </TelemetryGrid>

          <HudSection title={`${RUNTIME_LABELS[runtime]} 工具`} code="RUNTIME" count={resources.length}>
            {resources.length ? (
              <MonoList ariaLabel={`${RUNTIME_LABELS[runtime]} 工具`}>
                {resources.map((resource) => (
                  <SwipeRow key={resource.id} actions={actionsFor(resource)} onTap={() => setDetailId(resource.id)} ariaLabel={`${resource.name} 详情`}>
                    <span className="mhud-row__icon">{RUNTIME_ICONS[resource.runtime]}</span>
                    <span className="mhud-row__main">
                      <span className="mhud-row__title">{resource.name}</span>
                      <span className="mhud-row__meta">
                        {getEnvironmentCategoryLabel(resource.category)} · {resource.version || (resource.installed ? '未探测到' : '未安装')}
                      </span>
                    </span>
                    <span className="mhud-row__side">{statusFor(resource)}</span>
                  </SwipeRow>
                ))}
              </MonoList>
            ) : (
              <EmptySignal description="当前系统没有可管理的运行环境工具" />
            )}
          </HudSection>
        </>
      ) : null}

      <DetailSheet
        open={Boolean(detail)}
        onClose={() => setDetailId('')}
        code={detail ? `RUNTIME // ${detail.runtime.toUpperCase()}` : 'RUNTIME'}
        title={detail?.name || '运行环境'}
        footer={detail ? <EnvironmentFooter resource={detail} busyAction={busyActionFor(detail)} onAction={(action) => void runAction(detail, action)} /> : null}
      >
        {detail ? (
          <div className={styles.sheetStack}>
            <KeyValue
              rows={[
                { key: 'status', label: '状态', value: statusFor(detail) },
                { key: 'category', label: '类别', value: getEnvironmentCategoryLabel(detail.category), mono: false },
                { key: 'version', label: '当前版本', value: detail.version || (detail.installed ? '未探测到' : '未安装'), tone: detail.installed ? undefined : 'muted' },
                ...(detail.installed ? [{ key: 'path', label: '程序路径', value: detail.executablePath || '未探测到' }] : []),
                ...(detail.managedVersions.length ? [{ key: 'managed', label: '受管版本', value: detail.managedVersions.join('、') }] : [])
              ]}
            />
          </div>
        ) : null}
      </DetailSheet>
    </>
  );
}

function EnvironmentFooter({ resource, busyAction, onAction }: {
  resource: EnvironmentResourceItem;
  busyAction?: EnvironmentLifecycleAction;
  onAction: (action: EnvironmentLifecycleAction) => void;
}) {
  const busy = Boolean(busyAction);
  if (!resource.installed) {
    return <ActionButton icon={<DownloadOutlined />} label="安装" tone="primary" loading={busyAction === 'install'} disabled={busy || !resource.canInstall} onClick={() => onAction('install')} />;
  }
  return (
    <>
      <ActionButton icon={<ReloadOutlined />} label="更新" tone="primary" loading={busyAction === 'update'} disabled={busy || !resource.canUpdate} onClick={() => onAction('update')} />
      <ActionButton icon={<DeleteOutlined />} label="卸载" tone="danger" loading={busyAction === 'uninstall'} disabled={busy || !resource.canUninstall} onClick={() => onAction('uninstall')} />
    </>
  );
}
