import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  CloudServerOutlined,
  DeploymentUnitOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  StopOutlined
} from '@ant-design/icons';
import { remoteTargetsAPI } from '@/services/api';
import type {
  RemotePreflightReport,
  RemoteTargetCandidate,
  RemoteTargetInventory,
  RemoteTargetQuery,
  RemoteTargetStageStatus
} from './remote-targets-model';
import {
  modelLabel,
  preflightStatus,
  stageLabel,
  stageStatusLabel,
  statusLabel
} from './remote-targets-model';
import './remote-targets.css';

type PanelState = 'idle' | 'loading' | 'ready' | 'error';

interface RemoteTargetPanelProps {
  workspaceId?: string;
}

function stageIcon(status: RemoteTargetStageStatus) {
  if (status === 'ok') return <CheckCircleOutlined />;
  if (status === 'unsupported') return <StopOutlined />;
  return <ExclamationCircleOutlined />;
}

function targetSelector(candidate: RemoteTargetCandidate): RemoteTargetQuery {
  return {
    serverId: candidate.serverId,
    workspaceId: candidate.workspace.id,
    connectionId: candidate.workspace.connectionId,
    harness: candidate.runner.id,
    provider: candidate.model.provider,
    accountRef: candidate.account.accountRef,
    model: candidate.model.catalogModelId
  };
}

function errorMessage(error: unknown): string {
  const source = error as { response?: { data?: { message?: string; error?: string } }; message?: string } | null;
  return source?.response?.data?.message
    || source?.response?.data?.error
    || source?.message
    || '远程目标目录暂时不可用';
}

