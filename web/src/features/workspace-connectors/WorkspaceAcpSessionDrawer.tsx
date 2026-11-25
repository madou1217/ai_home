import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Drawer, Input, Tag, Tooltip } from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  LoadingOutlined,
  RobotOutlined,
  SendOutlined,
  ToolOutlined
} from '@ant-design/icons';
import { workspaceConnectorsAPI } from '@/services/api';
import type {
  WorkspaceAcpApproval,
  WorkspaceAcpEvent,
  WorkspaceAcpSession,
  WorkspaceAcpToolCall,
  WorkspaceConnector
} from './workspace-connectors-model';
import './workspace-connectors.css';

type AcpTimelineItem =
  | { kind: 'user'; text: string }
  | { kind: 'message'; text: string }
  | { kind: 'tool'; call: WorkspaceAcpToolCall }
  | { kind: 'plan'; entries: Array<{ content: string; status?: string }> }
  | { kind: 'approval'; approval: WorkspaceAcpApproval }
  | { kind: 'notice'; title: string; description?: string; severity?: string }
  | { kind: 'status'; text: string; error?: boolean };

interface WorkspaceAcpSessionDrawerProps {
  workspace: WorkspaceConnector | null;
  onClose: () => void;
}

function errorMessage(error: unknown): string {
  const source = error as { response?: { data?: { message?: string; error?: string } }; message?: string } | null;
  return source?.response?.data?.message || source?.response?.data?.error || source?.message || 'ACP 会话暂时不可用';
}

function toolTitle(call: WorkspaceAcpToolCall): string {
  return call.title || call.name || call.id || '工具调用';
}

function toolStatus(call: WorkspaceAcpToolCall): string {
  return call.status || call.kind || '';
}

function applyEvent(items: AcpTimelineItem[], event: WorkspaceAcpEvent): AcpTimelineItem[] {
  switch (event.type) {
    case 'user':
      return [...items, { kind: 'user', text: event.text || '' }].slice(-240);
    case 'message': {
      const last = items[items.length - 1];
      if (last && last.kind === 'message') {
        return [...items.slice(0, -1), { kind: 'message', text: last.text + (event.text || '') }];
      }
      return [...items, { kind: 'message', text: event.text || '' }].slice(-240);
    }
    case 'tool_call':
      return event.toolCall
        ? [...items, { kind: 'tool', call: event.toolCall }].slice(-240)
        : items;
    case 'tool_update': {
      if (!event.toolCall) return items;
      const index = items.findIndex((item) => item.kind === 'tool' && item.call.id === event.toolCall?.id);
      if (index < 0) {
        return [...items, { kind: 'tool', call: event.toolCall }].slice(-240);
      }
      const next = [...items];
      next[index] = { kind: 'tool', call: { ...(next[index] as { call: WorkspaceAcpToolCall }).call, ...event.toolCall } };
      return next;
    }
    case 'plan':
      return [...items, { kind: 'plan', entries: event.plan || [] }].slice(-240);
    case 'approval':
      if (!event.approval) return items;
      {
        const index = items.findIndex((item) => item.kind === 'approval' && item.approval.id === event.approval?.id);
        if (index < 0) {
          return [...items, { kind: 'approval', approval: event.approval }].slice(-240);
        }
        const next = [...items];
        next[index] = { kind: 'approval', approval: event.approval };
        return next;
      }
    case 'notice':
      return event.notice
        ? [...items, { kind: 'notice', title: event.notice.title, description: event.notice.description, severity: event.notice.severity }].slice(-240)
        : items;
    case 'error':
      return [...items, { kind: 'status', text: event.error || 'ACP 会话出错', error: true }].slice(-240);
    case 'status':
      if (!event.status) return items;
      return [...items, { kind: 'status', text: event.status }].slice(-240);
    default:
      return items;
  }
}

