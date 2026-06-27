import React, { useState, useEffect } from 'react';
import { Table, Button, Form, Input, Modal, Tag, Alert, Space, Popconfirm, Select, Breadcrumb, message, Radio, Tabs } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, CheckCircleOutlined, ExclamationCircleOutlined, CloseCircleOutlined, LoadingOutlined, FolderOpenOutlined, RightOutlined } from '@ant-design/icons';
import { sshHostsAPI } from '@/services/api';
import type { SshHostTestResult } from '@/types';

// 密码掩码常量
const PASSWORD_MASK = '******';

interface SshConnection {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  authType: 'key' | 'password' | 'agent';
  privateKey?: string;
  password?: string;
  createdAt: number;
}

interface SshWorkspace {
  id: string;
  connectionId: string;
  label: string;
  remoteRoot: string;
  createdAt: number;
}

interface RemoteDirItem {
  name: string;
  path: string;
}

export default function SshHostsPanel({ setActions }: { setActions?: (actions: React.ReactNode) => void }) {
  // ------------------------------------------
  // 1. 数据状态声明
  // ------------------------------------------
  const [connections, setConnections] = useState<SshConnection[]>([]);
  const [activeTab, setActiveTab] = useState<'connections' | 'workspaces'>('connections');
  const [filterConnectionId, setFilterConnectionId] = useState<string>('');
  const [workspaces, setWorkspaces] = useState<SshWorkspace[]>([]);
  const [loadingConns, setLoadingConns] = useState(false);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);

  // Connection 弹窗状态
  const [connModalVisible, setConnModalVisible] = useState(false);
  const [editingConn, setEditingConn] = useState<SshConnection | null>(null);
  const [connForm] = Form.useForm();
  const [authType, setAuthType] = useState<'key' | 'password' | 'agent'>('agent');

  // Workspace 弹窗状态
  const [wsModalVisible, setWsModalVisible] = useState(false);
  const [editingWs, setEditingWs] = useState<SshWorkspace | null>(null);
  const [wsForm] = Form.useForm();
  const [selectedConnIdInForm, setSelectedConnIdInForm] = useState<string>('');

  // 连通性测试状态存储：key 为 connection.id，value 为测试中 (loading) 或测试结果 (result)
  const [testStates, setTestStates] = useState<Record<string, { loading: boolean; result?: SshHostTestResult }>>({});
  
  useEffect(() => {
    if (setActions) {
      setActions(
        <Space size={8} wrap>
          <Button
            icon={<PlusOutlined />}
            onClick={() => showConnModal()}
          >
            添加连接
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => showWsModal()}
            disabled={connections.length === 0}
          >
            创建工作空间
          </Button>
        </Space>
      );
    }
  }, [setActions, connections.length]);

  useEffect(() => {
    return () => {
      setActions?.(null);
    };
  }, [setActions]);
  const [expandedRowKeys, setExpandedRowKeys] = useState<React.Key[]>([]);

  // 远程目录浏览器状态
  const [dirModalVisible, setDirModalVisible] = useState(false);
  const [dirBrowserConnId, setDirBrowserConnId] = useState<string>('');
  const [currentPath, setCurrentPath] = useState<string>('');
  const [parentPath, setParentPath] = useState<string>('');
  const [dirList, setDirList] = useState<RemoteDirItem[]>([]);
  const [loadingDirs, setLoadingDirs] = useState(false);
  const [selectedDirPath, setSelectedDirPath] = useState<string>('');

  // ------------------------------------------
  // 2. 数据获取
  // ------------------------------------------
  const fetchConnections = async () => {
    setLoadingConns(true);
    try {
      const data = await sshHostsAPI.listConnections() as any;
      setConnections(data || []);
    } catch (err: any) {
      message.error(`加载远程连接失败: ${err.message || '未知错误'}`);
    } finally {
      setLoadingConns(false);
    }
  };

  const fetchWorkspaces = async () => {
    setLoadingWorkspaces(true);
    try {
      const data = await sshHostsAPI.listWorkspaces() as any;
      setWorkspaces(data || []);
    } catch (err: any) {
      message.error(`加载工作空间失败: ${err.message || '未知错误'}`);
    } finally {
      setLoadingWorkspaces(false);
    }
  };

  useEffect(() => {
    fetchConnections();
    fetchWorkspaces();
  }, []);

  // ------------------------------------------
  // 3. Connection 物理连接管理逻辑
  // ------------------------------------------
  const showConnModal = (conn?: SshConnection) => {
    if (conn) {
      setEditingConn(conn);
      setAuthType(conn.authType);
      connForm.setFieldsValue({
        label: conn.label,
        host: conn.host,
        port: conn.port,
        user: conn.user,
        authType: conn.authType,
        password: conn.password || (conn.authType === 'password' ? PASSWORD_MASK : ''),
        privateKey: conn.privateKey || (conn.authType === 'key' ? PASSWORD_MASK : '')
      });
    } else {
      setEditingConn(null);
      setAuthType('agent');
      connForm.resetFields();
      connForm.setFieldsValue({ port: 22, authType: 'agent' });
    }
    setConnModalVisible(true);
  };

  const handleSaveConn = async () => {
    try {
      const values = await connForm.validateFields();
      if (editingConn) {
        await sshHostsAPI.updateConnection(editingConn.id, values);
        message.success('更新远程连接配置成功');
      } else {
        await sshHostsAPI.createConnection(values);
        message.success('添加远程连接成功');
      }
      setConnModalVisible(false);
      fetchConnections();
    } catch (err: any) {
      if (err.errorFields) return;
      message.error(`保存失败: ${err.message || '未知错误'}`);
    }
  };

  const handleDeleteConn = async (id: string) => {
    try {
      await sshHostsAPI.deleteConnection(id);
      message.success('删除连接成功');
      fetchConnections();
      fetchWorkspaces(); // 级联删除，同时刷新工作空间
    } catch (err: any) {
      message.error(`删除失败: ${err.message || '未知错误'}`);
    }
  };

  const handleTestConnection = async (conn: SshConnection) => {
    setTestStates(prev => ({ ...prev, [conn.id]: { loading: true } }));
    if (!expandedRowKeys.includes(conn.id)) {
      setExpandedRowKeys(prev => [...prev, conn.id]);
    }

    try {
      const result = await sshHostsAPI.testConnection({
        connectionId: conn.id,
        host: conn.host,
        port: conn.port,
        user: conn.user,
        authType: conn.authType,
        password: PASSWORD_MASK,
        privateKey: PASSWORD_MASK,
        timeoutMs: 5000
      }) as any;

      setTestStates(prev => ({
        ...prev,
        [conn.id]: { loading: false, result }
      }));
    } catch (err: any) {
      setTestStates(prev => ({
        ...prev,
        [conn.id]: {
          loading: false,
          result: {
            status: 'unreachable',
            target: conn.host,
            stderr: err.message || '连接超时，无法建立 SSH 连接。'
          }
        }
      }));
    }
  };

  const renderStatusTag = (state?: { loading: boolean; result?: SshHostTestResult }) => {
    if (!state) return <Tag color="default">未测试</Tag>;
    if (state.loading) return <Tag color="processing" icon={<LoadingOutlined />}>测试中...</Tag>;

    const result = state.result;
    if (result?.status === 'reachable') {
      return <Tag color="green" icon={<CheckCircleOutlined />}>已连接</Tag>;
    }
    if (result?.status === 'auth-required') {
      return <Tag color="gold" icon={<ExclamationCircleOutlined />}>连接受阻 (缺少Key/密码)</Tag>;
    }
    return <Tag color="red" icon={<CloseCircleOutlined />}>连接失败</Tag>;
  };

  // ------------------------------------------
  // 4. Workspace 工作空间管理逻辑
  // ------------------------------------------
  const showWsModal = (ws?: SshWorkspace) => {
    if (ws) {
      setEditingWs(ws);
      setSelectedConnIdInForm(ws.connectionId);
      wsForm.setFieldsValue({
        connectionId: ws.connectionId,
        label: ws.label,
        remoteRoot: ws.remoteRoot
      });
    } else {
      setEditingWs(null);
      setSelectedConnIdInForm('');
      wsForm.resetFields();
      if (connections.length > 0) {
        wsForm.setFieldsValue({ connectionId: connections[0].id });
        setSelectedConnIdInForm(connections[0].id);
      }
    }
    setWsModalVisible(true);
  };

  const handleSaveWs = async () => {
    try {
      const values = await wsForm.validateFields();
      if (editingWs) {
        await sshHostsAPI.updateWorkspace(editingWs.id, values);
        message.success('更新工作空间配置成功');
      } else {
        await sshHostsAPI.createWorkspace(values);
        message.success('工作空间创建成功');
      }
      setWsModalVisible(false);
      fetchWorkspaces();
    } catch (err: any) {
      if (err.errorFields) return;
      message.error(`保存工作区失败: ${err.message || '未知错误'}`);
    }
  };

  const handleDeleteWs = async (id: string) => {
    try {
      await sshHostsAPI.deleteWorkspace(id);
      message.success('工作空间已移除 (远端磁盘数据未受影响)');
      fetchWorkspaces();
    } catch (err: any) {
      message.error(`移除失败: ${err.message || '未知错误'}`);
    }
  };

  // ------------------------------------------
  // 5. 远程目录浏览器逻辑
  // ------------------------------------------
  const openDirectoryBrowser = () => {
    if (!selectedConnIdInForm) {
      message.warning('请先选择一个远程 SSH 连接');
      return;
    }
    setDirBrowserConnId(selectedConnIdInForm);
    setSelectedDirPath('');
    setCurrentPath('');
    setDirList([]);
    setDirModalVisible(true);
    loadRemoteDirectory(selectedConnIdInForm, '');
  };

  const loadRemoteDirectory = async (connectionId: string, subDir: string) => {
    setLoadingDirs(true);
    try {
      const res = await sshHostsAPI.browseSshDirectory({ connectionId, subDir });
      if (res.ok) {
        setCurrentPath(res.currentDir);
        setParentPath(res.parentDir);
        setDirList(res.directories || []);
        setSelectedDirPath(res.currentDir);
      } else {
        message.error(res.message || '加载远程目录失败');
      }
    } catch (err: any) {
      message.error(`远程执行失败: ${err.message || '无法建立 SSH 连接，请先在下方测试该连接。'}`);
      setDirModalVisible(false);
    } finally {
      setLoadingDirs(false);
    }
  };

  const handleConfirmDirectory = () => {
    if (!selectedDirPath) {
      message.warning('请选择一个目录');
      return;
    }
    wsForm.setFieldsValue({ remoteRoot: selectedDirPath });
    setDirModalVisible(false);
  };

  // 构造面包屑
  const renderBreadcrumbs = () => {
    if (!currentPath) return null;
    const parts = currentPath.split('/').filter(Boolean);
    const breadcrumbItems = [];

    // 根目录项
    breadcrumbItems.push(
      <Breadcrumb.Item key="root" onClick={() => loadRemoteDirectory(dirBrowserConnId, '/')}>
        <span style={{ cursor: 'pointer', color: '#1890ff' }}>[Root]</span>
      </Breadcrumb.Item>
    );

    let pathAccumulator = '';
    parts.forEach((part, index) => {
      pathAccumulator += `/${part}`;
      const targetPath = pathAccumulator;
      const isLast = index === parts.length - 1;
      breadcrumbItems.push(
        <Breadcrumb.Item key={index} onClick={isLast ? undefined : () => loadRemoteDirectory(dirBrowserConnId, targetPath)}>
          <span style={isLast ? { fontWeight: 'bold' } : { cursor: 'pointer', color: '#1890ff' }}>
            {part}
          </span>
        </Breadcrumb.Item>
      );
    });

    return (
      <Breadcrumb
        separator={<RightOutlined style={{ fontSize: '10px', color: '#bfbfbf' }} />}
        style={{ marginBottom: '16px', background: '#f5f5f5', padding: '8px 12px', borderRadius: '4px' }}
      >
        {breadcrumbItems}
      </Breadcrumb>
    );
  };

  // ------------------------------------------
  // 6. UI 渲染与 Columns 定义
  // ------------------------------------------

  // SSH Connection columns
  const connColumns = [
    {
      title: '连接名称',
      dataIndex: 'label',
      key: 'label',
      render: (text: string) => <strong>{text}</strong>
    },
    {
      title: '目标地址',
      key: 'destination',
      render: (_: any, record: SshConnection) => (
        <code>{record.user ? `${record.user}@${record.host}:${record.port}` : `${record.host}:${record.port}`}</code>
      )
    },
    {
      title: '认证方式',
      dataIndex: 'authType',
      key: 'authType',
      render: (text: string) => <Tag color={text === 'key' ? 'blue' : text === 'password' ? 'orange' : 'purple'}>{text.toUpperCase()}</Tag>
    },
    {
      title: '连接状态',
      key: 'status',
      width: 140,
      render: (_: any, record: SshConnection) => renderStatusTag(testStates[record.id])
    },
    {
      title: '操作',
      key: 'actions',
      width: 320,
      render: (_: any, record: SshConnection) => (
        <Space size="middle">
          <Button
            size="small"
            onClick={() => handleTestConnection(record)}
            loading={testStates[record.id]?.loading}
          >
            测试连接
          </Button>
          <Button
            size="small"
            onClick={() => {
              setFilterConnectionId(record.id);
              setActiveTab('workspaces');
            }}
          >
            查看工作区
          </Button>
          <Button
            size="small"
            onClick={() => {
              showWsModal();
              setTimeout(() => {
                wsForm.setFieldsValue({ connectionId: record.id });
                setSelectedConnIdInForm(record.id);
              }, 50);
            }}
          >
            快捷建工作区
          </Button>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => showConnModal(record)}
          >
            编辑
          </Button>
          <Popconfirm
            title="将同步删除关联该连接的所有工作空间！确认删除？"
            onConfirm={() => handleDeleteConn(record.id)}
            okText="确认"
            cancelText="取消"
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  // SSH Workspace columns
  const wsColumns = [
    {
      title: '项目空间名',
      dataIndex: 'label',
      key: 'label',
      render: (text: string) => <strong>{text}</strong>
    },
    {
      title: '关联连接',
      dataIndex: 'connectionId',
      key: 'connectionId',
      render: (connId: string) => {
        const conn = connections.find(c => c.id === connId);
        return conn ? <span>{conn.label} (<code>{conn.host}</code>)</span> : <span style={{ color: '#d9d9d9' }}>连接已删除</span>;
      }
    },
    {
      title: '远端工作区路径',
      dataIndex: 'remoteRoot',
      key: 'remoteRoot',
      render: (text: string) => <code>{text}</code>
    },
    {
      title: '操作',
      key: 'actions',
      width: 180,
      render: (_: any, record: SshWorkspace) => (
        <Space size="middle">
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => showWsModal(record)}
          >
            编辑
          </Button>
          <Popconfirm
            title="仅在数据库中删除此空间，不会影响远程服务器的物理文件。确认移除？"
            onConfirm={() => handleDeleteWs(record.id)}
            okText="确认"
            cancelText="取消"
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              移除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  // 展开连接行渲染诊断结果
  const connExpandedRowRender = (record: SshConnection) => {
    const state = testStates[record.id];
    if (!state) return <p style={{ margin: 0, color: '#8c8c8c' }}>点击右侧的“测试连接”按钮以获取远程服务器环境诊断结果。</p>;
    if (state.loading) return <p style={{ margin: 0 }}><LoadingOutlined /> 正在通过 SSH 连通通道获取远程系统和 NodeJS/Git 等依赖状态，请稍后...</p>;

    const result = state.result;
    if (!result) return null;

    return (
      <div className="ssh-host-diagnostic-detail" style={{ padding: '8px 16px', background: '#fafafa', borderRadius: '4px' }}>
        <h4 style={{ margin: '0 0 12px 0', fontSize: '14px' }}>系统诊断与依赖项测试结果：</h4>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {result.status === 'reachable' && (
            <Alert
              message="SSH 连通成功"
              description={`已成功建立连接。远程主机IP: ${result.target}。`}
              type="success"
              showIcon
            />
          )}
          {result.status === 'auth-required' && (
            <Alert
              message="地址可达但拒绝访问"
              description="连接无法通过免密认证。请检查你在当前连接中配置的私钥内容或密码是否正确。若使用 ssh-agent，请确保本地 ssh-agent 正常代理了对应密钥。"
              type="warning"
              showIcon
            />
          )}
          {result.status === 'unreachable' && (
            <Alert
              message="连接失败"
              description={result.stderr || "网络不可达，请检查 IP 端口是否开通，或者 SSHD 服务是否启动。"}
              type="error"
              showIcon
            />
          )}

          {result.status === 'reachable' && (
            <div className="diagnostic-dependencies" style={{ background: '#fff', padding: '12px', border: '1px solid #f0f0f0', borderRadius: '4px' }}>
              <div style={{ marginBottom: '8px' }}>
                <strong style={{ marginRight: '8px' }}>系统类型:</strong>
                <Tag color="blue">{result.platform || '未知'}</Tag>
                <strong style={{ marginRight: '8px', marginLeft: '16px' }}>架构:</strong>
                <Tag color="cyan">{result.arch || '未知'}</Tag>
              </div>
              <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '12px' }}>
                <div>
                  <span style={{ marginRight: '6px' }}>Node.js:</span>
                  <Tag color={result.commands?.node ? 'green' : 'red'}>{result.commands?.node ? 'Installed' : 'Missing'}</Tag>
                </div>
                <div>
                  <span style={{ marginRight: '6px' }}>Npm:</span>
                  <Tag color={result.commands?.npm ? 'green' : 'red'}>{result.commands?.npm ? 'Installed' : 'Missing'}</Tag>
                </div>
                <div>
                  <span style={{ marginRight: '6px' }}>Git:</span>
                  <Tag color={result.commands?.git ? 'green' : 'red'}>{result.commands?.git ? 'Installed' : 'Missing'}</Tag>
                </div>
                <div>
                  <span style={{ marginRight: '6px' }}>AIH Agent:</span>
                  <Tag color={result.commands?.aih ? 'green' : 'orange'}>{result.commands?.aih ? 'Installed' : 'Not Required (0-install mode)'}</Tag>
                </div>
              </div>
              {result.recommendation && (
                <div style={{ marginTop: '12px', color: '#595959', fontSize: '13px' }}>
                  <strong>诊断建议:</strong> {result.recommendation}
                </div>
              )}
            </div>
          )}
        </Space>
      </div>
    );
  };

  const filteredWorkspaces = filterConnectionId 
    ? workspaces.filter(w => w.connectionId === filterConnectionId)
    : workspaces;

  return (
    <div className="ssh-hosts-management-wrapper animate__animated animate__fadeIn animate__faster">
      <section className="settings-panel">
        <div className="settings-remote-nodes-stats">
          <span>
            <strong>{connections.length}</strong>
            远程连接
          </span>
          <span>
            <strong style={{ color: 'var(--c-success-600)' }}>
              {Object.values(testStates).filter(s => s.result?.status === 'reachable').length}
            </strong>
            在线连接
          </span>
          <span>
            <strong>{workspaces.length}</strong>
            项目工作空间
          </span>
        </div>

        <Tabs
          activeKey={activeTab}
          onChange={(key: string) => setActiveTab(key as any)}
          className="settings-control-plane-manage-tabs"
          items={[
            {
              key: 'connections',
              label: '远程连接',
              children: (
                <Table
                  dataSource={connections}
                  columns={connColumns}
                  rowKey="id"
                  loading={loadingConns}
                  pagination={{ pageSize: 8 }}
                  expandable={{
                    expandedRowRender: connExpandedRowRender,
                    expandedRowKeys,
                    onExpandedRowsChange: (keys) => setExpandedRowKeys(keys as React.Key[])
                  }}
                />
              )
            },
            {
              key: 'workspaces',
              label: '项目工作空间',
              children: (
                <>
                  {filterConnectionId && (
                    <Alert
                      message={
                        <span>
                          当前正在筛选连接 <strong>{connections.find(c => c.id === filterConnectionId)?.label || '已未知'}</strong> 的工作空间。
                          <Button type="link" size="small" onClick={() => setFilterConnectionId('')} style={{ padding: '0 4px' }}>
                            清除筛选
                          </Button>
                        </span>
                      }
                      type="info"
                      showIcon
                      style={{ marginBottom: 12 }}
                    />
                  )}
                  <Table
                    dataSource={filteredWorkspaces}
                    columns={wsColumns}
                    rowKey="id"
                    loading={loadingWorkspaces}
                    pagination={{ pageSize: 8 }}
                  />
                </>
              )
            }
          ]}
        />
      </section>

      {/* ==========================================
          三、 Connection 添加/编辑 Modal
          ========================================== */}
      <Modal
        title={editingConn ? '编辑远程连接' : '添加远程连接'}
        open={connModalVisible}
        onOk={handleSaveConn}
        onCancel={() => setConnModalVisible(false)}
        okText="保存"
        cancelText="取消"
        destroyOnClose
        width={600}
      >
        <Form
          form={connForm}
          layout="vertical"
          style={{ marginTop: '16px' }}
        >
          <Form.Item
            name="label"
            label="连接名称 (Label)"
            rules={[{ required: true, message: '请输入显示名称，例如: 阿里云开发服务器' }]}
          >
            <Input placeholder="例如: Aliyun-Box" />
          </Form.Item>

          <Space style={{ display: 'flex', width: '100%' }} size="middle">
            <Form.Item
              name="host"
              label="主机名 / IP (Host)"
              rules={[{ required: true, message: '请输入主机名或IP' }]}
              style={{ width: '380px' }}
            >
              <Input placeholder="例如: 192.168.1.120" />
            </Form.Item>

            <Form.Item
              name="port"
              label="端口 (Port)"
              rules={[{ required: true, message: '请输入端口' }]}
              style={{ width: '140px' }}
            >
              <Input placeholder="22" type="number" />
            </Form.Item>
          </Space>

          <Form.Item
            name="user"
            label="用户名 (User)"
            rules={[{ required: true, message: '请输入连接用户名' }]}
          >
            <Input placeholder="例如: root 或 ubuntu" />
          </Form.Item>

          <Form.Item
            name="authType"
            label="认证方式"
            rules={[{ required: true }]}
          >
            <Radio.Group onChange={(e) => setAuthType(e.target.value)}>
              <Radio.Button value="agent">SSH Agent 免密</Radio.Button>
              <Radio.Button value="key">私钥 Key 证书</Radio.Button>
              <Radio.Button value="password">账户密码</Radio.Button>
            </Radio.Group>
          </Form.Item>

          {authType === 'key' && (
            <Form.Item
              name="privateKey"
              label="私钥内容 (Private Key)"
              rules={[{ required: true, message: '请粘贴 SSH 私钥 (PEM/OpenSSH格式)' }]}
            >
              <Input.TextArea
                rows={6}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----\n..."
                style={{ fontFamily: 'monospace' }}
              />
            </Form.Item>
          )}

          {authType === 'password' && (
            <Form.Item
              name="password"
              label="连接密码 (Password)"
              rules={[{ required: true, message: '请输入远程账户连接密码' }]}
            >
              <Input.Password placeholder="密码" />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* ==========================================
          四、 Workspace 添加/编辑 Modal
          ========================================== */}
      <Modal
        title={editingWs ? '编辑项目工作空间' : '创建远程项目工作空间'}
        open={wsModalVisible}
        onOk={handleSaveWs}
        onCancel={() => setWsModalVisible(false)}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form
          form={wsForm}
          layout="vertical"
          style={{ marginTop: '16px' }}
        >
          <Form.Item
            name="connectionId"
            label="关联物理连接 (SSH Connection)"
            rules={[{ required: true, message: '请选择一个有效的远程 SSH 连接' }]}
          >
            <Select
              options={connections.map(c => ({ label: `${c.label} (${c.user}@${c.host})`, value: c.id }))}
              onChange={(value) => setSelectedConnIdInForm(value)}
            />
          </Form.Item>

          <Form.Item
            name="label"
            label="项目空间名称 (Label)"
            rules={[{ required: true, message: '请输入该项目空间在 Web 上的名称' }]}
          >
            <Input placeholder="例如: 订单微服务项目" />
          </Form.Item>

          <Form.Item label="远端绝对路径 (RemoteRoot)" required>
            <Space style={{ display: 'flex', width: '100%' }}>
              <Form.Item
                name="remoteRoot"
                noStyle
                rules={[{ required: true, message: '请选择远程项目绝对路径' }]}
              >
                <Input
                  placeholder="不准手填，请点击右侧选择目录"
                  readOnly
                  style={{ width: '360px', background: '#f5f5f5', color: '#595959' }}
                />
              </Form.Item>
              <Button
                icon={<FolderOpenOutlined />}
                onClick={openDirectoryBrowser}
              >
                选择目录
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* ==========================================
          五、 远程目录浏览器 Modal
          ========================================== */}
      <Modal
        title="远程工作目录浏览器"
        open={dirModalVisible}
        onOk={handleConfirmDirectory}
        onCancel={() => setDirModalVisible(false)}
        okText="确认选择该路径"
        cancelText="取消"
        width={700}
      >
        <div style={{ marginTop: '16px' }}>
          {/* 1. 面包屑路径层级 */}
          {renderBreadcrumbs()}

          {/* 2. 目录详细列表 */}
          <div
            className="directory-list-container"
            style={{
              border: '1px solid #d9d9d9',
              borderRadius: '4px',
              height: '350px',
              overflowY: 'auto',
              background: '#fff'
            }}
          >
            {loadingDirs ? (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', flexDirection: 'column', gap: '12px' }}>
                <LoadingOutlined style={{ fontSize: '24px' }} />
                <span>正在获取远程目录列表，请稍后...</span>
              </div>
            ) : (
              <div style={{ padding: '8px 0' }}>
                {parentPath && currentPath !== '/' && (
                  <div
                    className="dir-item"
                    style={{
                      padding: '8px 16px',
                      cursor: 'pointer',
                      background: '#fcfcfc',
                      borderBottom: '1px solid #f0f0f0',
                      userSelect: 'none'
                    }}
                    onDoubleClick={() => loadRemoteDirectory(dirBrowserConnId, parentPath)}
                  >
                    <FolderOpenOutlined style={{ marginRight: '8px', color: '#faad14' }} />
                    <strong style={{ color: '#1890ff' }}>.. (返回上级目录)</strong>
                  </div>
                )}

                {dirList.length === 0 ? (
                  <div style={{ padding: '40px 0', textAlign: 'center', color: '#bfbfbf' }}>
                    没有子目录。双击上级目录可返回。
                  </div>
                ) : (
                  dirList.map(dir => {
                    const isSelected = selectedDirPath === dir.path;
                    return (
                      <div
                        key={dir.path}
                        className="dir-item"
                        style={{
                          padding: '8px 16px',
                          cursor: 'pointer',
                          background: isSelected ? '#e6f7ff' : '#fff',
                          borderBottom: '1px solid #f5f5f5',
                          userSelect: 'none'
                        }}
                        onClick={() => setSelectedDirPath(dir.path)}
                        onDoubleClick={() => loadRemoteDirectory(dirBrowserConnId, dir.path)}
                      >
                        <FolderOpenOutlined style={{ marginRight: '8px', color: '#faad14' }} />
                        <span>{dir.name}</span>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* 3. 选定路径显示 */}
          <div style={{ marginTop: '16px' }}>
            <span style={{ marginRight: '8px', fontWeight: 'bold' }}>当前选定路径:</span>
            <code style={{ background: '#f5f5f5', padding: '4px 8px', borderRadius: '4px', fontSize: '13px' }}>
              {selectedDirPath || '未选择'}
            </code>
          </div>
        </div>
      </Modal>
    </div>
  );
}
