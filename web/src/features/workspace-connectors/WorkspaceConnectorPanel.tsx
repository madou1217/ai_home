import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Popconfirm, Popover, Select, Tooltip } from 'antd';
import {
  CodeOutlined,
  CopyOutlined,
  DeleteOutlined,
  FileOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  LaptopOutlined,
  LinkOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined
} from '@ant-design/icons';
import { remoteExecutionAPI, remoteTargetsAPI, workspaceConnectorsAPI } from '@/services/api';
import type { RemoteAccountFact, RemoteModelFact, RemoteTargetInventory } from '@/features/remote-targets/remote-targets-model';
import { useWebTerminalManager } from '@/features/web-terminal/web-terminal-context';
import type {
  RemoteExecutionSession,
  WorkspaceApproval,
  WorkspaceConnector,
  WorkspaceConnectorEnrollment,
  WorkspaceDirectoryEntry
} from './workspace-connectors-model';
import {
  connectorLocation,
  connectorStateLabel,
  joinWorkspacePath,
  parentWorkspacePath
} from './workspace-connectors-model';
import './workspace-connectors.css';

function errorMessage(error: unknown): string {
  const source = error as { response?: { data?: { message?: string; error?: string } }; message?: string } | null;
  return source?.response?.data?.message
    || source?.response?.data?.error
    || source?.message
    || '本地工作区服务暂时不可用';
}

function formatMoment(value?: number): string {
  if (!value) return '';
  try { return new Date(value).toLocaleString(); } catch { return ''; }
}

