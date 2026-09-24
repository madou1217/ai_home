import { useState } from 'react';
import type { ReactNode } from 'react';
import { DeleteOutlined, DownloadOutlined, ReloadOutlined, ToolOutlined } from '@ant-design/icons';
import { toolkitAPI } from '@/services/api';
import {
  MANAGED_TOOL_CAPABILITY_LABELS,
  MANAGED_TOOL_DISCOVERY_SOURCE_LABELS,
  MANAGED_TOOL_MANAGEMENT_LABELS,
  managedToolConfigSummary,
  managedToolRuntimeSummary,
  useManagedTools
} from '@/components/toolkit/use-managed-tools';
import MobileBoot from '@/mobile/MobileBoot';
import { DetailSheet, EmptySignal, HudSection, KeyValue, MonoList, SwipeRow, TelemetryGrid, TelemetryTile } from '@/mobile/ui';
import type { SwipeAction } from '@/mobile/ui';
import type { ManagedToolItem, ManagedToolLifecycleAction, ToolkitToolCategoryId } from '@/types';
import { ActionButton, InlineError, Note, PanelToolbar, StatusText, TaskStatus } from './toolkit-parts';
import styles from '../MobileToolkit.module.css';

const LIFECYCLE_API = {
  plan: toolkitAPI.planManagedToolAction,
  execute: toolkitAPI.executeManagedToolAction
};

/** 受管工具（会话运行时 / 接入与隧道）：探测状态 + 生命周期（计划确认 → 后台任务队列）。 */
export default function ToolsPanel({ category }: { category: ToolkitToolCategoryId }) {
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
  } = useManagedTools(category, LIFECYCLE_API);
  const [detailId, setDetailId] = useState('');
  const detail = tools.find((tool) => tool.id === detailId) || null;

  const actionsFor = (tool: ManagedToolItem): SwipeAction[] => {
    const busy = Boolean(busyActionFor(tool));
    const actions: SwipeAction[] = [];
    if (!tool.installed && tool.canInstall) {
      actions.push({ key: 'install', label: '安装', icon: <DownloadOutlined />, tone: 'primary', disabled: busy, onAction: () => void runAction(tool, 'install') });
    }
    if (tool.installed && tool.canUpdate) {
      actions.push({ key: 'update', label: '更新', icon: <ReloadOutlined />, disabled: busy, onAction: () => void runAction(tool, 'update') });
    }
    if (tool.installed && tool.canUninstall) {
      actions.push({ key: 'uninstall', label: '卸载', icon: <DeleteOutlined />, tone: 'danger', disabled: busy, onAction: () => void runAction(tool, 'uninstall') });
    }
    return actions;
  };

  const statusFor = (tool: ManagedToolItem) => {
    const task = activeTaskFor(tool);
    if (task) return <TaskStatus task={task} />;
    if (tool.runtimeInspectable && tool.running) return <StatusText tone="ok" live>运行中</StatusText>;
    if (tool.installed) return <StatusText tone="ok">已检测</StatusText>;
    if (!tool.supported) return <StatusText tone="muted">不适用</StatusText>;
    return <StatusText tone="muted">未安装</StatusText>;
  };

  if (loading && !data) return <MobileBoot label="PROBING TOOLS" />;

  return (
    <>
      <PanelToolbar
        refreshLabel="重新探测"
        refreshing={loading}
        onRefresh={fetchTools}
      />
      {error ? <InlineError title="工具状态读取失败" detail={error} onRetry={fetchTools} retrying={loading} /> : null}

      {data ? (
        <>
          <TelemetryGrid>
            <TelemetryTile label="工具记录" value={tools.length} unit="个" tone={tools.length ? 'info' : 'muted'} sub="来自当前主机与平台探测结果" />
            <TelemetryTile label="已检测" value={installedCount} unit="个" tone={installedCount ? 'ok' : 'warn'} led sub={`${editableCount} 个工具提供配置编辑入口`} />
            <TelemetryTile
              wide
              label="生命周期"
              value={lifecycleCount ? lifecycleCount : '仅探测'}
              unit={lifecycleCount ? '个可管理' : undefined}
              tone={lifecycleCount ? 'ok' : 'muted'}
              sub={lifecycleCount ? '安装、更新、卸载均进入后台任务队列' : '当前资源不提供自动安装操作'}
            />
          </TelemetryGrid>

          <HudSection title={categoryInfo?.label || category} code="TOOLS" count={tools.length}>
            {tools.length ? (
              <MonoList ariaLabel={`${categoryInfo?.label || category} 工具`}>
                {tools.map((tool) => (
                  <SwipeRow key={tool.id} actions={actionsFor(tool)} onTap={() => setDetailId(tool.id)} ariaLabel={`${tool.name} 详情`}>
                    <span className="mhud-row__icon"><ToolOutlined /></span>
                    <span className="mhud-row__main">
                      <span className="mhud-row__title">{tool.name}</span>
                      <span className="mhud-row__meta">{tool.installed ? tool.version : '未安装'} · {tool.role}</span>
                    </span>
                    <span className="mhud-row__side">{statusFor(tool)}</span>
                  </SwipeRow>
                ))}
              </MonoList>
            ) : (
              <EmptySignal description="当前分类没有工具记录" />
            )}
          </HudSection>
        </>
      ) : null}

      <DetailSheet
        open={Boolean(detail)}
        onClose={() => setDetailId('')}
        code="MANAGED TOOL"
        title={detail?.name || '工具'}
        footer={detail ? <ToolFooter tool={detail} busyAction={busyActionFor(detail)} onAction={(action) => void runAction(detail, action)} /> : null}
      >
        {detail ? <ToolDetail tool={detail} status={statusFor(detail)} /> : null}
      </DetailSheet>
    </>
  );
}

