import React, { useState, useEffect } from 'react';
import { Form, Input, Modal, Tag, Space, Select, Breadcrumb, Radio, Tabs, Drawer } from 'antd';
import InlineNote from '@/components/ui/InlineNote';
import PageHeaderActions from '@/components/ui/PageHeaderActions';
import { ModalForm } from '@ant-design/pro-components';
import Button from '@/components/ui/AppButton';
import { SshConnectionCardList, SshWorkspaceCardList } from '@/components/settings/SshHostCardLists';
import type { SshConnection, SshWorkspace } from '@/features/ssh-hosts/ssh-hosts-model';
import {
  SSH_AUTH_OPTIONS,
  SSH_CONNECTION_FORM_DEFAULTS,
  buildRemotePathCrumbs,
  buildSshConnectionFormValues
} from '@/features/ssh-hosts/ssh-hosts-model';
import { useSshDirectoryBrowser, useSshHosts } from '@/features/ssh-hosts/use-ssh-hosts';
import { LoadingOutlined, FolderOpenOutlined, FolderAddOutlined, LinkOutlined, RightOutlined } from '@ant-design/icons';

export default function SshHostsPanel({ setActions }: { setActions?: (actions: React.ReactNode) => void }) {
  // ------------------------------------------
  // 1. 数据状态（数据与请求由 useSshHosts 统一提供，移动端共用）
  // ------------------------------------------
  const {
    connections,
    workspaces,
    loadingConns,
    loadingWorkspaces,
    testStates,
    testingIds,
    saveConnection,
    deleteConnection,
    testConnection,
    saveWorkspace,
    deleteWorkspace
  } = useSshHosts();
  const [activeTab, setActiveTab] = useState<'connections' | 'workspaces'>('connections');
  const [filterConnectionId, setFilterConnectionId] = useState<string>('');
  const [diagnosticDrawerVisible, setDiagnosticDrawerVisible] = useState(false);
  const [activeDiagnosticConn, setActiveDiagnosticConn] = useState<SshConnection | null>(null);

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

  useEffect(() => {
    if (setActions) {
      setActions(
        <PageHeaderActions
          actions={[
            {
              key: 'add-conn',
              label: '添加连接',
              icon: <LinkOutlined />,
              onClick: () => showConnModal(),
            },
            {
              key: 'add-ws',
              label: '创建工作空间',
              icon: <FolderAddOutlined />,
              primary: true,
              disabled: connections.length === 0,
              onClick: () => showWsModal(),
            },
          ]}
        />
      );
    }
  }, [setActions, connections.length]);

  useEffect(() => {
    return () => {
      setActions?.(null);
    };
  }, [setActions]);

  // 远程目录浏览器状态
  const dirBrowser = useSshDirectoryBrowser();

  // ------------------------------------------
  // 3. Connection 物理连接管理逻辑
  // ------------------------------------------
  const showConnModal = (conn?: SshConnection) => {
    if (conn) {
      setEditingConn(conn);
      setAuthType(conn.authType);
      connForm.setFieldsValue(buildSshConnectionFormValues(conn));
    } else {
      setEditingConn(null);
      setAuthType('agent');
      connForm.resetFields();
      connForm.setFieldsValue(SSH_CONNECTION_FORM_DEFAULTS);
    }
    setConnModalVisible(true);
  };

  const handleSaveConn = (values: Record<string, unknown>): Promise<boolean> => saveConnection(editingConn, values);

  const handleDeleteConn = (id: string) => deleteConnection(id);

  const handleTestConnection = async (conn: SshConnection) => {
    setActiveDiagnosticConn(conn);
    setDiagnosticDrawerVisible(true);
    await testConnection(conn);
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

  const handleSaveWs = (values: Record<string, unknown>): Promise<boolean> => saveWorkspace(editingWs, values);

  const handleDeleteWs = (id: string) => deleteWorkspace(id);

  // ------------------------------------------
  // 5. 远程目录浏览器逻辑
  // ------------------------------------------
  const openDirectoryBrowser = () => {
    dirBrowser.openFor(selectedConnIdInForm);
  };

  const handleConfirmDirectory = () => {
    const selected = dirBrowser.confirm();
    if (selected) wsForm.setFieldsValue({ remoteRoot: selected });
  };

  // 构造面包屑
  const renderBreadcrumbs = () => {
    if (!dirBrowser.currentPath) return null;
    const breadcrumbItems = [];

    // 根目录项
    breadcrumbItems.push(
      <Breadcrumb.Item key="root" onClick={() => dirBrowser.navigate('/')}>
        <span className="ssh-dir-crumb">[Root]</span>
      </Breadcrumb.Item>
    );

    buildRemotePathCrumbs(dirBrowser.currentPath).forEach((crumb, index) => {
      breadcrumbItems.push(
        <Breadcrumb.Item key={index} onClick={crumb.last ? undefined : () => dirBrowser.navigate(crumb.path)}>
          <span className={crumb.last ? 'ssh-dir-crumb ssh-dir-crumb--current' : 'ssh-dir-crumb'}>
            {crumb.name}
          </span>
        </Breadcrumb.Item>
      );
    });

    return (
      <Breadcrumb
        separator={<RightOutlined className="ssh-dir-crumb-sep" />}
        className="ssh-dir-breadcrumb"
      >
        {breadcrumbItems}
      </Breadcrumb>
    );
  };

  const renderDiagnosticDrawerContent = () => {
    if (!activeDiagnosticConn) return null;
    const state = testStates[activeDiagnosticConn.id];
    if (!state) return <div className="ssh-diag-placeholder hud-label">等待测试连接...</div>;
    if (state.loading) return (
      <div className="ssh-diag-loading">
        <LoadingOutlined className="ssh-diag-loading-icon" />
        <span className="ssh-diag-loading-text">正在连接远程主机并执行依赖诊断，请稍后...</span>
      </div>
    );

    const result = state.result;
    if (!result) return null;
    const targetLabel = result.target || `${activeDiagnosticConn.user ? `${activeDiagnosticConn.user}@` : ''}${activeDiagnosticConn.host}`;

    return (
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        {result.status === 'reachable' && (
          <InlineNote tone="success" description={`已成功建立连接。远程主机: ${targetLabel}。`}>
            SSH 连通成功
          </InlineNote>
        )}
        {result.status === 'auth-required' && (
          <InlineNote
            tone="warning"
            description="主机可达，但 SSH 认证失败。请检查当前连接配置的私钥文件路径、私钥内容或密码；使用 SSH Agent 时，请确认当前 AIH Server 运行用户的 ssh-agent 已加载对应密钥。"
          >
            拒绝访问 (认证未通过)
          </InlineNote>
        )}
        {result.status === 'unreachable' && (
          <InlineNote
            tone="error"
            description={result.stderr || "网络不可达，请检查 IP 端口是否开通，或者 SSHD 服务是否启动。"}
          >
            连接失败
          </InlineNote>
        )}

        {result.status === 'reachable' && (
          <div className="ssh-diag-panel hud-panel hud-panel--sm">
            <div className="ssh-diag-section">
              <div className="ssh-diag-caption hud-label">系统平台 / 架构</div>
              <Space size={6}>
                <Tag color="blue" className="ssh-diag-mono-tag">{result.platform || '未知'}</Tag>
                <Tag color="cyan" className="ssh-diag-mono-tag">{result.arch || '未知'}</Tag>
              </Space>
            </div>

            <div>
              <div className="ssh-diag-caption hud-label">依赖项检测</div>
              <div className="ssh-diag-rows">
                <div className="ssh-diag-row">
                  <span className="ssh-diag-row-name">Node.js</span>
                  <Tag color={result.commands?.node ? 'green' : 'red'} className="ssh-diag-tag"><span className={`hud-led ${result.commands?.node ? 'hud-led--ok' : 'hud-led--err'}`} aria-hidden="true" />{result.commands?.node ? '已安装' : '未检测到'}</Tag>
                </div>
                <div className="ssh-diag-row">
                  <span className="ssh-diag-row-name">Npm</span>
                  <Tag color={result.commands?.npm ? 'green' : 'red'} className="ssh-diag-tag"><span className={`hud-led ${result.commands?.npm ? 'hud-led--ok' : 'hud-led--err'}`} aria-hidden="true" />{result.commands?.npm ? '已安装' : '未检测到'}</Tag>
                </div>
                <div className="ssh-diag-row">
                  <span className="ssh-diag-row-name">Git</span>
                  <Tag color={result.commands?.git ? 'green' : 'red'} className="ssh-diag-tag"><span className={`hud-led ${result.commands?.git ? 'hud-led--ok' : 'hud-led--err'}`} aria-hidden="true" />{result.commands?.git ? '已安装' : '未检测到'}</Tag>
                </div>
                <div className="ssh-diag-row">
                  <span className="ssh-diag-row-name">AIH Agent</span>
                  <Tag color={result.commands?.aih ? 'green' : 'orange'} className="ssh-diag-tag"><span className={`hud-led ${result.commands?.aih ? 'hud-led--ok' : 'hud-led--warn'}`} aria-hidden="true" />{result.commands?.aih ? '已配置' : '免装模式'}</Tag>
                </div>
              </div>
            </div>

            {result.recommendation && (
              <div className="ssh-diag-advice">
                <div className="ssh-diag-caption hud-label">诊断建议</div>
                <p className="ssh-diag-advice-text hud-prose">{result.recommendation}</p>
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
                  testingIds={testingIds}
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
                    <InlineNote tone="info" className="ssh-filter-note">
                      <span>
                        当前正在筛选连接 <strong>{connections.find(c => c.id === filterConnectionId)?.label || '已未知'}</strong> 的工作空间。
                        <Button type="link" size="small" className="ssh-filter-clear" onClick={() => setFilterConnectionId('')}>
                          清除筛选
                        </Button>
                      </span>
                    </InlineNote>
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
        <div className="ssh-form-body">
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
              {SSH_AUTH_OPTIONS.map((option) => (
                <Radio.Button key={option.value} value={option.value}>{option.label}</Radio.Button>
              ))}
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
                className="ssh-private-key-input"
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
        <div className="ssh-form-body">
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
                  className="ssh-remote-root-input"
                  style={{ width: '360px' }}
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
        open={dirBrowser.open}
        onOk={handleConfirmDirectory}
        onCancel={dirBrowser.close}
        okText="确认选择该路径"
        cancelText="取消"
        width={700}
      >
        <div className="ssh-form-body">
          {/* 1. 面包屑路径层级 */}
          {renderBreadcrumbs()}

          {/* 2. 目录详细列表 */}
          <div className="directory-list-container ssh-dir-list">
            {dirBrowser.loading ? (
              <div className="ssh-dir-loading">
                <LoadingOutlined className="ssh-dir-loading-icon" />
                <span className="hud-label">正在获取远程目录列表，请稍后...</span>
              </div>
            ) : (
              <div className="ssh-dir-rows">
                {dirBrowser.parentPath && dirBrowser.currentPath !== '/' && (
                  <div
                    className="dir-item ssh-dir-item ssh-dir-item--parent"
                    onDoubleClick={() => dirBrowser.navigate(dirBrowser.parentPath)}
                  >
                    <FolderOpenOutlined className="ssh-dir-item-icon" />
                    <strong className="ssh-dir-item-up">.. (返回上级目录)</strong>
                  </div>
                )}

                {dirBrowser.dirs.length === 0 ? (
                  <div className="ssh-dir-empty hud-label">
                    没有子目录。双击上级目录可返回。
                  </div>
                ) : (
                  dirBrowser.dirs.map(dir => {
                    const isSelected = dirBrowser.selectedPath === dir.path;
                    return (
                      <div
                        key={dir.path}
                        className={`dir-item ssh-dir-item${isSelected ? ' ssh-dir-item--selected' : ''}`}
                        onClick={() => dirBrowser.select(dir.path)}
                        onDoubleClick={() => dirBrowser.navigate(dir.path)}
                      >
                        <FolderOpenOutlined className="ssh-dir-item-icon" />
                        <span>{dir.name}</span>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* 3. 选定路径显示 */}
          <div className="ssh-dir-selected">
            <span className="ssh-dir-selected-label hud-label">当前选定路径:</span>
            <code className="ssh-dir-selected-path">
              {dirBrowser.selectedPath || '未选择'}
            </code>
          </div>
        </div>
      </Modal>
    </div>
  );
}
