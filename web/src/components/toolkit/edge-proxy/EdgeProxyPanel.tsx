import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Space, Spin, Tag } from 'antd';
import {
  ApiOutlined,
  CodeOutlined,
  EditOutlined,
  FileTextOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import { toolkitAPI } from '@/services/api';
import type { ManagedToolItem } from '@/types';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import InstallLifecycleAction from '../InstallLifecycleAction';
import ManagedResourceCard from '../ManagedResourceCard';
import ManagedToolConfigModal from '../ManagedToolConfigModal';
import ManagedToolLogsModal from '../ManagedToolLogsModal';
import ToolkitStatusTrack from '../ToolkitStatusTrack';
import { ToolServiceActions, ToolServicePolicy } from '../ToolServiceControls';
import { useToolService } from '../use-tool-service';
import { managedToolConfigSummary as configSummary, MANAGED_TOOL_MANAGEMENT_LABELS as MANAGEMENT_LABELS, useManagedTools } from '../use-managed-tools';
import { serviceSummary } from '../tool-service-presentation';
import { LIFECYCLE_ACTION_LABELS } from '../lifecycle-presentation';
import EdgePlanCard from './EdgePlanCard';
import { edgeProxyAPI } from './edge-proxy-api';
import { EDGE_PROVIDER_META } from './edge-proxy-presentation';
import type { EdgeProvider, EdgeStatus } from './types';

// 入口层就是这三个软件：按 id 取（它们分属两个分类，界面要在一处管）。
const EDGE_TOOL_IDS = ['nginx', 'caddy', 'frp'];
const PROVIDER_ACTIONS: Record<EdgeProvider, string> = {
  nginx: '配置 443 入口',
  caddy: '配置 HTTPS 反向代理',
  frp: '转发到 VPS'
};

function managementLabel(managedBy: string) {
  if (!managedBy) return '未安装';
  // 标签只有一份事实源（与受管工具面板共用）。
  return MANAGEMENT_LABELS[managedBy] || managedBy;
}

/**
 * 入口与转发：nginx / caddy / frpc 的**插件化管理**（安装 / 更新 / 卸载 / 编辑配置 / 启停）
 * ＋边缘动作（把入口放到 443、上证书、从 VPS 转进来）。管理全套复用受管工具引擎与组件，
 * 界面这里不发明第二套安装流程。
 */
export default function EdgeProxyPanel({ variant = 'page' }: { variant?: 'page' | 'drawer' }) {
  const {
    loading: toolsLoading,
    error: toolsError,
    fetchTools,
    tools,
    activeTaskFor,
    busyActionFor,
    runAction
  } = useManagedTools(
    'edge-entry',
    { plan: toolkitAPI.planManagedToolAction, execute: toolkitAPI.executeManagedToolAction },
    { toolIds: EDGE_TOOL_IDS }
  );
  const toolService = useToolService(fetchTools);

  const [status, setStatus] = useState<EdgeStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [editingTool, setEditingTool] = useState<ManagedToolItem | null>(null);
  const [planProvider, setPlanProvider] = useState<EdgeProvider | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError('');
    try {
      setStatus(await edgeProxyAPI.status());
    } catch (error: unknown) {
      setStatusError(error instanceof Error ? error.message : '读取失败');
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTools();
    void loadStatus();
  }, [fetchTools, loadStatus]);

  const refreshAll = useCallback(async () => {
    await Promise.all([fetchTools(), loadStatus()]);
  }, [fetchTools, loadStatus]);

  const platform = status?.platform || '';
  const installedCount = useMemo(() => tools.filter((tool) => tool.installed).length, [tools]);
  const loading = toolsLoading && !tools.length;
  const error = toolsError || statusError;

  return (
    <section
      className={variant === 'drawer' ? 'toolkit-domain-panel' : 'toolkit-page toolkit-domain-panel'}
      aria-labelledby="toolkit-edge-title"
    >
      {variant === 'page' ? (
        <header className="toolkit-panel-header">
          <div>
            <div className="toolkit-panel-kicker">ENTRY &amp; FORWARDING</div>
            <h2 id="toolkit-edge-title">入口与转发</h2>
            <p>
              管本机的 nginx / caddy / frp：装什么、配置怎么写、服务起没起都在这里；
              改动一律先备份再校验，校验不过自动回滚。
            </p>
          </div>
          <div className="toolkit-header-actions">
            <Button icon={<ReloadOutlined />} loading={toolsLoading || statusLoading} onClick={() => void refreshAll()}>
              重新探测
            </Button>
          </div>
        </header>
      ) : null}

      {error ? <InlineNote tone="error" description={error}>本机入口探测失败</InlineNote> : null}

      {loading ? (
        <div className="toolkit-loading"><Spin size="large" tip="正在探测本机边缘件" /></div>
      ) : (
        <>
          <ToolkitStatusTrack
            ariaLabel="入口转发状态"
            items={[
              {
                label: '转发目标',
                value: status ? `127.0.0.1:${status.aihPort}` : '—',
                detail: '入口软件把流量转给 AIH 自己这个端口，不再另开端口',
                tone: 'info'
              },
              {
                label: '本机边缘件',
                value: `${installedCount} / ${EDGE_TOOL_IDS.length} 已安装`,
                detail: '只按服务端真实探测结果显示，不猜测',
                tone: installedCount ? 'success' : 'warning'
              },
              {
                label: '写入方式',
                value: '备份 → 校验 → 重载',
                detail: '校验失败整体回滚，不留半份配置',
                tone: 'neutral'
              }
            ]}
          />

          <div className="toolkit-observation-grid">
            {EDGE_TOOL_IDS.map((toolId) => {
              const tool = tools.find((item) => item.id === toolId);
              const provider = toolId as EdgeProvider;
              if (!tool) return null;
              const busy = busyActionFor(tool);
              const task = activeTaskFor(tool);
              const edge = status?.providers?.[provider];
              const configLine = configSummary(tool);
              return (
                <ManagedResourceCard
                  key={tool.id}
                  resourceId={tool.id}
                  name={tool.name}
                  installed={tool.installed}
                  icon={<CodeOutlined aria-hidden />}
                  badges={(
                    <>
                      {tool.version && tool.version !== '-' ? <Tag className="toolkit-status-tag">{tool.version}</Tag> : null}
                      <Tag className="toolkit-status-tag">{managementLabel(tool.managedBy)}</Tag>
                    </>
                  )}
                  details={[
                    { label: '用途', value: EDGE_PROVIDER_META[provider].role },
                    { label: '能力', value: EDGE_PROVIDER_META[provider].capability },
                    { label: '配置', value: configLine },
                    ...(tool.service ? [{
                      label: '服务',
                      value: `${serviceSummary(tool.service)}${tool.service.message ? `；${tool.service.message}` : ''}`,
                      tooltip: tool.service.lastError || tool.service.message || undefined
                    }] : []),
                    ...(provider === 'frp' && edge?.proxies?.length
                      ? [{
                        label: '现有转发',
                        value: edge.proxies.map((item) => `${item.name}(${item.type} ${item.localPort}→${item.remotePort})`).join('、')
                      }]
                      : [])
                  ]}
                  actions={(
                    <Space size={4} wrap>
                      {tool.canInstall ? (
                        <InstallLifecycleAction
                          action="install"
                          loading={busy === 'install'}
                          disabled={Boolean(busy)}
                          onClick={() => void runAction(tool, 'install')}
                        />
                      ) : null}
                      {tool.canUpdate ? (
                        <InstallLifecycleAction
                          action="update"
                          loading={busy === 'update'}
                          disabled={Boolean(busy)}
                          onClick={() => void runAction(tool, 'update')}
                        />
                      ) : null}
                      {tool.canUninstall ? (
                        <InstallLifecycleAction
                          action="uninstall"
                          iconOnly
                          loading={busy === 'uninstall'}
                          disabled={Boolean(busy)}
                          onClick={() => void runAction(tool, 'uninstall')}
                        />
                      ) : null}
                      <Button
                        size="small"
                        icon={<EditOutlined />}
                        disabled={!tool.configEditable}
                        title={tool.configEditable ? `编辑 ${tool.configName || '配置'}` : '没有可直接编辑的本地配置文件'}
                        onClick={() => setEditingTool(tool)}
                      >
                        配置
                      </Button>
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
                      <Button
                        size="small"
                        type="primary"
                        icon={<FileTextOutlined />}
                        disabled={!tool.installed}
                        onClick={() => setPlanProvider(provider)}
                      >
                        {PROVIDER_ACTIONS[provider]}
                      </Button>
                      {task ? (
                        <span className="toolkit-section-note">
                          {(LIFECYCLE_ACTION_LABELS as Readonly<Record<string, string>>)[task.action || ''] || '操作'}中
                        </span>
                      ) : null}
                    </Space>
                  )}
                  footer={tool.service ? (
                    <ToolServicePolicy
                      service={tool.service}
                      busy={toolService.busyFor(tool)}
                      onChange={(settings) => void toolService.updateSettings(tool, settings)}
                    />
                  ) : null}
                />
              );
            })}
          </div>

          <p className="toolkit-section-note">
            <ApiOutlined /> 命令行等价入口：<code>aih edge status | plan | apply</code>（Linux 上配置目录属 root，安装/卸载需要免密 sudo）。
          </p>
        </>
      )}

      <ManagedToolConfigModal
        tool={editingTool}
        onClose={() => setEditingTool(null)}
        onSaved={() => void refreshAll()}
      />
      <ManagedToolLogsModal
        logs={toolService.logs}
        onReload={(tool) => void toolService.openLogs(tool)}
        onClose={toolService.closeLogs}
      />

      <Modal
        open={Boolean(planProvider)}
        onCancel={() => setPlanProvider(null)}
        footer={null}
        width={880}
        destroyOnHidden
        title={planProvider ? `${EDGE_PROVIDER_META[planProvider].label} · ${PROVIDER_ACTIONS[planProvider]}` : ''}
      >
        {planProvider ? (
          <EdgePlanCard
            providers={[planProvider]}
            platform={platform}
            apply={{ onApplied: () => void refreshAll() }}
          />
        ) : null}
      </Modal>
    </section>
  );
}
