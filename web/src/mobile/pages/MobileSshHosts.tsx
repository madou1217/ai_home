import { useState } from 'react';
import { Button, Form, Input, Radio, Select, Spin } from 'antd';
import {
  ApiOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  LinkOutlined,
  ReloadOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import {
  DetailSheet,
  EmptySignal,
  HudChips,
  HudField,
  HudIconButton,
  HudSection,
  KeyValue,
  MobilePage,
  MobileToolbar,
  MonoList,
  SwipeRow
} from '@/mobile/ui';
import type { HudTone, SwipeAction } from '@/mobile/ui';
import type { MobilePageProps } from '@/mobile/mobile-routes';
import {
  SSH_AUTH_LABELS,
  SSH_AUTH_OPTIONS,
  SSH_CONNECTION_FORM_DEFAULTS,
  SSH_DELETE_CONNECTION_CONFIRM,
  SSH_DELETE_WORKSPACE_CONFIRM,
  buildSshConnectionFormValues,
  formatSshTarget,
  type SshAuthType,
  type SshConnection,
  type SshWorkspace
} from '@/features/ssh-hosts/ssh-hosts-model';
import { useSshDirectoryBrowser, useSshHosts } from '@/features/ssh-hosts/use-ssh-hosts';
import type { SshTestState } from '@/features/ssh-hosts/use-ssh-hosts';
import { confirmAction } from '@/utils/confirm-action';
import FabricFormItem from './fabric/FabricFormItem';
import SshDiagnostics from './fabric/SshDiagnostics';
import SshDirectorySheet from './fabric/SshDirectorySheet';
import fabric from './fabric/fabric.module.css';
import styles from './MobileSshHosts.module.css';

type TabKey = 'connections' | 'workspaces';

type ConnFormState = { editing: SshConnection | null; version: number };
type WsFormState = { editing: SshWorkspace | null; connectionId: string; version: number };

/** 行内测试状态：直接显示真实的 testConnection 结果枚举（LED + 大写等宽文字）。 */
const TEST_TONE: Record<string, HudTone> = {
  reachable: 'ok',
  'auth-required': 'warn',
  unreachable: 'err'
};

function testBadge(state?: SshTestState) {
  if (!state) return null;
  if (state.loading) return { tone: 'info' as HudTone, label: 'TESTING' };
  return state.result ? { tone: TEST_TONE[state.result.status] || 'muted', label: state.result.status } : null;
}

/**
 * /fabric/ssh-hosts 移动端：远程连接 / 项目工作空间 两组列表（HudChips 切换），左滑操作 + 详情抽屉，
 * 连接诊断、添加 / 编辑表单、工作空间表单与远程目录浏览器都用底部抽屉承载。
 * 数据与请求全部来自 useSshHosts / useSshDirectoryBrowser（与桌面 SshHostsPanel 共用）。
 */
export default function MobileSshHosts(_props: MobilePageProps) {
  const ssh = useSshHosts();
  const { connections, workspaces, testStates } = ssh;
  const dirBrowser = useSshDirectoryBrowser();
  const [tab, setTab] = useState<TabKey>('connections');
  const [filterConnectionId, setFilterConnectionId] = useState('');
  const [detailConnId, setDetailConnId] = useState('');
  const [detailWsId, setDetailWsId] = useState('');
  const [connForm, setConnForm] = useState<ConnFormState | null>(null);
  const [wsForm, setWsForm] = useState<WsFormState | null>(null);
  const [connSaving, setConnSaving] = useState(false);
  const [wsSaving, setWsSaving] = useState(false);
  const [connFormInstance] = Form.useForm();
  const [wsFormInstance] = Form.useForm();
  const authType = Form.useWatch('authType', connFormInstance) as SshAuthType | undefined;
  const wsConnectionId = Form.useWatch('connectionId', wsFormInstance) as string | undefined;

  const detailConn = connections.find((item) => item.id === detailConnId) || null;
  const detailWs = workspaces.find((item) => item.id === detailWsId) || null;
  const connectionOf = (ws: SshWorkspace) => connections.find((item) => item.id === ws.connectionId) || null;
  const filteredWorkspaces = filterConnectionId
    ? workspaces.filter((ws) => ws.connectionId === filterConnectionId)
    : workspaces;

  // ---- 连接 ----
  const showConnForm = (conn?: SshConnection) => {
    setDetailConnId('');
    setConnForm((prev) => ({ editing: conn || null, version: (prev?.version || 0) + 1 }));
  };

  const handleSaveConn = async (values: Record<string, unknown>) => {
    if (!connForm) return;
    setConnSaving(true);
    const saved = await ssh.saveConnection(connForm.editing, values);
    setConnSaving(false);
    if (saved) setConnForm(null);
  };

  const handleDeleteConn = async (conn: SshConnection) => {
    const confirmed = await confirmAction({ title: SSH_DELETE_CONNECTION_CONFIRM, okText: '确认', danger: true });
    if (!confirmed) return;
    if (detailConnId === conn.id) setDetailConnId('');
    if (filterConnectionId === conn.id) setFilterConnectionId('');
    await ssh.deleteConnection(conn.id);
  };

  /** 测试连接：与桌面一致，发起测试并打开诊断视图（此处为连接详情抽屉的诊断区）。 */
  const handleTestConn = (conn: SshConnection) => {
    setDetailConnId(conn.id);
    ssh.testConnection(conn);
  };

  const viewWorkspaces = (conn: SshConnection) => {
    setDetailConnId('');
    setFilterConnectionId(conn.id);
    setTab('workspaces');
  };

  // ---- 工作空间 ----
  const showWsForm = (ws?: SshWorkspace, presetConnectionId = '') => {
    setDetailConnId('');
    setDetailWsId('');
    setWsForm((prev) => ({
      editing: ws || null,
      connectionId: ws ? ws.connectionId : presetConnectionId || connections[0]?.id || '',
      version: (prev?.version || 0) + 1
    }));
  };

  const handleSaveWs = async (values: Record<string, unknown>) => {
    if (!wsForm) return;
    setWsSaving(true);
    const saved = await ssh.saveWorkspace(wsForm.editing, values);
    setWsSaving(false);
    if (saved) setWsForm(null);
  };

  const handleDeleteWs = async (ws: SshWorkspace) => {
    const confirmed = await confirmAction({ title: SSH_DELETE_WORKSPACE_CONFIRM, okText: '确认', danger: true });
    if (!confirmed) return;
    if (detailWsId === ws.id) setDetailWsId('');
    await ssh.deleteWorkspace(ws.id);
  };

  const connActions = (conn: SshConnection): SwipeAction[] => [
    {
      key: 'test',
      label: '测试',
      icon: <ThunderboltOutlined />,
      tone: 'primary',
      disabled: ssh.testingIds.includes(conn.id),
      onAction: () => handleTestConn(conn)
    },
    { key: 'edit', label: '编辑', icon: <EditOutlined />, onAction: () => showConnForm(conn) },
    { key: 'delete', label: '删除', icon: <DeleteOutlined />, tone: 'danger', onAction: () => handleDeleteConn(conn) }
  ];

  const wsActions = (ws: SshWorkspace): SwipeAction[] => [
    { key: 'edit', label: '编辑', icon: <EditOutlined />, onAction: () => showWsForm(ws) },
    { key: 'delete', label: '移除', icon: <DeleteOutlined />, tone: 'danger', onAction: () => handleDeleteWs(ws) }
  ];

  const reload = () => {
    ssh.fetchConnections();
    ssh.fetchWorkspaces();
  };

  const toolbar = (
    <MobileToolbar>
      <HudIconButton
        icon={<ReloadOutlined />}
        label="刷新"
        loading={ssh.loadingConns || ssh.loadingWorkspaces}
        onClick={reload}
      />
      <HudIconButton icon={<LinkOutlined />} label="添加连接" onClick={() => showConnForm()} />
      <HudIconButton
        icon={<FolderAddOutlined />}
        label="创建工作空间"
        tone="primary"
        showLabel
        disabled={connections.length === 0}
        onClick={() => showWsForm()}
      />
    </MobileToolbar>
  );

  const filterConnection = connections.find((item) => item.id === filterConnectionId);

  return (
    <MobilePage toolbar={toolbar} lead="管理 SSH 连接和可用于远端开发的工作区。">
      <HudChips
        ariaLabel="SSH 分组"
        value={tab}
        onChange={(key) => setTab(key as TabKey)}
        items={[
          { key: 'connections', label: '远程连接', count: connections.length },
          { key: 'workspaces', label: '项目工作空间', count: workspaces.length }
        ]}
      />

      {tab === 'connections' ? (
        <HudSection title="远程连接" code="SSH" count={connections.length}>
          {ssh.loadingConns && connections.length === 0 ? (
            <div className={styles.loading}><Spin /></div>
          ) : connections.length === 0 ? (
            <EmptySignal
              title="NO LINK"
              description="暂无远程连接"
              action={<Button type="primary" icon={<LinkOutlined />} onClick={() => showConnForm()}>添加连接</Button>}
            />
          ) : (
            <MonoList ariaLabel="远程连接">
              {connections.map((conn) => {
                const badge = testBadge(testStates[conn.id]);
                return (
                  <SwipeRow
                    key={conn.id}
                    actions={connActions(conn)}
                    onTap={() => setDetailConnId(conn.id)}
                    ariaLabel={`${conn.label}，${formatSshTarget(conn)}`}
                  >
                    <span className="mhud-row__icon mhud-tone--info" aria-hidden="true"><ApiOutlined /></span>
                    <span className="mhud-row__main">
                      <span className="mhud-row__title">{conn.label}</span>
                      <span className="mhud-row__meta">{formatSshTarget(conn)}</span>
                    </span>
                    <span className="mhud-row__side">
                      <span className={styles.auth}>{SSH_AUTH_LABELS[conn.authType]}</span>
                      {badge ? (
                        <span className={`mhud-status mhud-tone--${badge.tone}`}>
                          <span className={`hud-led hud-led--${badge.tone}${badge.tone === 'info' ? ' hud-led--live' : ''}`} aria-hidden="true" />
                          {badge.label}
                        </span>
                      ) : null}
                    </span>
                  </SwipeRow>
                );
              })}
            </MonoList>
          )}
        </HudSection>
      ) : (
        <HudSection title="项目工作空间" code="WS" count={filteredWorkspaces.length}>
          {filterConnectionId ? (
            <div className={styles.filter}>
              <span className={fabric.note}>
                当前正在筛选连接 <strong>{filterConnection?.label || '已未知'}</strong> 的工作空间。
              </span>
              <Button size="small" type="link" onClick={() => setFilterConnectionId('')}>清除筛选</Button>
            </div>
          ) : null}
          {ssh.loadingWorkspaces && workspaces.length === 0 ? (
            <div className={styles.loading}><Spin /></div>
          ) : filteredWorkspaces.length === 0 ? (
            <EmptySignal
              title="NO WORKSPACE"
              description="暂无项目工作空间"
              action={connections.length > 0 ? (
                <Button type="primary" icon={<FolderAddOutlined />} onClick={() => showWsForm(undefined, filterConnectionId)}>
                  创建工作空间
                </Button>
              ) : undefined}
            />
          ) : (
            <MonoList ariaLabel="项目工作空间">
              {filteredWorkspaces.map((ws) => {
                const conn = connectionOf(ws);
                return (
                  <SwipeRow
                    key={ws.id}
                    actions={wsActions(ws)}
                    onTap={() => setDetailWsId(ws.id)}
                    ariaLabel={`${ws.label}，${ws.remoteRoot}`}
                  >
                    <span className="mhud-row__icon mhud-tone--info" aria-hidden="true"><FolderOpenOutlined /></span>
                    <span className="mhud-row__main">
                      <span className="mhud-row__title">{ws.label}</span>
                      <span className="mhud-row__meta">{ws.remoteRoot}</span>
                    </span>
                    <span className="mhud-row__side">
                      <span className={`mhud-status ${conn ? 'mhud-tone--info' : 'mhud-tone--err'}`}>
                        <span className={`hud-led ${conn ? 'hud-led--info' : 'hud-led--err'}`} aria-hidden="true" />
                        <span className={styles.connLabel}>{conn ? conn.label : '连接已删除'}</span>
                      </span>
                    </span>
                  </SwipeRow>
                );
              })}
            </MonoList>
          )}
        </HudSection>
      )}

      {/* 连接详情 + 诊断 */}
      <DetailSheet
        open={Boolean(detailConn)}
        onClose={() => setDetailConnId('')}
        code="SSH LINK"
        title={detailConn?.label || ''}
        maxHeight="92dvh"
        footer={detailConn ? (
          <>
            <Button icon={<EditOutlined />} onClick={() => showConnForm(detailConn)}>编辑</Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={ssh.testingIds.includes(detailConn.id)}
              onClick={() => handleTestConn(detailConn)}
            >
              测试连接
            </Button>
          </>
        ) : null}
      >
        {detailConn ? (
          <div className={styles.detail}>
            <KeyValue
              rows={[
                { key: 'target', label: '目标', value: formatSshTarget(detailConn) },
                { key: 'auth', label: '认证方式', value: SSH_AUTH_LABELS[detailConn.authType] },
                ...(detailConn.authType === 'key-file' && detailConn.identityFile
                  ? [{ key: 'identity', label: '私钥路径', value: detailConn.identityFile }]
                  : [])
              ]}
            />
            <div className={styles.block}>
              <span className="hud-label">系统诊断</span>
              <SshDiagnostics connection={detailConn} state={testStates[detailConn.id]} />
            </div>
            <div className={fabric.sheetActions}>
              <Button icon={<FolderOpenOutlined />} onClick={() => viewWorkspaces(detailConn)}>查看工作区</Button>
              <Button icon={<FolderAddOutlined />} onClick={() => showWsForm(undefined, detailConn.id)}>创建工作区</Button>
              <Button danger icon={<DeleteOutlined />} onClick={() => handleDeleteConn(detailConn)}>删除</Button>
            </div>
          </div>
        ) : null}
      </DetailSheet>

      {/* 工作空间详情 */}
      <DetailSheet
        open={Boolean(detailWs)}
        onClose={() => setDetailWsId('')}
        code="WORKSPACE"
        title={detailWs?.label || ''}
        footer={detailWs ? (
          <>
            <Button danger icon={<DeleteOutlined />} onClick={() => handleDeleteWs(detailWs)}>移除</Button>
            <Button type="primary" icon={<EditOutlined />} onClick={() => showWsForm(detailWs)}>编辑</Button>
          </>
        ) : null}
      >
        {detailWs ? (() => {
          const conn = connectionOf(detailWs);
          return (
            <KeyValue
              rows={[
                { key: 'root', label: '远端路径', value: detailWs.remoteRoot },
                {
                  key: 'conn',
                  label: '关联连接',
                  value: conn ? conn.label : '连接已删除',
                  tone: conn ? undefined : 'err'
                },
                ...(conn ? [{ key: 'target', label: '目标', value: formatSshTarget(conn) }] : [])
              ]}
            />
          );
        })() : null}
      </DetailSheet>

      {/* 添加 / 编辑远程连接（全高表单抽屉） */}
      <DetailSheet
        open={Boolean(connForm)}
        onClose={() => setConnForm(null)}
        code={connForm?.editing ? 'EDIT LINK' : 'NEW LINK'}
        title={connForm?.editing ? '编辑远程连接' : '添加远程连接'}
        maxHeight="96dvh"
        footer={(
          <>
            <Button onClick={() => setConnForm(null)}>取消</Button>
            <Button type="primary" loading={connSaving} onClick={() => connFormInstance.submit()}>保存</Button>
          </>
        )}
      >
        {connForm ? (
          <Form
            key={connForm.version}
            form={connFormInstance}
            layout="vertical"
            className={fabric.form}
            clearOnDestroy
            initialValues={connForm.editing ? buildSshConnectionFormValues(connForm.editing) : SSH_CONNECTION_FORM_DEFAULTS}
            onFinish={handleSaveConn}
          >
            <FabricFormItem
              name="label"
              label="连接名称 (Label)"
              required
              rules={[{ required: true, message: '请输入显示名称，例如: 阿里云开发服务器' }]}
            >
              <Input placeholder="例如: Aliyun-Box" aria-label="连接名称" />
            </FabricFormItem>
            <FabricFormItem
              name="host"
              label="主机名 / IP (Host)"
              required
              rules={[{ required: true, message: '请输入主机名或IP' }]}
            >
              <Input placeholder="例如: 192.168.1.120" autoCapitalize="off" autoCorrect="off" aria-label="主机名或 IP" />
            </FabricFormItem>
            <FabricFormItem
              name="port"
              label="端口 (Port)"
              required
              rules={[{ required: true, message: '请输入端口' }]}
            >
              <Input placeholder="22" type="number" inputMode="numeric" aria-label="端口" />
            </FabricFormItem>
            <FabricFormItem
              name="user"
              label="用户名 (User)"
              required
              rules={[{ required: true, message: '请输入连接用户名' }]}
            >
              <Input placeholder="例如: root 或 ubuntu" autoCapitalize="off" autoCorrect="off" aria-label="用户名" />
            </FabricFormItem>
            <FabricFormItem name="authType" label="认证方式" required rules={[{ required: true }]}>
              <Radio.Group className={styles.authGroup} aria-label="认证方式">
                {SSH_AUTH_OPTIONS.map((option) => (
                  <Radio.Button key={option.value} value={option.value}>{option.label}</Radio.Button>
                ))}
              </Radio.Group>
            </FabricFormItem>
            {authType === 'key-file' ? (
              <FabricFormItem
                name="identityFile"
                label="当前 Server 上的私钥路径"
                required
                hint="例如 ~/.ssh/aws.pem；文件必须位于当前 AIH Server 运行用户的 ~/.ssh，AIH 只保存路径，不复制私钥内容。"
                rules={[{ required: true, message: '请输入当前 Server 上的私钥路径' }]}
              >
                <Input placeholder="~/.ssh/aws.pem" autoCapitalize="off" autoCorrect="off" aria-label="私钥路径" />
              </FabricFormItem>
            ) : null}
            {authType === 'key' ? (
              <FabricFormItem
                name="privateKey"
                label="私钥内容"
                required
                rules={[{ required: true, message: '请粘贴 SSH 私钥 (PEM/OpenSSH格式)' }]}
              >
                <Input.TextArea
                  rows={6}
                  placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n...'}
                  className={styles.privateKey}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-label="私钥内容"
                />
              </FabricFormItem>
            ) : null}
            {authType === 'password' ? (
              <FabricFormItem
                name="password"
                label="连接密码 (Password)"
                required
                rules={[{ required: true, message: '请输入远程账户连接密码' }]}
              >
                <Input.Password placeholder="密码" autoComplete="new-password" aria-label="连接密码" />
              </FabricFormItem>
            ) : null}
          </Form>
        ) : null}
      </DetailSheet>

      {/* 创建 / 编辑项目工作空间 */}
      <DetailSheet
        open={Boolean(wsForm)}
        onClose={() => setWsForm(null)}
        code={wsForm?.editing ? 'EDIT WS' : 'NEW WS'}
        title={wsForm?.editing ? '编辑项目工作空间' : '创建远程项目工作空间'}
        maxHeight="96dvh"
        footer={(
          <>
            <Button onClick={() => setWsForm(null)}>取消</Button>
            <Button type="primary" loading={wsSaving} onClick={() => wsFormInstance.submit()}>保存</Button>
          </>
        )}
      >
        {wsForm ? (
          <Form
            key={wsForm.version}
            form={wsFormInstance}
            layout="vertical"
            className={fabric.form}
            clearOnDestroy
            initialValues={wsForm.editing
              ? { connectionId: wsForm.editing.connectionId, label: wsForm.editing.label, remoteRoot: wsForm.editing.remoteRoot }
              : { connectionId: wsForm.connectionId || undefined }}
            onFinish={handleSaveWs}
          >
            <FabricFormItem
              name="connectionId"
              label="关联物理连接 (SSH Connection)"
              required
              rules={[{ required: true, message: '请选择一个有效的远程 SSH 连接' }]}
            >
              <Select
                aria-label="关联物理连接"
                options={connections.map((conn) => ({ label: `${conn.label} (${conn.user}@${conn.host})`, value: conn.id }))}
              />
            </FabricFormItem>
            <FabricFormItem
              name="label"
              label="项目空间名称 (Label)"
              required
              rules={[{ required: true, message: '请输入该项目空间在 Web 上的名称' }]}
            >
              <Input placeholder="例如: 订单微服务项目" aria-label="项目空间名称" />
            </FabricFormItem>
            <HudField label="远端绝对路径 (RemoteRoot)" required>
              <div className={styles.rootPicker}>
                <Form.Item
                  name="remoteRoot"
                  className={fabric.formItem}
                  rules={[{ required: true, message: '请选择远程项目绝对路径' }]}
                >
                  <Input placeholder="不准手填，请点击下方选择目录" readOnly className={fabric.mono} aria-label="远端绝对路径" />
                </Form.Item>
                <Button block icon={<FolderOpenOutlined />} onClick={() => dirBrowser.openFor(wsConnectionId || '')}>
                  选择目录
                </Button>
              </div>
            </HudField>
          </Form>
        ) : null}
      </DetailSheet>

      <SshDirectorySheet
        browser={dirBrowser}
        onConfirm={(path) => wsFormInstance.setFieldsValue({ remoteRoot: path })}
      />
    </MobilePage>
  );
}
