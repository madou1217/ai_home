import React, { useState, useEffect } from 'react';
import { Form, Input, Modal, Tag, Alert, Space, Select, Breadcrumb, message, Radio, Tabs, Drawer } from 'antd';
import { ModalForm } from '@ant-design/pro-components';
import Button from '@/components/ui/AppButton';
import { SshConnectionCardList, SshWorkspaceCardList } from '@/components/settings/SshHostCardLists';
import type { SshConnection, SshWorkspace } from '@/components/settings/SshHostCardLists';
import { PlusOutlined, LoadingOutlined, FolderOpenOutlined, RightOutlined } from '@ant-design/icons';
import { sshHostsAPI } from '@/services/api';
import type { SshHostTestResult } from '@/types';

// 密码掩码常量
const PASSWORD_MASK = '******';

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
  const [diagnosticDrawerVisible, setDiagnosticDrawerVisible] = useState(false);
  const [activeDiagnosticConn, setActiveDiagnosticConn] = useState<SshConnection | null>(null);
  const [workspaces, setWorkspaces] = useState<SshWorkspace[]>([]);
  const [loadingConns, setLoadingConns] = useState(false);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);

  // Connection 弹窗状态
  const [connModalVisible, setConnModalVisible] = useState(false);
  const [editingConn, setEditingConn] = useState<SshConnection | null>(null);
  const [connForm] = Form.useForm();
  const [authType, setAuthType] = useState<'key' | 'key-file' | 'password' | 'agent'>('agent');

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
        identityFile: conn.identityFile || '',
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

  const handleSaveConn = async (values: any): Promise<boolean> => {
    try {
      if (editingConn) {
        await sshHostsAPI.updateConnection(editingConn.id, values);
        message.success('更新远程连接配置成功');
      } else {
        await sshHostsAPI.createConnection(values);
        message.success('添加远程连接成功');
      }
      await fetchConnections();
      return true;
    } catch (err: any) {
      message.error(`保存失败: ${err?.response?.data?.message || err?.message || '未知错误'}`);
      return false;
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
    setActiveDiagnosticConn(conn);
    setDiagnosticDrawerVisible(true);
    setTestStates(prev => ({ ...prev, [conn.id]: { loading: true } }));

    try {
      const result = await sshHostsAPI.testConnection({
        connectionId: conn.id,
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
            stderr: err?.response?.data?.message || err.message || '连接超时，无法建立 SSH 连接。'
          }
        }
      }));
    }
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

  const handleSaveWs = async (values: any): Promise<boolean> => {
    try {
      if (editingWs) {
        await sshHostsAPI.updateWorkspace(editingWs.id, values);
        message.success('更新工作空间配置成功');
      } else {
        await sshHostsAPI.createWorkspace(values);
        message.success('工作空间创建成功');
      }
      await fetchWorkspaces();
      return true;
    } catch (err: any) {
      message.error(`保存工作区失败: ${err?.response?.data?.message || err?.message || '未知错误'}`);
      return false;
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
      message.error(`远程执行失败: ${err?.response?.data?.message || err.message || '无法建立 SSH 连接，请先在下方测试该连接。'}`);
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
        <span style={{ cursor: 'pointer', color: 'var(--color-info)' }}>[Root]</span>
      </Breadcrumb.Item>
    );

    let pathAccumulator = '';
    parts.forEach((part, index) => {
      pathAccumulator += `/${part}`;
      const targetPath = pathAccumulator;
      const isLast = index === parts.length - 1;
      breadcrumbItems.push(
        <Breadcrumb.Item key={index} onClick={isLast ? undefined : () => loadRemoteDirectory(dirBrowserConnId, targetPath)}>
          <span style={isLast ? { fontWeight: 'bold' } : { cursor: 'pointer', color: 'var(--color-info)' }}>
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

  const renderDiagnosticDrawerContent = () => {
    if (!activeDiagnosticConn) return null;
    const state = testStates[activeDiagnosticConn.id];
    if (!state) return <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--app-muted)' }}>等待测试连接...</div>;
    if (state.loading) return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', flexDirection: 'column', gap: 12 }}>
        <LoadingOutlined style={{ fontSize: 24, color: 'var(--app-primary)' }} />
        <span style={{ color: 'var(--app-muted)', fontSize: 13 }}>正在连接远程主机并执行依赖诊断，请稍后...</span>
      </div>
    );

    const result = state.result;
    if (!result) return null;
    const targetLabel = result.target || `${activeDiagnosticConn.user ? `${activeDiagnosticConn.user}@` : ''}${activeDiagnosticConn.host}`;

    return (
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        {result.status === 'reachable' && (
          <Alert
            message="SSH 连通成功"
            description={`已成功建立连接。远程主机: ${targetLabel}。`}
            type="success"
            showIcon
          />
        )}
        {result.status === 'auth-required' && (
          <Alert
            message="拒绝访问 (认证未通过)"
            description="主机可达，但 SSH 认证失败。请检查当前连接配置的私钥文件路径、私钥内容或密码；使用 SSH Agent 时，请确认当前 AIH Server 运行用户的 ssh-agent 已加载对应密钥。"
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
          <div style={{ background: 'var(--app-surface-muted)', padding: '16px', borderRadius: '8px', border: '1px solid var(--app-border)' }}>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: 'var(--app-muted)', marginBottom: 4 }}>系统平台 / 架构</div>
              <Space size={6}>
                <Tag color="blue">{result.platform || '未知'}</Tag>
                <Tag color="cyan">{result.arch || '未知'}</Tag>
              </Space>
            </div>

            <div>
              <div style={{ fontSize: 12, color: 'var(--app-muted)', marginBottom: 8 }}>依赖项检测</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Node.js</span>
                  <Tag color={result.commands?.node ? 'green' : 'red'}>{result.commands?.node ? '已安装' : '未检测到'}</Tag>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Npm</span>
                  <Tag color={result.commands?.npm ? 'green' : 'red'}>{result.commands?.npm ? '已安装' : '未检测到'}</Tag>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Git</span>
                  <Tag color={result.commands?.git ? 'green' : 'red'}>{result.commands?.git ? '已安装' : '未检测到'}</Tag>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>AIH Agent</span>
                  <Tag color={result.commands?.aih ? 'green' : 'orange'}>{result.commands?.aih ? '已配置' : '免装模式'}</Tag>
                </div>
              </div>
            </div>

            {result.recommendation && (
              <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--app-border)' }}>
                <div style={{ fontSize: 12, color: 'var(--app-muted)', marginBottom: 4 }}>诊断建议</div>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--app-text)', lineHeight: 1.5 }}>{result.recommendation}</p>
              </div>
            )}
          </div>
        )}
      </Space>
    );
  };

  const filteredWorkspaces = filterConnectionId 
    ? workspaces.filter(w => w.connectionId === filterConnectionId)
    : workspaces;

  return (
    <div className="ssh-hosts-management-wrapper animate__animated animate__fadeIn animate__faster">
      <Tabs
        activeKey={activeTab}
        onChange={(key: string) => setActiveTab(key as any)}
        className="settings-control-plane-manage-tabs"
        items={[
            {
              key: 'connections',
              label: '远程连接',
              children: (
                <SshConnectionCardList
                  connections={connections}
                  loading={loadingConns}
                  testingIds={Object.entries(testStates).filter(([, state]) => state.loading).map(([id]) => id)}
                  onTest={handleTestConnection}
                  onViewWorkspaces={(connection) => {
                    setFilterConnectionId(connection.id);
                    setActiveTab('workspaces');
                  }}
                  onCreateWorkspace={(connection) => {
                    showWsModal();
                    setTimeout(() => {
                      wsForm.setFieldsValue({ connectionId: connection.id });
                      setSelectedConnIdInForm(connection.id);
                    }, 50);
                  }}
                  onEdit={showConnModal}
                  onDelete={handleDeleteConn}
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
                  <SshWorkspaceCardList
                    workspaces={filteredWorkspaces}
                    connections={connections}
                    loading={loadingWorkspaces}
                    onEdit={showWsModal}
                    onDelete={handleDeleteWs}
                  />
                </>
              )
            }
          ]}
      />

      {/* ==========================================
          三、 Connection 添加/编辑 Modal
          ========================================== */}
      <ModalForm
        title={editingConn ? '编辑远程连接' : '添加远程连接'}
        open={connModalVisible}
        onOpenChange={setConnModalVisible}
        form={connForm}
        onFinish={handleSaveConn}
        layout="vertical"
        width={600}
        submitter={{
          searchConfig: {
            submitText: '保存',
            resetText: '取消',
          },
        }}
        modalProps={{
          destroyOnClose: true,
        }}
      >
        <div style={{ marginTop: '16px' }}>
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
              <Radio.Button value="key-file">私钥文件</Radio.Button>
              <Radio.Button value="key">粘贴私钥</Radio.Button>
              <Radio.Button value="password">账户密码</Radio.Button>
            </Radio.Group>
          </Form.Item>

          {authType === 'key-file' && (
            <Form.Item
              name="identityFile"
              label="当前 Server 上的私钥路径"
              help="例如 ~/.ssh/aws.pem；文件必须位于当前 AIH Server 运行用户的 ~/.ssh，AIH 只保存路径，不复制私钥内容。"
              rules={[{ required: true, message: '请输入当前 Server 上的私钥路径' }]}
            >
              <Input placeholder="~/.ssh/aws.pem" />
            </Form.Item>
          )}

          {authType === 'key' && (
            <Form.Item
              name="privateKey"
              label="私钥内容"
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
        </div>
      </ModalForm>

      {/* ==========================================
          四、 Workspace 添加/编辑 Modal
          ========================================== */}
      <ModalForm
        title={editingWs ? '编辑项目工作空间' : '创建远程项目工作空间'}
        open={wsModalVisible}
        onOpenChange={setWsModalVisible}
        form={wsForm}
        onFinish={handleSaveWs}
        layout="vertical"
        submitter={{
          searchConfig: {
            submitText: '保存',
            resetText: '取消',
          },
        }}
        modalProps={{
          destroyOnClose: true,
        }}
      >
        <div style={{ marginTop: '16px' }}>
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
        </div>
      </ModalForm>

      <Drawer
        title={activeDiagnosticConn ? `${activeDiagnosticConn.label} 系统诊断结果` : '系统诊断结果'}
        placement="right"
        width={480}
        onClose={() => setDiagnosticDrawerVisible(false)}
        open={diagnosticDrawerVisible}
        destroyOnClose
      >
        {renderDiagnosticDrawerContent()}
      </Drawer>

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
                    <strong style={{ color: 'var(--color-info)' }}>.. (返回上级目录)</strong>
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
