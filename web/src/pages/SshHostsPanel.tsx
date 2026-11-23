import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Collapse, Form, Input, Radio, Select, Space, Switch, Tabs } from 'antd';
import { ModalForm } from '@ant-design/pro-components';
import { FolderAddOutlined, FolderOpenOutlined, LinkOutlined } from '@ant-design/icons';
import FormSurfaceField, { useFormSubmitTransitionGuard } from '@/components/ui/FormSurfaceField';
import InlineNote from '@/components/ui/InlineNote';
import Reveal from '@/components/ui/Reveal';
import PageHeaderActions from '@/components/ui/PageHeaderActions';
import Button from '@/components/ui/AppButton';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import { SshConnectionCardList, SshWorkspaceCardList } from '@/components/settings/SshHostCardLists';
import { resolveOrderedDirection, useSurfaceSwitch } from '@/hooks/use-surface-switch';
import SshDiagnosticDrawer from '@/features/ssh-hosts/SshDiagnosticDrawer';
import SshDirectoryBrowserModal from '@/features/ssh-hosts/SshDirectoryBrowserModal';
import type { SshAuthType, SshConnection, SshWorkspace } from '@/features/ssh-hosts/ssh-hosts-model';
import {
  SSH_AUTH_OPTIONS,
  SSH_CONNECTION_FORM_DEFAULTS,
  buildSshConnectionFormValues
} from '@/features/ssh-hosts/ssh-hosts-model';
import { useSshDirectoryBrowser, useSshHosts } from '@/features/ssh-hosts/use-ssh-hosts';