function formatSize(value?: number): string {
  if (!value || value <= 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function accountOptionLabel(account: RemoteAccountFact): string {
  const alias = account.cliAccountId ? `#${account.cliAccountId}` : account.accountRef.slice(-6);
  return `${alias} · ${account.effectiveModels} models`;
}

function modelOptionLabel(model: RemoteModelFact): string {
  return model.cliModelName && model.cliModelName !== model.catalogModelId
    ? `${model.catalogModelId} · CLI ${model.cliModelName}`
    : model.catalogModelId;
}

function modelOptionValue(model: RemoteModelFact): string {
  return model.cliModelName || model.catalogModelId;
}

function entryIcon(entry: WorkspaceDirectoryEntry) {
  if (entry.type === 'dir') return <FolderOutlined />;
  if (entry.type === 'symlink') return <LinkOutlined />;
  return <FileOutlined />;
}

export default function WorkspaceConnectorPanel() {
  const manager = useWebTerminalManager();
  const [workspaces, setWorkspaces] = useState<WorkspaceConnector[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollLabel, setEnrollLabel] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [enrollment, setEnrollment] = useState<WorkspaceConnectorEnrollment | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [entriesPath, setEntriesPath] = useState('');
  const [entries, setEntries] = useState<WorkspaceDirectoryEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [entriesTruncated, setEntriesTruncated] = useState(false);
  const [agentOpening, setAgentOpening] = useState('');
  const [pickerWorkspace, setPickerWorkspace] = useState<WorkspaceConnector | null>(null);
  const [pickerAgent, setPickerAgent] = useState<'codex' | 'claude'>('codex');
  const [pickerAccount, setPickerAccount] = useState('');
  const [pickerModel, setPickerModel] = useState('');
  const [pickerError, setPickerError] = useState('');
  const [catalog, setCatalog] = useState<RemoteTargetInventory | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [approvals, setApprovals] = useState<Record<string, WorkspaceApproval[]>>({});
  const [approvalModes, setApprovalModes] = useState<Record<string, string>>({});
  const [decidingId, setDecidingId] = useState('');
  const [sessions, setSessions] = useState<RemoteExecutionSession[]>([]);
  const [stoppingSession, setStoppingSession] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await workspaceConnectorsAPI.list();
      const nextWorkspaces = Array.isArray(response.workspaces) ? response.workspaces : [];
      setWorkspaces(nextWorkspaces);
      const nextApprovals: Record<string, WorkspaceApproval[]> = {};
      const nextModes: Record<string, string> = {};
      await Promise.all(
        nextWorkspaces.filter((workspace) => workspace.online).map(async (workspace) => {
          try {
            const result = await workspaceConnectorsAPI.listApprovals(workspace.id);
            nextApprovals[workspace.id] = Array.isArray(result.approvals) ? result.approvals : [];
            nextModes[workspace.id] = result.mode || '';
          } catch {
            nextApprovals[workspace.id] = [];
          }
        })
      );
      setApprovals(nextApprovals);
      setApprovalModes(nextModes);
      try {
        const execution = await remoteExecutionAPI.listSessions();
        setSessions(Array.isArray(execution.sessions) ? execution.sessions : []);
      } catch {
        setSessions([]);
      }
    } catch (loadError) {
      setWorkspaces([]);
      setApprovals({});
      setApprovalModes({});
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  const stopSession = useCallback(async (sessionId: string) => {
    setStoppingSession(sessionId);
    setError('');
    try {
      await remoteExecutionAPI.stopSession(sessionId);
    } catch (stopError) {
      setError(errorMessage(stopError));
    } finally {
      setStoppingSession('');
    }
    await load();
  }, [load]);

  const decideApproval = useCallback(async (workspaceId: string, approvalId: string, approve: boolean) => {
    setDecidingId(approvalId);
    setError('');
    try {
      await workspaceConnectorsAPI.decideApproval(workspaceId, approvalId, approve);
    } catch (decisionError) {
      setError(errorMessage(decisionError));
    } finally {
      setDecidingId('');
    }
    await load();
  }, [load]);

  useEffect(() => { void load(); }, [load]);

  const openEntries = useCallback(async (workspaceId: string, path: string) => {
    setSelectedId(workspaceId);
    setEntriesPath(path);
    setEntriesLoading(true);
    setError('');
    try {
      const response = await workspaceConnectorsAPI.entries(workspaceId, path);
      setEntries(Array.isArray(response.directory?.entries) ? response.directory.entries : []);
      setEntriesTruncated(Boolean(response.directory?.truncated));
    } catch (entriesError) {
      setEntries([]);
      setEntriesTruncated(false);
      setError(errorMessage(entriesError));
    } finally {
      setEntriesLoading(false);
    }
  }, []);

  const submitEnrollment = async () => {
    setEnrolling(true);
    setError('');
    setCopied(false);
    try {
      const response = await workspaceConnectorsAPI.enroll(enrollLabel.trim());
      setEnrollment(response.enrollment);
      setEnrollOpen(false);
      setEnrollLabel('');
    } catch (enrollError) {
      setError(errorMessage(enrollError));
    } finally {
      setEnrolling(false);
    }
  };

  const copyCode = async () => {
    if (!enrollment?.code) return;
    try {
      await navigator.clipboard.writeText(enrollment.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const openAgent = async (workspace: WorkspaceConnector, agent: 'codex' | 'claude', account: string, model: string) => {
    setAgentOpening(workspace.id);
    setError('');
    try {
      const result = await workspaceConnectorsAPI.openAgentTerminal(workspace.id, agent, { account, model });
      if (!result.ok || !result.sessionKey) {
        setError('打开 AI 终端失败');
        return;
      }
      manager.openTab({
        sessionKey: result.sessionKey,
        serverId: manager.serverId,
        label: result.label || `${workspace.label} · ${agent}`,
        cwd: result.rootLabel || workspace.rootLabel || '',
        kind: 'shell'
      });
      if (manager.minimized) manager.setMinimized(false);
    } catch (agentError) {
      setError(errorMessage(agentError));
    } finally {
      setAgentOpening('');
    }
  };

  const applyPickerDefaults = useCallback((inventory: RemoteTargetInventory | null, agent: 'codex' | 'claude') => {
    const accounts = (inventory?.accounts || []).filter((item) => item.provider === agent && item.enabled);
    const account = accounts.find((item) => item.effectiveModels > 0) || accounts[0];
    setPickerAccount(account ? (account.cliAccountId || account.accountRef) : '');
    const models = (inventory?.models || []).filter(
      (item) => item.provider === agent && item.accountRef === account?.accountRef && item.effective
    );
    const preferred = models.find((item) => item.catalogModelId === 'gpt-5.6-luna') || models[0];
    setPickerModel(preferred ? (preferred.cliModelName || preferred.catalogModelId) : '');
  }, []);

  const openPicker = useCallback(async (workspace: WorkspaceConnector) => {
    setPickerWorkspace(workspace);
    setPickerError('');
    if (catalog) { applyPickerDefaults(catalog, pickerAgent); return; }
    setCatalogLoading(true);
    try {
      const response = await remoteTargetsAPI.list();
      setCatalog(response.inventory);
      applyPickerDefaults(response.inventory, pickerAgent);
    } catch (catalogError) {
      setPickerError(errorMessage(catalogError));
    } finally {
      setCatalogLoading(false);
    }
  }, [applyPickerDefaults, catalog, pickerAgent]);

  const revoke = async (workspaceId: string) => {
    setError('');
    try {
      await workspaceConnectorsAPI.revoke(workspaceId);
      if (selectedId === workspaceId) {
        setSelectedId('');
        setEntries([]);
        setEntriesPath('');
      }
      await load();
    } catch (revokeError) {
      setError(errorMessage(revokeError));
    }
  };

  const pickerAccounts = (catalog?.accounts || []).filter((item) => item.provider === pickerAgent && item.enabled);
  const pickerAccountFact = pickerAccounts.find((item) => (item.cliAccountId || item.accountRef) === pickerAccount);
  const pickerModels = (catalog?.models || []).filter(
    (item) => item.provider === pickerAgent && item.accountRef === pickerAccountFact?.accountRef && item.effective
  );

  return (
    <section className="ws-connector" aria-label="本地工作区 Connector">
      <div className="ws-connector-head">
        <div className="ws-connector-title">
          <LaptopOutlined aria-hidden="true" />
          <span>本地工作区</span>
          <span className="ws-connector-count">{workspaces.length}</span>
        </div>
        <span className="ws-connector-actions">
          <Tooltip title="生成一次性 code，在本地目录运行 aih workspace connect">
            <Button
              type="text"
              size="small"
              icon={<PlusOutlined />}
              aria-label="登记本地目录"
              onClick={() => setEnrollOpen((value) => !value)}
            />
          </Tooltip>
          <Tooltip title="刷新本地工作区状态">
            <Button
              type="text"
              size="small"
              icon={<ReloadOutlined />}
              aria-label="刷新本地工作区"
              loading={loading}
              onClick={() => void load()}
            />
          </Tooltip>
        </span>
      </div>

      <p className="ws-connector-note">
        目录在本机，模型和 Agent 在 Server；Connector 不持有 Provider 凭据。Codex/Claude 的 AI 终端经 Connector 调用工具；AGY 仍是 PTY-only。
      </p>

      {enrollOpen ? (
        <div className="ws-connector-enroll">
          <Input
            size="small"
            value={enrollLabel}
            placeholder="项目名（可选）"
            maxLength={64}
            onChange={(event) => setEnrollLabel(event.target.value)}
            onPressEnter={() => void submitEnrollment()}
          />
          <Button type="primary" size="small" loading={enrolling} onClick={() => void submitEnrollment()}>
            生成 code
          </Button>
        </div>
      ) : null}

      {enrollment ? (
        <div className="ws-connector-code" role="status">
          <CodeOutlined aria-hidden="true" />
          <code title={enrollment.code}>{enrollment.code}</code>
          <Tooltip title={copied ? '已复制' : '复制 code'}>
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              aria-label="复制 enrollment code"
              onClick={() => void copyCode()}
            />
          </Tooltip>
          <span className="ws-connector-code-note">
            一次性，{formatMoment(enrollment.expiresAt)} 前有效
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="ws-connector-inline-status" data-status="blocked" role="status">
          <span>{error}</span>
          <Button type="link" size="small" onClick={() => void load()}>重试</Button>
        </div>
      ) : null}

      {sessions.length > 0 ? (
        <div className="ws-connector-sessions">
          {sessions.slice(0, 6).map((session) => (
            <div className="ws-connector-session" key={session.id}>
              <span className="ws-connector-session-main">
                <span className="ws-connector-session-title">
                  {session.agent}
                  {session.account ? ` · ${session.account}` : ''}
                  {session.model ? ` · ${session.model}` : ''}
                </span>
                <span className="ws-connector-meta">
                  {session.status} · {session.events?.[session.events.length - 1]?.type || '-'} · {session.workspaceId} · {formatMoment(session.createdAt)}
                </span>
              </span>
              {session.status === 'running' || session.status === 'unknown' ? (
                <Button size="small" loading={stoppingSession === session.id} onClick={() => void stopSession(session.id)}>
                  停止
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {Object.values(approvals).some((items) => items.some((item) => item.state === 'pending')) ? (
        <div className="ws-connector-approvals">
          {Object.entries(approvals).flatMap(([workspaceId, items]) =>
            items.filter((item) => item.state === 'pending').map((item) => (
              <div className="ws-connector-approval" key={item.id}>
                <div className="ws-connector-approval-main">
                  <span className="ws-connector-approval-title">
                    {workspaces.find((workspace) => workspace.id === workspaceId)?.label || workspaceId} · 等待审批
                  </span>
                  <code className="ws-connector-approval-command">{item.command}</code>
                  <span className="ws-connector-meta">
                    cwd: {item.cwd} · {formatMoment(item.expiresAt)} 过期
                  </span>
                </div>
                <span className="ws-connector-row-actions">
                  <Button
                    size="small"
                    type="primary"
                    loading={decidingId === item.id}
                    onClick={() => void decideApproval(workspaceId, item.id, true)}
                  >
                    批准
                  </Button>
                  <Button
                    size="small"
                    danger
                    loading={decidingId === item.id}
                    onClick={() => void decideApproval(workspaceId, item.id, false)}
                  >
                    拒绝
                  </Button>
                </span>
              </div>
            ))
          )}
        </div>
      ) : null}

      {workspaces.length === 0 && !loading ? (
        <p className="ws-connector-empty">
          还没有本地工作区。在目标目录运行 aih workspace connect --root .，或先生成一次性 code。
        </p>
      ) : (
        <ul className="ws-connector-list">
          {workspaces.map((workspace) => (
            <li key={workspace.id} className="ws-connector-row" data-state={workspace.state}>
              <div
                className="ws-connector-row-main"
                title={`${workspace.label} · ${connectorLocation(workspace)}`}
              >
                <span className="ws-connector-copy">
                  <span className="ws-connector-line">
                    <span className="ws-connector-state" data-state={workspace.state}>{connectorStateLabel(workspace.state)}</span>
                    <span className="ws-connector-label">{workspace.label}</span>
                  </span>
                  <span className="ws-connector-meta">{connectorLocation(workspace)}</span>
                  {workspace.state === 'online' ? (
                    <span className="ws-connector-meta">
                      命令执行 {workspace.capabilities?.runCommand ? '已开启' : '已关闭'}
                      {approvalModes[workspace.id] ? ` · 审批 ${approvalModes[workspace.id]}` : ''}
                    </span>
                  ) : null}
                  {workspace.liveLastSeenAt || workspace.lastSeenAt ? (
                    <span className="ws-connector-meta">最近心跳 {formatMoment(workspace.liveLastSeenAt || workspace.lastSeenAt)}</span>
                  ) : null}
                </span>
                <span className="ws-connector-row-actions">
                  <Tooltip title="浏览该目录（只读）">
                    <Button
                      type="text"
                      size="small"
                      icon={selectedId === workspace.id ? <FolderOpenOutlined /> : <FolderOutlined />}
                      aria-label="浏览本地目录"
                      disabled={workspace.state !== 'online'}
                      onClick={() => {
                        if (selectedId === workspace.id) {
                          setSelectedId('');
                          setEntries([]);
                          setEntriesPath('');
                          return;
                        }
                        void openEntries(workspace.id, '');
                      }}
                    />
                  </Tooltip>
                  <Popover
                    trigger="click"
                    open={pickerWorkspace?.id === workspace.id}
                    onOpenChange={(open) => {
                      if (open) {
                        void openPicker(workspace);
                      } else {
                        setPickerWorkspace(null);
                      }
                    }}
                    content={(
                      <div className="ws-connector-picker">
                        <span className="ws-connector-picker-label">Agent</span>
                        <Select
                          size="small"
                          value={pickerAgent}
                          options={[{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }]}
                          onChange={(value: 'codex' | 'claude') => {
                            setPickerAgent(value);
                            applyPickerDefaults(catalog, value);
                          }}
                        />
                        <span className="ws-connector-picker-label">账号</span>
                        <Select
                          size="small"
                          value={pickerAccount || undefined}
                          loading={catalogLoading}
                          placeholder="选择账号"
                          options={pickerAccounts.map((account) => ({
                            value: account.cliAccountId || account.accountRef,
                            label: accountOptionLabel(account)
                          }))}
                          onChange={(value: string) => {
                            setPickerAccount(value);
                            const fact = pickerAccounts.find((item) => (item.cliAccountId || item.accountRef) === value);
                            const models = (catalog?.models || []).filter(
                              (item) => item.provider === pickerAgent && item.accountRef === fact?.accountRef && item.effective
                            );
                            const preferred = models.find((item) => item.catalogModelId === 'gpt-5.6-luna') || models[0];
                            setPickerModel(preferred ? modelOptionValue(preferred) : '');
                          }}
                        />
                        <span className="ws-connector-picker-label">模型</span>
                        <Select
                          size="small"
                          value={pickerModel || undefined}
                          placeholder="选择模型"
                          options={pickerModels.map((model) => ({
                            value: modelOptionValue(model),
                            label: modelOptionLabel(model)
                          }))}
                          onChange={setPickerModel}
                        />
                        {pickerError ? <span className="ws-connector-picker-error">{pickerError}</span> : null}
                        <Button
                          type="primary"
                          size="small"
                          block
                          disabled={!pickerAccount || !pickerModel}
                          loading={agentOpening === workspace.id}
                          onClick={() => void openAgent(workspace, pickerAgent, pickerAccount, pickerModel)}
                        >
                          打开终端
                        </Button>
                      </div>
                    )}
                  >
                    <Button
                      type="text"
                      size="small"
                      icon={<CodeOutlined />}
                      aria-label="打开 AI 终端"
                      title="选择账号和模型后打开 Codex/Claude（工具经 Workspace Connector）"
                      loading={agentOpening === workspace.id}
                      disabled={workspace.state !== 'online'}
                    />
                  </Popover>
                  <Popconfirm
                    title="撤销这个本地工作区？"
                    description="撤销后远程执行不能再用这个目录，需重新登记。"
                    okText="撤销"
                    cancelText="取消"
                    onConfirm={() => void revoke(workspace.id)}
                  >
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label="撤销本地工作区"
                      disabled={workspace.state === 'revoked'}
                    />
                  </Popconfirm>
                </span>
              </div>

              {selectedId === workspace.id ? (
                <div className="ws-connector-entries" aria-label="本地目录内容">
                  <div className="ws-connector-entries-head">
                    <Button
                      type="text"
                      size="small"
                      icon={<RightOutlined rotate={180} />}
                      disabled={!entriesPath || entriesLoading}
                      onClick={() => void openEntries(workspace.id, parentWorkspacePath(entriesPath))}
                    >
                      上一级
                    </Button>
                    <span className="ws-connector-path">/{entriesPath}</span>
                    <Button
                      type="text"
                      size="small"
                      icon={<ReloadOutlined />}
                      aria-label="刷新目录"
                      loading={entriesLoading}
                      onClick={() => void openEntries(workspace.id, entriesPath)}
                    />
                  </div>
                  {entries.length === 0 && !entriesLoading ? (
                    <p className="ws-connector-empty">目录为空或没有可见条目。</p>
                  ) : (
                    <ul className="ws-connector-entry-list">
                      {entries.map((entry) => (
                        <li key={entry.name}>
                          {entry.type === 'dir' ? (
                            <button
                              type="button"
                              className="ws-connector-entry"
                              onClick={() => void openEntries(workspace.id, joinWorkspacePath(entriesPath, entry.name))}
                            >
                              {entryIcon(entry)}
                              <span>{entry.name}</span>
                            </button>
                          ) : (
                            <span className="ws-connector-entry" data-type={entry.type}>
                              {entryIcon(entry)}
                              <span>{entry.name}</span>
                              <span className="ws-connector-entry-size">{formatSize(entry.size)}</span>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {entriesTruncated ? <p className="ws-connector-empty">条目过多，只显示前一部分。</p> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