function ToolDetail({ tool, status }: { tool: ManagedToolItem; status: ReactNode }) {
  const startupSources = tool.startupManaged
    ? tool.startupSources.map((source) => MANAGED_TOOL_DISCOVERY_SOURCE_LABELS[source] || source).join('、')
    : '';
  return (
    <div className={styles.sheetStack}>
      <KeyValue
        rows={[
          { key: 'status', label: '状态', value: status },
          { key: 'role', label: '作用', value: tool.role, mono: false },
          { key: 'support', label: '平台', value: tool.supported ? '当前平台支持' : '当前平台不适用', mono: false, tone: tool.supported ? undefined : 'muted' },
          ...(tool.managedBy ? [{ key: 'managed', label: '管理方式', value: MANAGED_TOOL_MANAGEMENT_LABELS[tool.managedBy] || tool.managedBy, mono: false }] : []),
          { key: 'version', label: '当前版本', value: tool.installed ? tool.version : '未安装', tone: tool.installed ? undefined : 'muted' },
          { key: 'exe', label: '程序', value: tool.executablePath || tool.binaryName, tone: tool.installed ? undefined : 'muted' },
          ...(tool.runtimeInspectable ? [{
            key: 'runtime',
            label: '运行状态',
            value: `${managedToolRuntimeSummary(tool)}${startupSources ? `；自动启动：${startupSources}` : ''}`,
            mono: false
          }] : []),
          ...(tool.configState !== 'none' || tool.runtimeInspectable ? [{
            key: 'config',
            label: '配置',
            value: managedToolConfigSummary(tool),
            mono: false
          }] : []),
          { key: 'caps', label: '能力', value: tool.capabilities.map((capability) => MANAGED_TOOL_CAPABILITY_LABELS[capability] || capability).join(' · ') || '—', mono: false }
        ]}
      />
      {tool.configEditable ? (
        <Note tone="info" title="配置编辑">
          配置编辑器在桌面端提供{tool.requiresElevation ? '；该配置保存需系统授权' : ''}。
        </Note>
      ) : null}
    </div>
  );
}

function ToolFooter({ tool, busyAction, onAction }: {
  tool: ManagedToolItem;
  busyAction?: ManagedToolLifecycleAction;
  onAction: (action: ManagedToolLifecycleAction) => void;
}) {
  const busy = Boolean(busyAction);
  const installable = !tool.installed && tool.canInstall;
  const updatable = tool.installed && tool.canUpdate;
  const removable = tool.installed && tool.canUninstall;
  if (!installable && !updatable && !removable) {
    return <span className={styles.footerNote}>当前资源不提供自动安装操作</span>;
  }
  return (
    <>
      {installable ? <ActionButton icon={<DownloadOutlined />} label="安装" tone="primary" loading={busyAction === 'install'} disabled={busy} onClick={() => onAction('install')} /> : null}
      {updatable ? <ActionButton icon={<ReloadOutlined />} label="更新" tone="primary" loading={busyAction === 'update'} disabled={busy} onClick={() => onAction('update')} /> : null}
      {removable ? <ActionButton icon={<DeleteOutlined />} label="卸载" tone="danger" loading={busyAction === 'uninstall'} disabled={busy} onClick={() => onAction('uninstall')} /> : null}
    </>
  );
}
