import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Empty from 'antd/es/empty';
import ShellTerminalPanel from '@/components/chat/ShellTerminalPanel';
import Button from '@/components/ui/AppButton';
import type { Session } from '@/types';
import BrowserPanel from './browser/BrowserPanel';
import FilesPanel from './files/FilesPanel';
import ReviewPanel from './review/ReviewPanel';
import SessionsPanel from './sessions/SessionsPanel';
import type { ColumnDivider, ColumnWidths } from './workbench-layout';
import { applyDividerDrag, clampColumnWidths, DIVIDER_WIDTH } from './workbench-layout';
import { loadColumnWidths, saveColumnWidths } from './workbench-layout-persistence';
import { PANEL_LABELS } from './workbench-types';
import styles from './project-workbench.module.css';

interface Props {
  projectPath?: string;
  chat: ReactNode;
  // 左栏 Sessions 页签数据：来自 Chat.tsx 的 canonicalDirectory.projects（只读复用）。
  sessions?: readonly Session[];
  selectedSession?: Session | null;
  runningSessionKeys?: Set<string>;
  onSelectSession?: (session: Session) => void;
}

type LeftPane = 'files' | 'review' | 'sessions';
type RightPane = 'terminal' | 'review' | 'browser';

const LEFT_PANES: readonly LeftPane[] = ['files', 'review', 'sessions'];
const RIGHT_PANES: readonly RightPane[] = ['terminal', 'review', 'browser'];
// 'sessions' 不在 WorkbenchPanelKind（不开标签页），页签文案就地补充。
const PANE_LABELS: Record<LeftPane | RightPane, string> = { ...PANEL_LABELS, sessions: 'Sessions' };

// 栏内小标签：复用面板语义（PANEL_LABELS），仅切换显隐、不动面板内部逻辑。
function PaneTabs<K extends string>({ panes, active, onSelect, ariaLabel }: {
  panes: readonly K[];
  active: K;
  onSelect: (pane: K) => void;
  ariaLabel: string;
}) {
  return (
    <div className={styles.columnTabs} role="tablist" aria-label={ariaLabel}>
      {panes.map((pane) => (
        <button
          key={pane}
          type="button"
          role="tab"
          aria-selected={pane === active}
          className={`${styles.columnTab} ${pane === active ? styles.columnTabActive : ''}`}
          onClick={() => onSelect(pane)}
        >
          {PANE_LABELS[pane as LeftPane | RightPane]}
        </button>
      ))}
    </div>
  );
}

