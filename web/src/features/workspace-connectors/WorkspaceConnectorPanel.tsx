import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Popconfirm, Tooltip } from 'antd';
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
import { workspaceConnectorsAPI } from '@/services/api';
import type {
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

function entryIcon(entry: WorkspaceDirectoryEntry) {
  if (entry.type === 'dir') return <FolderOutlined />;
  if (entry.type === 'symlink') return <LinkOutlined />;
  return <FileOutlined />;
}

export default function WorkspaceConnectorPanel() {
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

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await workspaceConnectorsAPI.list();
      setWorkspaces(Array.isArray(response.workspaces) ? response.workspaces : []);
    } catch (loadError) {
      setWorkspaces([]);
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

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
        目录在本机，模型和 Agent 在 Server；Connector 不持有 Provider 凭据。
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
