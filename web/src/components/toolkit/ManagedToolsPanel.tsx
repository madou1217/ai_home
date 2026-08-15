import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Input, Modal, Space, Spin, Tag, Typography, message } from 'antd';
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

const { Text } = Typography;

interface ManagedToolsPanelProps {
  category: ToolkitToolCategoryId;
}

function requestError(error: any, fallback: string) {
  return error?.response?.data?.message || error?.response?.data?.error || error?.message || fallback;
}

export default function ManagedToolsPanel({ category }: ManagedToolsPanelProps) {
  const [data, setData] = useState<ManagedToolsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [editingTool, setEditingTool] = useState<ManagedToolItem | null>(null);
  const [configData, setConfigData] = useState<ToolkitToolConfigResponse | null>(null);
  const [configContent, setConfigContent] = useState('');
  const [configLoading, setConfigLoading] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);

  const fetchTools = useCallback(async () => {
    setLoading(true);
    try {
      const result = await toolkitAPI.listTools();
      if (result.ok) setData(result);
    } catch (error: any) {
      message.error(requestError(error, '获取工具状态失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTools();
  }, [fetchTools]);

  const tools = useMemo(
    () => (data?.tools || []).filter((tool) => tool.category === category),
    [category, data]
  );
  const categoryInfo = data?.categories.find((item) => item.id === category);

  const openConfig = async (tool: ManagedToolItem) => {
    setEditingTool(tool);
    setConfigData(null);
    setConfigContent('');
    setConfigLoading(true);
    try {
      const result = await toolkitAPI.getToolConfig(tool.id);
      setConfigData(result);
      setConfigContent(result.content || '');
    } catch (error: any) {
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
      const result = await toolkitAPI.saveToolConfig(editingTool.id, configContent, configData.revision);
      setConfigData(result);
      message.success(result.elevated ? '配置已通过系统授权保存' : '配置已保存');
      fetchTools();
    } catch (error: any) {
      message.error(requestError(error, '保存工具配置失败'));
    } finally {
      setSavingConfig(false);
    }
  };

  return (
    <div className="toolkit-page">
      <div className="toolkit-category-intro">
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>{categoryInfo?.label || category}</Typography.Title>
          <Text type="secondary">{categoryInfo?.description || '检测当前平台支持的工具。'}</Text>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={fetchTools}>刷新</Button>
      </div>

      {loading && !data ? (
        <div style={{ textAlign: 'center', padding: '60px 0' }}><Spin size="large" /></div>
      ) : (
        <div className="toolkit-grid">
          {tools.map((tool) => (
            <div key={tool.id} className={`toolkit-app-card ${tool.installed ? 'installed' : 'uninstalled'}`}>
              <div>
                <div className="toolkit-card-header">
                  <div className="toolkit-card-title-group">
                    <ToolOutlined style={{ fontSize: 26, color: tool.installed ? '#1677ff' : '#9ca3af' }} />
                    <div>
                      <h3 className="toolkit-card-title">{tool.name}</h3>
                      <Space size={4} style={{ marginTop: 2 }}>
                        <Tag color={tool.supported ? 'blue' : 'default'}>{tool.supported ? '当前平台支持' : '当前平台不适用'}</Tag>
                        {tool.installed && <Tag color="success"><CheckCircleOutlined /> 已检测</Tag>}
                      </Space>
                    </div>
                  </div>
                </div>
                <div className="toolkit-card-body">
                  <div className="toolkit-detail-row"><span className="toolkit-detail-label">作用:</span><span className="toolkit-detail-value">{tool.role}</span></div>
                  <div className="toolkit-detail-row"><span className="toolkit-detail-label">版本:</span><span className="toolkit-detail-value">{tool.version}</span></div>
                  <div className="toolkit-detail-row"><span className="toolkit-detail-label">程序:</span><span className="toolkit-detail-value">{tool.binaryName}</span></div>
                  <div className="toolkit-detail-row"><span className="toolkit-detail-label">服务:</span><span className="toolkit-detail-value">{tool.serviceManager}</span></div>
                  {tool.configName && (
                    <div className="toolkit-detail-row">
                      <span className="toolkit-detail-label">配置:</span>
                      <span className="toolkit-detail-value">
                        {tool.configExists ? `${tool.configName} 已存在` : `${tool.configName} 待创建`}
                      </span>
                    </div>
                  )}
                </div>
              </div>
              <div className="toolkit-card-actions">
                <Space size={8}>
                  {tool.configEditable && (
                    <Button size="small" icon={<EditOutlined />} onClick={() => openConfig(tool)}>编辑配置</Button>
                  )}
                  {tool.requiresElevation && tool.configEditable && <Badge status="warning" text="保存需授权" />}
                </Space>
                <Text type="secondary" style={{ fontSize: 11 }}>{tool.capabilities.join(' · ')}</Text>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={Boolean(editingTool)}
        title={editingTool ? `编辑 ${editingTool.name} 配置` : '编辑配置'}
        width={900}
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
          <div style={{ textAlign: 'center', padding: '48px 0' }}><Spin /></div>
        ) : (
          <>
            <Alert
              type="warning"
              showIcon
              icon={<LockOutlined />}
              message="配置可能包含令牌或其他敏感信息"
              description={configData?.requiresElevation
                ? '当前配置需要系统授权才能保存；不会在页面或接口中显示绝对路径。'
                : `格式：${configData?.configFormat || editingTool?.configFormat || 'text'}；保存时会检查文件是否被其他进程修改。`}
              style={{ marginBottom: 12 }}
            />
            <Input.TextArea
              value={configContent}
              onChange={(event) => setConfigContent(event.target.value)}
              autoSize={{ minRows: 18, maxRows: 36 }}
              spellCheck={false}
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 }}
              placeholder="配置文件为空，可直接输入内容后保存"
            />
          </>
        )}
      </Modal>
    </div>
  );
}