export default function WorkspaceAcpSessionDrawer({ workspace, onClose }: WorkspaceAcpSessionDrawerProps) {
  const [session, setSession] = useState<WorkspaceAcpSession | null>(null);
  const [timeline, setTimeline] = useState<AcpTimelineItem[]>([]);
  const [prompt, setPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [deciding, setDeciding] = useState('');
  const [error, setError] = useState('');
  const sourceRef = useRef<EventSource | null>(null);
  const sessionRef = useRef<WorkspaceAcpSession | null>(null);
  const seenSeq = useRef(0);
  const open = Boolean(workspace);

  const closeSource = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  useEffect(() => {
    if (!workspace) return undefined;
    let cancelled = false;
    closeSource();
    setSession(null);
    sessionRef.current = null;
    setTimeline([{ kind: 'status', text: '正在启动 AGY ACP 会话' }]);
    setPrompt('');
    setError('');
    setStarting(true);
    seenSeq.current = 0;

    const attach = (next: WorkspaceAcpSession) => {
      const source = workspaceConnectorsAPI.acpSessionEvents(workspace.id, next.id, 0);
      source.addEventListener('acp', (message) => {
        try {
          const event = JSON.parse((message as MessageEvent).data) as WorkspaceAcpEvent;
          if (!event || typeof event.seq !== 'number' || event.seq <= seenSeq.current) return;
          seenSeq.current = event.seq;
          setTimeline((current) => applyEvent(current, event));
          if (event.type === 'status' && (event.status === 'closed' || event.status === 'error')) {
            setSession((current) => (current ? { ...current, status: event.status || current.status } : current));
          }
        } catch {
          // Ignore malformed frames; EventSource will keep the stream alive.
        }
      });
      source.onerror = () => setError('ACP 事件流已断开，浏览器会自动重连');
      sourceRef.current = source;
    };

    workspaceConnectorsAPI.startAcpSession(workspace.id)
      .then((response) => {
        if (cancelled) {
          if (response?.session) void workspaceConnectorsAPI.closeAcpSession(workspace.id, response.session.id);
          return;
        }
        if (!response?.ok || !response.session) {
          setError('启动 ACP 会话失败');
          return;
        }
        setSession(response.session);
        sessionRef.current = response.session;
        attach(response.session);
      })
      .catch((startError) => {
        if (!cancelled) setError(errorMessage(startError));
      })
      .finally(() => {
        if (!cancelled) setStarting(false);
      });

    return () => {
      cancelled = true;
      closeSource();
      const current = sessionRef.current;
      if (current) {
        void workspaceConnectorsAPI.closeAcpSession(workspace.id, current.id).catch(() => undefined);
      }
      sessionRef.current = null;
    };
  }, [workspace?.id, closeSource]);

  const status = session?.status || (starting ? 'starting' : 'idle');
  const canPrompt = Boolean(session) && !['closed', 'error'].includes(status);

  const sendPrompt = async () => {
    if (!workspace || !session || !prompt.trim() || !canPrompt) return;
    const content = prompt.trim();
    setPrompt('');
    setSending(true);
    setError('');
    try {
      await workspaceConnectorsAPI.sendAcpPrompt(workspace.id, session.id, content);
    } catch (sendError) {
      setError(errorMessage(sendError));
    } finally {
      setSending(false);
    }
  };

  const decideApproval = async (approval: WorkspaceAcpApproval, approve: boolean) => {
    if (!workspace || !session) return;
    setDeciding(approval.id);
    setError('');
    try {
      await workspaceConnectorsAPI.decideAcpApproval(workspace.id, session.id, approval.id, approve);
      setTimeline((current) => current.map((item) => (
        item.kind === 'approval' && item.approval.id === approval.id
          ? { kind: 'approval', approval: { ...item.approval, status: approve ? 'approved' : 'rejected' } }
          : item
      )));
    } catch (decisionError) {
      setError(errorMessage(decisionError));
    } finally {
      setDeciding('');
    }
  };

  const close = () => {
    closeSource();
    const current = sessionRef.current;
    if (workspace && current) {
      void workspaceConnectorsAPI.closeAcpSession(workspace.id, current.id).catch(() => undefined);
    }
    sessionRef.current = null;
    onClose();
  };

  const header = useMemo(() => {
    if (!workspace) return 'AGY ACP';
    return workspace.label + ' · AGY ACP';
  }, [workspace]);

  return (
    <Drawer
      open={open}
      onClose={close}
      width={720}
      destroyOnClose
      title={(
        <span className="workspace-acp-title">
          <RobotOutlined />
          {header}
          <Tag color={status === 'error' ? 'red' : status === 'closed' ? 'default' : 'cyan'}>{status}</Tag>
        </span>
      )}
    >
      <div className="workspace-acp">
        <div className="workspace-acp-timeline">
          {timeline.map((item, index) => {
            if (item.kind === 'user') {
              return <div className="workspace-acp-bubble workspace-acp-bubble--user" key={index}>{item.text}</div>;
            }
            if (item.kind === 'message') {
              return <div className="workspace-acp-bubble workspace-acp-bubble--agent" key={index}>{item.text}</div>;
            }
            if (item.kind === 'tool') {
              return (
                <div className="workspace-acp-card workspace-acp-card--tool" key={index}>
                  <div className="workspace-acp-card-title">
                    <ToolOutlined />
                    <span>{toolTitle(item.call)}</span>
                    {toolStatus(item.call) ? <Tag>{toolStatus(item.call)}</Tag> : null}
                  </div>
                  {item.call.name ? <div className="workspace-acp-muted">{item.call.name}</div> : null}
                </div>
              );
            }
            if (item.kind === 'plan') {
              return (
                <div className="workspace-acp-card" key={index}>
                  <div className="workspace-acp-card-title">计划</div>
                  {item.entries.map((entry, entryIndex) => (
                    <div className="workspace-acp-plan-row" key={entryIndex}>
                      <span>{entry.content}</span>
                      <span className="workspace-acp-muted">{entry.status || ''}</span>
                    </div>
                  ))}
                </div>
              );
            }
            if (item.kind === 'approval') {
              const pending = item.approval.status === 'pending';
              return (
                <div className={pending ? 'workspace-acp-approval is-pending' : 'workspace-acp-approval'} key={index}>
                  <div className="workspace-acp-card-title">
                    <CheckOutlined />
                    <span>需要审批：{item.approval.title || item.approval.toolCallId}</span>
                    <Tag>{item.approval.status}</Tag>
                  </div>
                  <div className="workspace-acp-approval-actions">
                    <Button
                      size="small"
                      type="primary"
                      disabled={!pending || deciding === item.approval.id}
                      loading={deciding === item.approval.id}
                      onClick={() => void decideApproval(item.approval, true)}
                    >允许一次</Button>
                    <Button
                      size="small"
                      danger
                      disabled={!pending || deciding === item.approval.id}
                      onClick={() => void decideApproval(item.approval, false)}
                    >拒绝</Button>
                  </div>
                </div>
              );
            }
            if (item.kind === 'notice') {
              return (
                <div className="workspace-acp-notice" key={index}>
                  <strong>{item.title}</strong>
                  {item.description ? <span>{item.description}</span> : null}
                </div>
              );
            }
            return (
              <div className={item.error ? 'workspace-acp-status is-error' : 'workspace-acp-status'} key={index}>
                {item.text}
              </div>
            );
          })}
          {starting ? (
            <div className="workspace-acp-status">
              <LoadingOutlined /> 正在启动 ACP
            </div>
          ) : null}
        </div>
        <div className="workspace-acp-composer">
          {error ? <div className="workspace-acp-error">{error}</div> : null}
          <Input.TextArea
            value={prompt}
            onChange={(changeEvent) => setPrompt(changeEvent.target.value)}
            placeholder="向 AGY 发送一轮需求；工具调用和审批会实时出现"
            autoSize={{ minRows: 2, maxRows: 6 }}
            disabled={!canPrompt}
            onPressEnter={(keyEvent) => {
              if (!keyEvent.shiftKey) {
                keyEvent.preventDefault();
                void sendPrompt();
              }
            }}
          />
          <div className="workspace-acp-composer-actions">
            <span className="workspace-acp-muted">Enter 发送 · Shift+Enter 换行</span>
            <Tooltip title="关闭会话">
              <Button icon={<CloseOutlined />} onClick={close} />
            </Tooltip>
            <Button
              type="primary"
              icon={<SendOutlined />}
              loading={sending}
              disabled={!canPrompt || !prompt.trim()}
              onClick={() => void sendPrompt()}
            >发送</Button>
          </div>
        </div>
      </div>
    </Drawer>
  );
}