// PC 三栏布局：左=文件/变更，中=会话，右=终端/变更/浏览器。
// 面板一律「首次访问后常驻挂载 + CSS 显隐」，避免树状态丢失与终端 xterm 重复 init。
export default function WorkbenchColumns({
  projectPath,
  chat,
  sessions = [],
  selectedSession = null,
  runningSessionKeys,
  onSelectSession,
}: Props) {
  const [widths, setWidths] = useState<ColumnWidths>(loadColumnWidths);
  const [leftPane, setLeftPane] = useState<LeftPane>('files');
  const [rightPane, setRightPane] = useState<RightPane>('terminal');
  const [terminalOpen, setTerminalOpen] = useState(true);
  // 懒挂载标记：非默认面板首次激活后才挂载，之后常驻保活。
  const [leftReviewMounted, setLeftReviewMounted] = useState(false);
  const [rightReviewMounted, setRightReviewMounted] = useState(false);
  const [browserMounted, setBrowserMounted] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ divider: ColumnDivider; startX: number; start: ColumnWidths } | null>(null);
  const widthsRef = useRef(widths);
  widthsRef.current = widths;

  const availableWidth = useCallback(() => {
    const el = containerRef.current;
    return el ? el.clientWidth - DIVIDER_WIDTH * 2 : 0;
  }, []);

  // 拖拽分隔条调宽：移动中实时钳制，松手时持久化（模式同 ShellTerminalPanel 调高拖拽）。
  const onDividerDown = useCallback((divider: ColumnDivider) => (event: React.MouseEvent) => {
    event.preventDefault();
    dragRef.current = { divider, startX: event.clientX, start: widthsRef.current };
    const onMove = (ev: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const available = availableWidth();
      if (available <= 0) return;
      setWidths(applyDividerDrag(drag.start, drag.divider, ev.clientX - drag.startX, available));
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      saveColumnWidths(widthsRef.current);
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [availableWidth]);

  // 窗口变窄时回收侧栏宽度，保证中栏最小可用宽度。
  useEffect(() => {
    const onResize = () => {
      const available = availableWidth();
      if (available > 0) setWidths((prev) => clampColumnWidths(prev, available));
    };
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, [availableWidth]);

  const selectLeftPane = useCallback((pane: LeftPane) => {
    setLeftPane(pane);
    if (pane === 'review') setLeftReviewMounted(true);
  }, []);

  const selectRightPane = useCallback((pane: RightPane) => {
    setRightPane(pane);
    if (pane === 'review') setRightReviewMounted(true);
    if (pane === 'browser') setBrowserMounted(true);
  }, []);

  // 终端面板被用户关闭：回收 PTY，右栏落到可用的次选面板。
  const closeTerminal = useCallback(() => {
    setTerminalOpen(false);
    setRightPane((pane) => (pane === 'terminal' ? 'review' : pane));
    setRightReviewMounted(true);
  }, []);

  const paneProps = (active: boolean) => ({
    className: `${styles.columnPane} ${active ? styles.columnPaneActive : ''}`,
    'aria-hidden': !active,
    ...(!active ? { inert: '' } : {}),
  });

  return (
    <div
      ref={containerRef}
      className={styles.columnsLayout}
      style={{ gridTemplateColumns: `${widths.left}px ${DIVIDER_WIDTH}px minmax(0, 1fr) ${DIVIDER_WIDTH}px ${widths.right}px` }}
    >
      <aside className={styles.columnSide}>
        <PaneTabs panes={LEFT_PANES} active={leftPane} onSelect={selectLeftPane} ariaLabel="资源栏" />
        <div className={styles.columnBody}>
          {projectPath ? (
            <>
              <div {...paneProps(leftPane === 'files')}>
                <FilesPanel projectPath={projectPath} />
              </div>
              {leftReviewMounted ? (
                <div {...paneProps(leftPane === 'review')}>
                  <ReviewPanel projectPath={projectPath} />
                </div>
              ) : null}
              {/* Sessions 是纯 props 渲染的只读列表，无内部重请求，常驻挂载即可。 */}
              <div {...paneProps(leftPane === 'sessions')}>
                <SessionsPanel
                  sessions={sessions}
                  selectedSession={selectedSession}
                  runningSessionKeys={runningSessionKeys}
                  onSelectSession={(session) => onSelectSession?.(session)}
                />
              </div>
            </>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先选择项目" />
          )}
        </div>
      </aside>
      <div
        className={styles.columnDivider}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整左栏宽度"
        onMouseDown={onDividerDown('left')}
      />
      <section className={styles.columnCenter}>{chat}</section>
      <div
        className={styles.columnDivider}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整右栏宽度"
        onMouseDown={onDividerDown('right')}
      />
      <aside className={styles.columnSide}>
        <PaneTabs panes={RIGHT_PANES} active={rightPane} onSelect={selectRightPane} ariaLabel="工具栏" />
        <div className={styles.columnBody}>
          {terminalOpen ? (
            <div {...paneProps(rightPane === 'terminal')}>
              <ShellTerminalPanel visible cwd={projectPath} onClose={closeTerminal} />
            </div>
          ) : null}
          {!terminalOpen && rightPane === 'terminal' ? (
            <div className={styles.columnReopen}>
              <Button size="small" onClick={() => setTerminalOpen(true)}>打开终端</Button>
            </div>
          ) : null}
          {rightReviewMounted ? (
            <div {...paneProps(rightPane === 'review')}>
              {projectPath ? (
                <ReviewPanel projectPath={projectPath} />
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先选择项目" />
              )}
            </div>
          ) : null}
          {browserMounted ? (
            <div {...paneProps(rightPane === 'browser')}>
              <BrowserPanel />
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
