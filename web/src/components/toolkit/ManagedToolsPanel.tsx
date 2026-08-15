import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Modal, Space, Spin, Tag, message } from 'antd';
import {
  CheckCircleOutlined,
  EditOutlined,
  LockOutlined,
  ReloadOutlined,
  ToolOutlined
} from '@ant-design/icons';
import { toolkitAPI } from '@/services/api';
import type { ManagedToolItem, ManagedToolsResponse, ToolkitToolCategoryId, ToolkitToolConfigResponse } from '@/types';
import Button from '@/components/ui/AppButton';
import ToolkitStatusTrack from './ToolkitStatusTrack';
import ConfigCodeEditor from './config-editor/ConfigCodeEditor';

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

  const tools = useMemo(
    () => (data?.tools || []).filter((tool) => tool.category === category),
    [category, data]
  );
  const categoryInfo = data?.categories.find((item) => item.id === category);
  const installedCount = tools.filter((tool) => tool.installed).length;
  const editableCount = tools.filter((tool) => tool.configEditable).length;

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
          <p>{categoryInfo?.description || '检测当前平台支持的工具。'}</p>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={fetchTools}>刷新</Button>
      </header>

      {error && <Alert type="error" showIcon message="工具状态读取失败" description={error} />}

      {loading && !data ? (
        <div className="toolkit-loading"><Spin size="large" /></div>
      ) : data ? (
        <>
          <ToolkitStatusTrack
            ariaLabel={`${categoryInfo?.label || category} 状态轨道`}
            items={[
              { label: '实测', value: `${tools.length} 个工具记录`, detail: '来自当前主机与平台探测结果', tone: tools.length ? 'info' : 'neutral' },
              { label: '配置', value: `${installedCount} 个已检测`, detail: `${editableCount} 个工具提供配置编辑入口`, tone: installedCount ? 'success' : 'warning' },
              { label: '指南', value: '显式读取与保存', detail: '不会在本面板自动安装、启动或猜测配置', tone: 'neutral' }
            ]}
          />
          <div className="toolkit-grid">
            {tools.map((tool) => (
            <div key={tool.id} className={`toolkit-app-card ${tool.installed ? 'installed' : 'uninstalled'}`}>
              <div>
                <div className="toolkit-card-header">
                  <div className="toolkit-card-title-group">
                    <ToolOutlined className="toolkit-tool-icon" data-installed={tool.installed || undefined} />
                    <div>
                      <h3 className="toolkit-card-title">{tool.name}</h3>
                      <Space className="toolkit-card-tags" size={4} wrap>
                        <Tag color={tool.supported ? 'blue' : 'default'}>{tool.supported ? '当前平台支持' : '当前平台不适用'}</Tag>
                        {tool.installed && <Tag color="success"><CheckCircleOutlined /> 已检测</Tag>}
                        {tool.runtimeInspectable && tool.running && <Tag color="green">运行中</Tag>}
                        {tool.runtimeInspectable && tool.installed && !tool.running && <Tag>未运行</Tag>}
                      </Space>
                    </div>
                  </div>
                </div>
                <div className="toolkit-card-body">
                  <div className="toolkit-detail-row"><span className="toolkit-detail-label">作用:</span><span className="toolkit-detail-value">{tool.role}</span></div>
                  <div className="toolkit-detail-row"><span className="toolkit-detail-label">版本:</span><span className="toolkit-detail-value">{tool.version}</span></div>
                  <div className="toolkit-detail-row"><span className="toolkit-detail-label">程序:</span><span className="toolkit-detail-value">{tool.binaryName}</span></div>
                  <div className="toolkit-detail-row"><span className="toolkit-detail-label">服务:</span><span className="toolkit-detail-value">{tool.serviceManager}</span></div>
                  {tool.runtimeInspectable && (
                    <div className="toolkit-detail-row">
                      <span className="toolkit-detail-label">运行:</span>
                      <span className="toolkit-detail-value">
                        {tool.running ? `运行中${tool.runningCount > 1 ? `（${tool.runningCount} 个）` : ''}` : tool.installed ? '当前未运行' : '未发现程序'}
                        {tool.startupManaged ? `；自动启动：${tool.startupSources.map((source) => DISCOVERY_SOURCE_LABELS[source] || source).join('、')}` : ''}
                      </span>
                    </div>
                  )}
                  {tool.configState === 'multiple' ? (
                    <div className="toolkit-detail-row">
                      <span className="toolkit-detail-label">配置:</span>
                      <span className="toolkit-detail-value">
                        已发现 {tool.configCount} 个实际配置文件；为避免误编辑，当前不自动选择
                      </span>
                    </div>
                  ) : tool.configState === 'unresolved' ? (
                    <div className="toolkit-detail-row">
                      <span className="toolkit-detail-label">配置:</span>
                      <span className="toolkit-detail-value">运行或启动参数指向的配置当前无法安全读取</span>
                    </div>
                  ) : tool.configState === 'token-managed' ? (
                    <div className="toolkit-detail-row">
                      <span className="toolkit-detail-label">配置:</span>
                      <span className="toolkit-detail-value">令牌托管模式未使用可编辑的本地 config.yml</span>
                    </div>
                  ) : tool.configName ? (
                    <div className="toolkit-detail-row">
                      <span className="toolkit-detail-label">配置:</span>
                      <span className="toolkit-detail-value">
                        {tool.configName} 已发现{tool.configSource ? `（${DISCOVERY_SOURCE_LABELS[tool.configSource] || tool.configSource}）` : ''}
                      </span>
                    </div>
                  ) : tool.runtimeInspectable ? (
                    <div className="toolkit-detail-row">
                      <span className="toolkit-detail-label">配置:</span>
                      <span className="toolkit-detail-value">未发现实际配置文件</span>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="toolkit-card-actions">
                <Space size={8}>
                  {tool.configEditable && (
                    <Button size="small" icon={<EditOutlined />} onClick={() => openConfig(tool)}>编辑配置</Button>
                  )}
                  {tool.requiresElevation && tool.configEditable && <Badge status="warning" text="保存需授权" />}
                </Space>
                <span className="toolkit-capabilities">
                  {tool.capabilities.map((capability) => CAPABILITY_LABELS[capability] || capability).join(' · ')}
                </span>
              </div>
            </div>
            ))}
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
            <Alert
              type="warning"
              showIcon
              icon={<LockOutlined />}
              className="toolkit-modal-alert"
              message="配置可能包含令牌或其他敏感信息"
              description={configData?.requiresElevation
                ? '当前配置需要系统授权才能保存；不会在页面或接口中显示绝对路径。'
                : `格式：${configData?.configFormat || editingTool?.configFormat || 'text'}；保存时会检查文件是否被其他进程修改。`}
            />
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