function PreflightStages({ report }: { report: RemotePreflightReport }) {
  return (
    <ul className="remote-target-preflight" aria-label="远程目标预检阶段">
      {report.stages.map((stage) => (
        <li key={stage.name} className="remote-target-stage" data-status={stage.status}>
          <span className="remote-target-stage-icon" aria-hidden="true">{stageIcon(stage.status)}</span>
          <span className="remote-target-stage-name">{stageLabel(stage.name)}</span>
          <span className="remote-target-stage-status">{stageStatusLabel(stage.status)}</span>
          {stage.detail ? <span className="remote-target-stage-detail">{stage.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export default function RemoteTargetPanel({ workspaceId }: RemoteTargetPanelProps = {}) {
  const [candidates, setCandidates] = useState<RemoteTargetCandidate[]>([]);
  const [serverId, setServerId] = useState('');
  const [inventory, setInventory] = useState<RemoteTargetInventory>({ workspaceCount: 0, runnerCount: 0, accountCount: 0, modelCount: 0, workspaces: [], runners: [], accounts: [], models: [] });
  const [state, setState] = useState<PanelState>('idle');
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [selectedReport, setSelectedReport] = useState<RemotePreflightReport | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);

  const query = useMemo<RemoteTargetQuery>(() => (
    workspaceId ? { workspaceId } : {}
  ), [workspaceId]);

  const load = useCallback(async () => {
    setState('loading');
    setError('');
    try {
      const response = await remoteTargetsAPI.list(query);
      setCandidates(Array.isArray(response.candidates) ? response.candidates : []);
      setServerId(String(response.serverId || ''));
      setInventory(response.inventory || { workspaceCount: 0, runnerCount: 0, accountCount: 0, modelCount: 0, workspaces: [], runners: [], accounts: [], models: [] });
      setState('ready');
    } catch (loadError) {
      setCandidates([]);
      setServerId('');
      setInventory({ workspaceCount: 0, runnerCount: 0, accountCount: 0, modelCount: 0, workspaces: [], runners: [], accounts: [], models: [] });
      setError(errorMessage(loadError));
      setState('error');
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  const selectedCandidate = candidates.find((candidate) => candidate.id === selectedId) || null;

  const runPreflight = useCallback(async (candidate: RemoteTargetCandidate) => {
    setSelectedId(candidate.id);
    setPreflightLoading(true);
    setError('');
    try {
      const response = await remoteTargetsAPI.preflight(targetSelector(candidate));
      setSelectedReport(response.resolution?.preflight || candidate.preflight);
    } catch (preflightError) {
      setSelectedReport(candidate.preflight);
      setError(errorMessage(preflightError));
    } finally {
      setPreflightLoading(false);
    }
  }, []);

  return (
    <section className="remote-targets" aria-label="远程执行目标">
      <div className="remote-targets-head">
        <div className="remote-targets-title">
          <DeploymentUnitOutlined aria-hidden="true" />
          <span>远程执行目标</span>
          <span className="remote-targets-count">{candidates.length}</span>
        </div>
        <Button
          type="text"
          size="small"
          icon={<ReloadOutlined />}
          aria-label="刷新远程执行目标"
          title="从当前 AIH Server 刷新"
          loading={state === 'loading'}
          onClick={() => void load()}
        />
      </div>
      <div className="remote-targets-origin">
        <CloudServerOutlined aria-hidden="true" />
        <span>{serverId ? `Server ${serverId}` : '当前 Server'}</span>
        <span className="remote-targets-origin-note">只读取远端目录；失败不会回退到本机模型</span>
      </div>

      {state === 'error' ? (
        <div className="remote-targets-inline-status" data-status="blocked" role="status">
          <ExclamationCircleOutlined aria-hidden="true" />
          <span>{error}</span>
          <Button type="link" size="small" onClick={() => void load()}>重试</Button>
        </div>
      ) : null}

      {state === 'ready' && candidates.length === 0 ? (
        <div className="remote-targets-empty">
          <span>当前没有可执行候选。</span>
          <span className="remote-targets-inventory">Workspace {inventory.workspaceCount} · Harness {inventory.runnerCount} · Account {inventory.accountCount} · Model {inventory.modelCount}</span>
          <span>请先确认远端账号模型目录和 Harness 能力都已登记。</span>
        </div>
      ) : null}

      {candidates.length > 0 ? (
        <ul className="remote-targets-list">
          {candidates.map((candidate) => {
            const status = preflightStatus(candidate.preflight);
            return (
              <li key={candidate.id} className="remote-target-row" data-selected={selectedId === candidate.id || undefined}>
                <div className="remote-target-row-main">
                  <span className="remote-target-row-icon" aria-hidden="true"><CloudServerOutlined /></span>
                  <span className="remote-target-row-copy">
                    <span className="remote-target-row-primary">
                      <strong>{candidate.workspace.label}</strong>
                      <span className="remote-target-chip">{candidate.runner.id}</span>
                      <span className="remote-target-chip">{candidate.model.provider}</span>
                    </span>
                    <span className="remote-target-row-secondary">
                      {candidate.account.accountRef} · {modelLabel(candidate.model)} · {candidate.workspace.remoteRoot}
                    </span>
                  </span>
                  <span className="remote-target-status" data-status={status}>{statusLabel(status)}</span>
                </div>
                <div className="remote-target-row-actions">
                  <Tooltip title="查看每个阶段的远程能力预检">
                    <Button
                      type="text"
                      size="small"
                      icon={<DeploymentUnitOutlined />}
                      loading={preflightLoading && selectedId === candidate.id}
                      onClick={() => void runPreflight(candidate)}
                    >
                      预检
                    </Button>
                  </Tooltip>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {selectedCandidate && selectedReport ? (
        <div className="remote-target-detail" aria-live="polite">
          <div className="remote-target-detail-head">
            <span>目标 {selectedCandidate.id}</span>
            <span
              className="remote-target-detail-summary"
              data-status={preflightStatus(selectedReport)}
            >
              {statusLabel(preflightStatus(selectedReport))}
            </span>
          </div>
          <PreflightStages report={selectedReport} />
        </div>
      ) : null}

      {error && state !== 'error' ? (
        <div className="remote-targets-inline-status" data-status="blocked" role="status">
          <ExclamationCircleOutlined aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}
    </section>
  );
}
