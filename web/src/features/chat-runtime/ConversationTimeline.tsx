import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Empty, message as toast } from 'antd';
import Button from '@/components/ui/AppButton';
import type {
  SessionProjection,
  SessionRuntimeController,
  TimelineItem,
} from '@/chat-runtime';
import { useSessionSelector } from '@/chat-runtime';
import type { Provider } from '@/types';
import FileDrawer, { type FileDrawerTab } from '@/components/chat/FileDrawer';
import { basenameLike, getFileTabKey } from '@/components/chat/file-reference-utils';
import { formatStreamFailureText } from '@/components/chat/provider-pending-policy.js';
import chatStyles from '@/components/chat/chat.module.css';
import type { CommittedTimelineObserver } from './browser-first-text-paint-probe';
import { sessionConnectionPresentation } from './session-connection-presentation';
import TimelineItemView from './TimelineItemView';
import styles from './session-runtime.module.css';

interface Props {
  readonly controller: SessionRuntimeController;
  readonly firstTextPaintProbe: CommittedTimelineObserver;
  readonly provider: Provider;
  readonly projectPath: string;
  readonly mobile?: boolean;
}

export default function ConversationTimeline({
  controller,
  firstTextPaintProbe,
  provider,
  projectPath,
  mobile = false,
}: Props) {
  const items = useSessionSelector(controller.store, selectItems);
  const hasMore = useSessionSelector(controller.store, selectHasMore);
  const streamFailure = useSessionSelector(controller.store, selectStreamFailure);
  const gap = useSessionSelector(controller.store, selectGap);
  const connectionState = useSessionSelector(controller.store, selectConnectionState);
  const connection = sessionConnectionPresentation(connectionState);
  const viewport = useTimelineViewport(controller, items);
  const preview = useTimelineFilePreview(projectPath);
  useLayoutEffect(() => {
    firstTextPaintProbe.observeCommittedTimeline(items);
  }, [firstTextPaintProbe, items]);

  return (
    <>
      <div
        ref={viewport.containerRef}
        className={`${styles.timeline} ${chatStyles.messageSurface} ${mobile ? chatStyles.messageSurfaceMobile : ''}`}
        onScroll={viewport.handleScroll}
      >
      {hasMore ? (
        <div className={styles.loadEarlier}>
          <Button size="small" loading={viewport.loadingEarlier} onClick={() => void viewport.loadEarlier()}>
            加载更早记录
          </Button>
        </div>
      ) : null}
      {connection.notice ? <RuntimeNotice text={connection.notice} sticky /> : null}
      {gap && connectionState !== 'resyncing'
        ? <RuntimeNotice text="事件序列正在重新同步…" />
        : null}
      {streamFailure ? (
        <RuntimeNotice
          text={formatStreamFailureText(streamFailure, provider)}
          danger={!streamFailure.retryable}
        />
      ) : null}
      {items.length === 0 ? (
        <Empty
          className={styles.emptyTimeline}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<span>开始一次原生会话，计划、工具和审批会实时出现在这里</span>}
        />
      ) : items.map((item) => (
        <TimelineItemView
          key={item.id}
          item={item}
          provider={provider}
          projectPath={projectPath}
          onOpenFile={preview.openFile}
          mobile={mobile}
        />
      ))}
      </div>
      <FileDrawer
        open={preview.open}
        tabs={preview.tabs}
        activeKey={preview.activeKey}
        onClose={preview.close}
        onChangeTab={preview.setActiveKey}
      />
    </>
  );
}

function useTimelineFilePreview(projectPath: string) {
  const [tabs, setTabs] = useState<FileDrawerTab[]>([]);
  const [activeKey, setActiveKey] = useState('');
  const [open, setOpen] = useState(false);
  const openFile = useCallback((filePath: string): void => {
    setTabs((current) => current.some((tab) => tab.path === filePath)
      ? current
      : [...current, { path: filePath, title: basenameLike(filePath), projectPath }]);
    setActiveKey(getFileTabKey(filePath));
    setOpen(true);
  }, [projectPath]);
  const close = useCallback(() => setOpen(false), []);
  return { activeKey, close, open, openFile, setActiveKey, tabs };
}

function useTimelineViewport(
  controller: SessionRuntimeController,
  items: readonly TimelineItem[],
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [items]);

  const handleScroll = useCallback((): void => {
    const container = containerRef.current;
    if (!container) return;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    stickToBottomRef.current = distance < 96;
  }, []);

  const loadEarlier = useCallback(async (): Promise<void> => {
    const container = containerRef.current;
    const previousHeight = container?.scrollHeight || 0;
    setLoadingEarlier(true);
    try {
      await controller.loadEarlier();
      requestAnimationFrame(() => {
        if (container) container.scrollTop += container.scrollHeight - previousHeight;
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载更早记录失败');
    } finally {
      setLoadingEarlier(false);
    }
  }, [controller]);
  return { containerRef, loadingEarlier, handleScroll, loadEarlier };
}

function RuntimeNotice({
  text,
  danger = false,
  sticky = false,
}: {
  text: string;
  danger?: boolean;
  sticky?: boolean;
}) {
  return (
    <div
      className={styles.runtimeNotice}
      data-danger={danger}
      data-sticky={sticky}
      role="status"
      aria-live="polite"
    >
      {text}
    </div>
  );
}

function selectItems(projection: SessionProjection): readonly TimelineItem[] {
  return projection.items;
}

function selectHasMore(projection: SessionProjection): boolean {
  return projection.timelineHasMore;
}

function selectStreamFailure(projection: SessionProjection): SessionProjection['streamFailure'] {
  return projection.streamFailure;
}

function selectGap(projection: SessionProjection): SessionProjection['gap'] {
  return projection.gap;
}

function selectConnectionState(projection: SessionProjection): SessionProjection['connectionState'] {
  return projection.connectionState;
}
