import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Space, Spin, Tag, message } from 'antd';
import {
  EditOutlined,
  LockOutlined,
  ReloadOutlined,
  ToolOutlined
} from '@ant-design/icons';
import { toolkitAPI } from '@/services/api';
import type {
  ManagedToolItem,
  ManagedToolLifecycleAction,
  ManagedToolsResponse,
  ToolkitToolCategoryId,
  ToolkitToolConfigResponse
} from '@/types';
import Button from '@/components/ui/AppButton';
import InstallLifecycleAction from './InstallLifecycleAction';
import ManagedResourceCard from './ManagedResourceCard';
import ToolkitStatusTrack from './ToolkitStatusTrack';
import ConfigCodeEditor from './config-editor/ConfigCodeEditor';
import useToolkitLifecycleController from './useToolkitLifecycleController';

const DISCOVERY_SOURCE_LABELS: Record<string, string> = {
  'running-process': '运行进程参数',
  systemd: 'systemd 服务',
  launchd: 'launchd 任务',
  'scheduled-task': 'Windows 计划任务',
  'windows-service': 'Windows 服务',
  'startup-command': '系统启动项',
  environment: '环境变量',
  'working-directory': '工作目录',
  'standard-path': '标准位置'
};

const CAPABILITY_LABELS: Record<string, string> = {
  detect: '安装检测',
  version: '版本读取',
  sessions: '会话支持',
  'config-edit': '配置编辑',
  'config-validate': '配置校验'
};

interface ManagedToolsPanelProps {
  category: ToolkitToolCategoryId;
}

const ACTION_LABELS: Record<ManagedToolLifecycleAction, string> = {
  install: '安装',
  update: '更新',
  uninstall: '卸载'
};

const MANAGEMENT_LABELS: Record<string, string> = {
  aih: 'AIH 管理',
  homebrew: 'Homebrew 管理',
  external: '外部安装'
};

function runtimeSummary(tool: ManagedToolItem) {
  if (!tool.runtimeInspectable) return '无需运行时探测';
  if (tool.running) return `运行中${tool.runningCount > 1 ? `（${tool.runningCount} 个）` : ''}`;
  return tool.installed ? '当前未运行' : '未发现程序';
}

function configSummary(tool: ManagedToolItem) {
  if (tool.configState === 'multiple') return `已发现 ${tool.configCount} 个配置，需先消除歧义`;
  if (tool.configState === 'unresolved') return '运行参数指向的配置当前无法安全读取';
  if (tool.configState === 'token-managed') return '令牌托管模式未使用本地配置文件';
  if (tool.configName) {
    return `${tool.configName} 已发现${tool.configSource ? `（${DISCOVERY_SOURCE_LABELS[tool.configSource] || tool.configSource}）` : ''}`;
  }
  return tool.runtimeInspectable ? '未发现实际配置文件' : '无本地配置';
}

function requestError(error: unknown, fallback: string) {
  if (typeof error !== 'object' || !error) return fallback;
  const candidate = error as {
    response?: { data?: { message?: string; error?: string } };
    message?: string;
  };
  return candidate.response?.data?.message
    || candidate.response?.data?.error
    || candidate.message
    || fallback;
}