export default function SshHostsPanel({ setActions }: { setActions?: (actions: React.ReactNode) => void }) {
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

  const [connModalVisible, setConnModalVisible] = useState(false);
  const [editingConn, setEditingConn] = useState<SshConnection | null>(null);
  const [connForm] = Form.useForm();
  const [authType, setAuthType] = useState<SshAuthType>('agent');

  const [wsModalVisible, setWsModalVisible] = useState(false);
  const [editingWs, setEditingWs] = useState<SshWorkspace | null>(null);
  const [wsForm] = Form.useForm();
  const [selectedConnIdInForm, setSelectedConnIdInForm] = useState<string>('');

  useFormSubmitTransitionGuard(connForm);
  const dirBrowser = useSshDirectoryBrowser();
  const { surfaceRef: authFieldsSurfaceRef, switchSurface: switchAuthFields } = useSurfaceSwitch<HTMLDivElement>();

  const showConnModal = useCallback((conn?: SshConnection) => {
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
  }, [connForm]);

  const showWsModal = useCallback((ws?: SshWorkspace, preferredConnId?: string) => {
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
      wsForm.resetFields();
      const targetConnId = preferredConnId || connections[0]?.id || '';
      setSelectedConnIdInForm(targetConnId);
      if (targetConnId) {
        wsForm.setFieldsValue({ connectionId: targetConnId });
      }
    }
    setWsModalVisible(true);
  }, [connections, wsForm]);

  useEffect(() => {
    if (!setActions) return;
    setActions(
      <PageHeaderActions
        actions={[
          {
            key: 'add-conn',
            label: '添加连接',
            icon: <LinkOutlined />,
            onClick: () => showConnModal()
          },
          {
            key: 'add-ws',
            label: '创建工作空间',
            icon: <FolderAddOutlined />,
            primary: true,
            disabled: connections.length === 0,
            onClick: () => showWsModal()
          }
        ]}
      />
    );
  }, [connections.length, setActions, showConnModal, showWsModal]);

  useEffect(() => () => {
    setActions?.(null);
  }, [setActions]);

  const handleSaveConn = (values: Record<string, unknown>): Promise<boolean> => saveConnection(editingConn, values);
  const handleSaveWs = (values: Record<string, unknown>): Promise<boolean> => saveWorkspace(editingWs, values);

  const handleTestConnection = async (conn: SshConnection) => {
    setActiveDiagnosticConn(conn);
    setDiagnosticDrawerVisible(true);
    await testConnection(conn);
  };

  const handleConfirmDirectory = () => {
    const selected = dirBrowser.confirm();
    if (selected) wsForm.setFieldsValue({ remoteRoot: selected });
  };

  const workspaceCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const ws of workspaces) {
      counts[ws.connectionId] = (counts[ws.connectionId] || 0) + 1;
    }
    return counts;
  }, [workspaces]);

  const filteredWorkspaces = filterConnectionId
    ? workspaces.filter((w) => w.connectionId === filterConnectionId)
    : workspaces;

  const activeFilterConnection = connections.find((c) => c.id === filterConnectionId);
  const proxyOutletCount = connections.filter((c) => c.proxyEnabled).length;

  return (
    <div className="ssh-hosts-management-wrapper">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
        <SettingStatusTag
          status={connections.length > 0 ? 'saved' : 'unset'}
          label={`已保存连接 ${connections.length}`}
          compact
          live="off"
        />
        <SettingStatusTag
          status={proxyOutletCount > 0 ? 'applied' : 'unset'}
          label={`代理出口 ${proxyOutletCount}`}
          compact
          live="off"
        />
        <SettingStatusTag
          status={workspaces.length > 0 ? 'saved' : 'unset'}
          label={`工作空间 ${workspaces.length}`}
          compact
          live="off"
        />
      </div>

      <Tabs
        activeKey={activeTab}
        animated={{ inkBar: true, tabPane: true }}
        onChange={(key: string) => setActiveTab(key as 'connections' | 'workspaces')}
        className="settings-control-plane-manage-tabs"
        items={[
          {
            key: 'connections',
            label: `远程连接 (${connections.length})`,
            children: (
              <SshConnectionCardList
                connections={connections}
                loading={loadingConns}
                testingIds={testingIds}
                testStates={testStates}
                workspaceCounts={workspaceCounts}
                onTest={(connection) => void handleTestConnection(connection)}
                onViewWorkspaces={(connection) => {
                  setFilterConnectionId(connection.id);
                  setActiveTab('workspaces');
                }}
                onCreateWorkspace={(connection) => showWsModal(undefined, connection.id)}
                onEdit={showConnModal}
                onDelete={(id) => void deleteConnection(id)}
              />
            )
          },
          {
            key: 'workspaces',
            label: `项目工作空间 (${workspaces.length})`,
            children: (
              <>
                <Reveal open={Boolean(filterConnectionId)}>
                  <InlineNote tone="info" className="ssh-filter-note">
                    <span>
                      当前筛选连接：<strong>{activeFilterConnection?.label || '未知连接'}</strong>
                      <Button
                        type="link"
                        size="small"
                        className="ssh-filter-clear"
                        onClick={() => setFilterConnectionId('')}
                      >
                        清除筛选
                      </Button>
                    </span>
                  </InlineNote>
                </Reveal>
                <SshWorkspaceCardList
                  workspaces={filteredWorkspaces}
                  connections={connections}
                  loading={loadingWorkspaces}
                  onEdit={(ws) => showWsModal(ws)}
                  onDelete={(id) => void deleteWorkspace(id)}
                />
              </>
            )
          }
        ]}
      />

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
            submitText: '保存连接',
            resetText: '取消'
          }
        }}
        modalProps={{
          destroyOnClose: true,
          style: { top: 24 },
          styles: { body: { maxHeight: 'calc(100vh - 190px)', overflowY: 'auto' } }
        }}
      >
        <div className="ssh-form-body">
          <Form.Item
            name="label"
            label="连接名称"
            rules={[{ required: true, message: '请输入显示名称，例如 Aliyun-Box' }]}
          >
            <Input placeholder="例如：Aliyun-Box" />
          </Form.Item>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 120px', gap: 'var(--space-4)' }}>
            <Form.Item
              name="host"
              label="主机名 / IP"
              rules={[{ required: true, message: '请输入主机名或 IP' }]}
            >
              <Input placeholder="例如：192.168.1.120" />
            </Form.Item>

            <Form.Item
              name="port"
              label="端口"
              rules={[{ required: true, message: '请输入端口' }]}
            >
              <Input placeholder="22" type="number" />
            </Form.Item>
          </div>

          <Form.Item
            name="user"
            label="用户名"
            rules={[{ required: true, message: '请输入连接用户名' }]}
          >
            <Input placeholder="例如：root 或 ubuntu" />
          </Form.Item>

          <Form.Item
            name="authType"
            label="认证方式"
            rules={[{ required: true }]}
          >
            <FormSurfaceField
              onBeforeFieldCommit={(commit, rawEvent) => {
                const nextType = (rawEvent as { target?: { value?: SshAuthType } } | null)?.target?.value;
                if (!nextType) {
                  commit();
                  return;
                }
                const authOrder = SSH_AUTH_OPTIONS.map((option) => option.value);
                switchAuthFields(() => {
                  commit();
                  setAuthType(nextType);
                }, {
                  slot: 'authType',
                  current: authType,
                  next: nextType,
                  direction: resolveOrderedDirection(authOrder, authType, nextType)
                });
              }}
            >
              <Radio.Group>
                {SSH_AUTH_OPTIONS.map((option) => (
                  <Radio.Button key={option.value} value={option.value}>{option.label}</Radio.Button>
                ))}
              </Radio.Group>
            </FormSurfaceField>
          </Form.Item>

          <div ref={authFieldsSurfaceRef}>
            {authType === 'key-file' ? (
              <Form.Item
                name="identityFile"
                label="当前 Server 上的私钥路径"
                help="仅保存服务端 ~/.ssh 下路径，不复制私钥内容。"
                rules={[{ required: true, message: '请输入当前 Server 上的私钥路径' }]}
              >
                <Input placeholder="~/.ssh/aws.pem" />
              </Form.Item>
            ) : null}

            {authType === 'key' ? (
              <Form.Item
                name="privateKey"
                label="私钥内容"
                rules={[{ required: true, message: '请粘贴 SSH 私钥 (PEM/OpenSSH 格式)' }]}
              >
                <Input.TextArea
                  rows={6}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----\n..."
                  className="ssh-private-key-input"
                />
              </Form.Item>
            ) : null}

            {authType === 'password' ? (
              <Form.Item
                name="password"
                label="连接密码"
                rules={[{ required: true, message: '请输入远程账户密码' }]}
              >
                <Input.Password placeholder="密码" />
              </Form.Item>
            ) : null}
          </div>

          <Collapse
            ghost
            items={[{
              key: 'advanced',
              label: '网络角色与隧道（高级）',
              forceRender: true,
              children: (
                <>
                  <Form.Item
                    name="reverseTunnelEnabled"
                    label="反向隧道"
                    valuePropName="checked"
                    help="远端自动分配回环端口转发回本机 SSH，实际端口见连接卡片。"
                  >
                    <Switch aria-label="启用反向隧道" />
                  </Form.Item>
                  <Form.Item
                    name="proxyEnabled"
                    label="作为托管代理出口"
                    valuePropName="checked"
                    help="加入托管代理池供安装、更新等任务按需租用，不改全局代理。"
                  >
                    <Switch aria-label="作为托管代理出口" />
                  </Form.Item>
                  <Form.Item
                    name="egressConnectionId"
                    label="出网代理"
                    help="本机直连外网受限时，在安装任务期间临时借用另一台连接的出网通道。"
                  >
                    <Select
                      options={[
                        { value: '', label: '直连（不使用代理）' },
                        ...connections
                          .filter((item) => !editingConn || item.id !== editingConn.id)
                          .map((item) => ({ value: item.id, label: `${item.label}（${item.host}）` }))
                      ]}
                    />
                  </Form.Item>
                </>
              )
            }]}
          />
        </div>
      </ModalForm>

      <ModalForm
        title={editingWs ? '编辑项目工作空间' : '创建远程项目工作空间'}
        open={wsModalVisible}
        onOpenChange={setWsModalVisible}
        form={wsForm}
        onFinish={handleSaveWs}
        layout="vertical"
        submitter={{
          searchConfig: {
            submitText: '保存工作空间',
            resetText: '取消'
          }
        }}
        modalProps={{ destroyOnClose: true }}
      >
        <div className="ssh-form-body">
          <Form.Item
            name="connectionId"
            label="关联连接"
            rules={[{ required: true, message: '请选择远程 SSH 连接' }]}
          >
            <Select
              options={connections.map((c) => ({ label: `${c.label} (${c.user}@${c.host})`, value: c.id }))}
              onChange={(value) => setSelectedConnIdInForm(value)}
            />
          </Form.Item>

          <Form.Item
            name="label"
            label="工作空间名称"
            rules={[{ required: true, message: '请输入工作空间名称' }]}
          >
            <Input placeholder="例如：订单微服务项目" />
          </Form.Item>

          <Form.Item label="远端绝对路径" required>
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item
                name="remoteRoot"
                noStyle
                rules={[{ required: true, message: '请通过目录浏览器选择远端路径' }]}
              >
                <Input
                  placeholder="点击右侧选择远端目录"
                  readOnly
                  className="ssh-remote-root-input"
                />
              </Form.Item>
              <Button icon={<FolderOpenOutlined />} onClick={() => dirBrowser.openFor(selectedConnIdInForm)}>
                选择目录
              </Button>
            </Space.Compact>
          </Form.Item>
        </div>
      </ModalForm>

      <SshDiagnosticDrawer
        open={diagnosticDrawerVisible}
        connection={activeDiagnosticConn}
        testState={activeDiagnosticConn ? testStates[activeDiagnosticConn.id] : undefined}
        onClose={() => setDiagnosticDrawerVisible(false)}
      />

      <SshDirectoryBrowserModal
        dirBrowser={dirBrowser}
        onConfirm={handleConfirmDirectory}
      />
    </div>
  );
}
