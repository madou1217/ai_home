import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Empty } from 'antd';
import { BranchesOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { ChatMessage, Provider } from '@/types';
import { sessionsAPI } from '@/services/api';
import EventBlock from './EventBlock';
import {
  getSubagentStatusPresentation,
  shouldLoadSubagentTranscript,
  type SubagentTranscriptLoadState
} from './subagent-thread-state';
import styles from './SubagentThreadBlock.module.css';

interface Props {
  description: string;
  prompt?: string;
  childSessionId: string;
  agentNickname?: string;
  taskStatus?: string;
  updatedAt?: number;
  provider: Provider;
  projectDirName?: string;
  mobile?: boolean;
  renderMessage: (message: ChatMessage, index: number) => ReactNode;
}

function formatUpdatedAt(updatedAt?: number) {
  const timestamp = Number(updatedAt) || 0;
  if (!timestamp) return '';
  const date = dayjs(timestamp);
  return date.isValid() ? date.format('MM-DD HH:mm') : '';
}

function SubagentThreadBlock({
  description,
  prompt = '',
  childSessionId,
  agentNickname = '',
  taskStatus = '',
  updatedAt = 0,
  provider,
  projectDirName,
  mobile = false,
  renderMessage
}: Props) {
  const [open, setOpen] = useState(false);
  const [loadState, setLoadState] = useState<SubagentTranscriptLoadState>('idle');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const requestVersionRef = useRef(0);

  useEffect(() => {
    requestVersionRef.current += 1;
    setOpen(false);
    setLoadState('idle');
    setMessages([]);
  }, [childSessionId]);

  const loadTranscript = useCallback(async (force = false) => {
    if (!force && !shouldLoadSubagentTranscript(true, loadState)) return;
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    setLoadState('loading');
    try {
      const nextMessages = await sessionsAPI.getSessionMessages(
        provider,
        childSessionId,
        projectDirName
      );
      if (requestVersionRef.current !== requestVersion) return;
      setMessages(Array.isArray(nextMessages) ? nextMessages : []);
      setLoadState('loaded');
    } catch (_error) {
      if (requestVersionRef.current !== requestVersion) return;
      setLoadState('error');
    }
  }, [childSessionId, loadState, projectDirName, provider]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) void loadTranscript();
  }, [loadTranscript]);

  const handleRetry = useCallback(() => {
    void loadTranscript(true);
  }, [loadTranscript]);

  const status = useMemo(
    () => getSubagentStatusPresentation(taskStatus, loadState),
    [loadState, taskStatus]
  );
  const updatedAtLabel = useMemo(() => formatUpdatedAt(updatedAt), [updatedAt]);
  const meta = useMemo(() => {
    const values = [agentNickname, updatedAtLabel];
    if (loadState === 'loaded') values.push(`${messages.length} 条消息`);
    return values.filter(Boolean);
  }, [agentNickname, loadState, messages.length, updatedAtLabel]);

  return (
    <EventBlock
      tone="plan"
      icon={<BranchesOutlined />}
      title={`子代理 · ${description}`}
      meta={meta.length > 0 ? <span className={styles.meta}>{meta.join(' · ')}</span> : undefined}
      status={status}
      collapsible
      open={open}
      onOpenChange={handleOpenChange}
      dense={mobile}
      aria-label={`子代理 ${description}`}
    >
      {prompt ? (
        <div className={styles.prompt}>
          {prompt.length > 400 ? `${prompt.slice(0, 400)}…` : prompt}
        </div>
      ) : null}
      {loadState === 'idle' ? (
        <div className={styles.empty}>展开后加载完整子线程内容。</div>
      ) : null}
      {loadState === 'loading' ? (
        <div className={styles.loading} role="status">正在加载完整子线程…</div>
      ) : null}
      {loadState === 'error' ? (
        <div className={styles.error} role="alert">
          <span>子线程加载失败。</span>
          <Button type="link" size="small" onClick={handleRetry}>重试</Button>
        </div>
      ) : null}
      {loadState === 'loaded' && messages.length === 0 ? (
        <div className={styles.empty}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该子线程暂无可显示内容" />
        </div>
      ) : null}
      {loadState === 'loaded' && messages.length > 0 ? (
        <div className={styles.transcript} data-subagent-session-id={childSessionId}>
          {messages.map(renderMessage)}
        </div>
      ) : null}
    </EventBlock>
  );
}

export default SubagentThreadBlock;