export default function ManagedToolsPanel({ category }: ManagedToolsPanelProps) {
  const [data, setData] = useState<ManagedToolsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editingTool, setEditingTool] = useState<ManagedToolItem | null>(null);
  const [configData, setConfigData] = useState<ToolkitToolConfigResponse | null>(null);
  const [configContent, setConfigContent] = useState('');
  const [configLoading, setConfigLoading] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);

  const fetchTools = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await toolkitAPI.listTools();
      if (!result.ok) throw new Error('工具状态接口未返回可用结果');
      setData(result);
    } catch (error: unknown) {
      setError(requestError(error, '获取工具状态失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTools();
  }, [fetchTools]);

  const {
    activeTaskFor,
    busyActionFor,
    runAction
  } = useToolkitLifecycleController({
    source: 'managed-tool',
    scopeLabel: category === 'network-access' ? '网络接入与隧道' : '会话运行时',
    refresh: fetchTools,
    plan: (tool: ManagedToolItem, action) => (
      toolkitAPI.planManagedToolAction(tool.id, action)
    ),
    execute: (tool: ManagedToolItem, action) => (
      toolkitAPI.executeManagedToolAction(tool.id, action)
    ),
    plans: (response) => (response.plans || []).map((plan) => ({
      id: plan.id,
      label: plan.label,
      command: plan.command,
      args: plan.args
    }))
  });

  const tools = useMemo(
    () => (data?.tools || []).filter((tool) => tool.category === category),
    [category, data]
  );
  const categoryInfo = data?.categories.find((item) => item.id === category);
  const installedCount = tools.filter((tool) => tool.installed).length;
  const editableCount = tools.filter((tool) => tool.configEditable).length;
  const lifecycleCount = tools.filter((tool) => tool.canInstall || tool.canUpdate || tool.canUninstall).length;

  const openConfig = async (tool: ManagedToolItem) => {
    setEditingTool(tool);
    setConfigData(null);
    setConfigContent('');
    setConfigLoading(true);
    try {
      const result = await toolkitAPI.getToolConfig(tool.id);
      if (!result.ok) throw new Error('工具配置接口未返回可用结果');
      setConfigData(result);
      setConfigContent(result.content || '');
    } catch (error: unknown) {
      setEditingTool(null);
      message.error(requestError(error, '读取工具配置失败'));
    } finally {
      setConfigLoading(false);
    }
  };

  const saveConfig = async () => {
    if (!editingTool || !configData) return;
    setSavingConfig(true);
    try {
      const result = await toolkitAPI.saveToolConfig(
        editingTool.id,
        configContent,
        configData.revision,
        configData.targetRevision
      );
      if (!result.ok) throw new Error('工具配置保存接口返回失败');
      setConfigData(result);
      message.success(result.elevated ? '配置已通过系统授权保存' : '配置已保存');
      await fetchTools();
    } catch (error: unknown) {
      message.error(requestError(error, '保存工具配置失败'));
    } finally {
      setSavingConfig(false);
    }
  };

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
              { label: '配置', value: `${installedCount} 个已检测`, detail: `${editableCount} 个工具提供配置编辑入口`, tone: installedCount ? 'success' : 'warning' },
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
                      {tool.runtimeInspectable && tool.running ? <Tag color="processing">运行中</Tag> : null}
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
                    }] : [])
                  ]}
                  actions={(
                    <Space size={6} wrap>
                      {activeTask ? (
                        <Tag color="processing">
                          {ACTION_LABELS[(activeTask.action as ManagedToolLifecycleAction) || 'update'] || '操作'}中
                          {` ${Math.round(Number(activeTask.progress?.percent || 0))}%`}
                        </Tag>
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
                          onClick={() => openConfig(tool)}
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

      <Modal
        open={Boolean(editingTool)}
        title={editingTool ? `编辑 ${editingTool.name} 配置` : '编辑配置'}
        width={1000}
        confirmLoading={savingConfig}
        okText="保存配置"
        cancelText="取消"
        onOk={saveConfig}
        onCancel={() => {
          if (!savingConfig) {
            setEditingTool(null);
            setConfigData(null);
            setConfigContent('');
          }
        }}
        destroyOnClose
      >
        {configLoading ? (
          <div className="toolkit-loading compact"><Spin /></div>
        ) : (
          <>
            <div className="toolkit-inline-note" role="note">
              <LockOutlined aria-hidden="true" />
              <span>
                配置可能包含敏感信息；
                {configData?.requiresElevation
                  ? '当前目标需要系统授权才能保存，接口不会返回绝对路径。'
                  : `格式为 ${configData?.configFormat || editingTool?.configFormat || 'text'}，保存时会校验并发修改。`}
              </span>
            </div>
            <ConfigCodeEditor
              value={configContent}
              onChange={setConfigContent}
              format={configData?.configFormat || editingTool?.configFormat}
              fileName={configData?.configName || editingTool?.configName}
              ariaLabel={`${editingTool?.name || '工具'} 配置内容`}
              onSave={savingConfig ? undefined : () => void saveConfig()}
            />
          </>
        )}
      </Modal>
    </section>
  );
}
