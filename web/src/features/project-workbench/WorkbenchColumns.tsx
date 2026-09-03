import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Empty from 'antd/es/empty';
import { BranchesOutlined, CloseOutlined, LeftOutlined, MenuFoldOutlined, MenuUnfoldOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import ShellTerminalPanel from '@/components/chat/ShellTerminalPanel';
import Button from '@/components/ui/AppButton';
import type { GitSummary } from '@/services/api';
import type { Session } from '@/types';
import BrowserPanel from './browser/BrowserPanel';
import FilesPanel from './files/FilesPanel';
import ReviewPanel from './review/ReviewPanel';
import SessionsPanel from './sessions/SessionsPanel';
import type { ColumnCollapsed, ColumnDivider, ColumnWidths } from './workbench-layout';
import { applyDividerDrag, clampColumnWidths, COLLAPSED_COLUMN_WIDTH, DIVIDER_WIDTH, resolveColumnVisibility } from './workbench-layout';
import { loadColumnLayout, saveColumnLayout } from './workbench-layout-persistence';
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

// 栏工具行：左侧 segmented 胶囊 tab，右侧内联当前面板的动作区（消除面板内重复标题栏）。
function ColumnToolbar<K extends string>({ panes, active, onSelect, ariaLabel, actions }: {
  panes: readonly K[];
  active: K;
  onSelect: (pane: K) => void;
  ariaLabel: string;
  actions?: ReactNode;
}) {
  return (
    <div className={styles.columnToolbar}>
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
      {actions ? <div className={styles.columnToolbarActions}>{actions}</div> : null}
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
  // 期望宽度基准：仅用户拖拽会改它（持久化的也是它）；resize/可见性变化不改，
  // 渲染宽度由 clamp(desired, available, visibility) 派生——容器变宽自动恢复，消除单向棘轮。
  // 折叠态与宽度同一持久化记录：左右栏默认折叠，收成栏头条（chevron + 纵向标签）。
  const [initialLayout] = useState(loadColumnLayout);
  const [desired, setDesired] = useState<ColumnWidths>(initialLayout.widths);
  const [collapsed, setCollapsed] = useState<ColumnCollapsed>(initialLayout.collapsed);
  const [leftPane, setLeftPane] = useState<LeftPane>('files');
  const [rightPane, setRightPane] = useState<RightPane>('terminal');
  const [terminalOpen, setTerminalOpen] = useState(true);
  // 容器实测宽度：驱动栏可见性降级（0 = 首帧未测量，策略层按三栏全显兜底）。
  const [containerWidth, setContainerWidth] = useState(0);
  // 显式 overlay：栏被策略隐藏后用户可重新打开，覆盖层不占网格宽度。
  const [columnOverlay, setColumnOverlay] = useState<'left' | 'right' | null>(null);
  // 懒挂载标记：非默认面板首次激活后才挂载，之后常驻保活。
  const [leftReviewMounted, setLeftReviewMounted] = useState(false);
  const [rightReviewMounted, setRightReviewMounted] = useState(false);
  const [browserMounted, setBrowserMounted] = useState(false);

  // 栏工具行动作区：面板通过回调注册刷新/上报分支，栏头按当前 pane 内联展示。
  const filesRefreshRef = useRef<(() => void) | null>(null);
  const leftReviewRefreshRef = useRef<(() => void) | null>(null);
  const rightReviewRefreshRef = useRef<(() => void) | null>(null);
  const [leftReviewSummary, setLeftReviewSummary] = useState<GitSummary | null>(null);
  const [rightReviewSummary, setRightReviewSummary] = useState<GitSummary | null>(null);
  const registerFilesRefresh = useCallback((refresh: () => void) => { filesRefreshRef.current = refresh; }, []);
  const registerLeftReviewRefresh = useCallback((refresh: () => void) => { leftReviewRefreshRef.current = refresh; }, []);
  const registerRightReviewRefresh = useCallback((refresh: () => void) => { rightReviewRefreshRef.current = refresh; }, []);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ divider: ColumnDivider; startX: number; start: ColumnWidths } | null>(null);

  // 栏可见性三档：全显 / 隐藏右栏 / 只剩中栏（阈值见 workbench-layout-policy）。
  const visibility = resolveColumnVisibility(containerWidth);
  // 折叠的栏不参与宽度预算与分隔条：渲染为固定宽度栏头条，期望值保留待展开恢复。
  const shown = { left: visibility.left && !collapsed.left, right: visibility.right && !collapsed.right };
  // 渲染宽度 = 期望宽度按当前容器与可见性钳制。预算只扣可见栏的分隔条；
  // 隐藏的栏不占预算也不被改写（clamp 策略层保证），恢复可见时自动回到期望值。
  const available = containerWidth
    - DIVIDER_WIDTH * ((shown.left ? 1 : 0) + (shown.right ? 1 : 0));
  const widths = clampColumnWidths(desired, available, shown);
  const widthsRef = useRef(widths);
  widthsRef.current = widths;
  const desiredRef = useRef(desired);
  desiredRef.current = desired;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const availableWidth = useCallback(() => {
    const el = containerRef.current;
    if (!el) return 0;
    const current = shownRef.current;
    return el.clientWidth - DIVIDER_WIDTH * ((current.left ? 1 : 0) + (current.right ? 1 : 0));
  }, []);

  // 拖拽分隔条调宽：移动中实时钳制并直接写期望宽度（用户显式拖拽是最高优先级），
  // 松手时持久化期望值（模式同 ShellTerminalPanel 调高拖拽）。
  const onDividerDown = useCallback((divider: ColumnDivider) => (event: React.MouseEvent) => {
    event.preventDefault();
    dragRef.current = { divider, startX: event.clientX, start: widthsRef.current };
    const onMove = (ev: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const availableNow = availableWidth();
      if (availableNow <= 0) return;
      setDesired(applyDividerDrag(drag.start, drag.divider, ev.clientX - drag.startX, availableNow));
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      saveColumnLayout({ widths: desiredRef.current, collapsed: collapsedRef.current });
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [availableWidth]);

  // 观察容器实测宽度：驱动栏可见性降级与渲染宽度重算。用 ResizeObserver 而非
  // window resize：项目列表列开合也会改变工作台容器宽度。栏本身保持挂载，
  // 只切换显隐/overlay，终端 PTY 不回收。宽度萎缩/恢复由 clamp 派生完成，无需在此写回。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const syncWidth = () => setContainerWidth(el.clientWidth);
    syncWidth();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', syncWidth);
      return () => window.removeEventListener('resize', syncWidth);
    }
    const observer = new ResizeObserver(syncWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const leftOverlayActive = !visibility.left && columnOverlay === 'left';
  const rightOverlayActive = !visibility.right && columnOverlay === 'right';

  // 显式打开的 overlay 不被 resize 自动收回；仅当栏恢复进网格（越过上一级阈值）时复位。
  useEffect(() => {
    setColumnOverlay((prev) => {
      if (prev === 'left' && visibility.left) return null;
      if (prev === 'right' && visibility.right) return null;
      return prev;
    });
  }, [visibility.left, visibility.right]);

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

  // 栏折叠/展开：折叠收成栏头条（不占宽度预算、不出分隔条），展开恢复期望宽度；
  // 折叠态与宽度同步持久化。overlay 态折叠等价于收起覆盖层并落回栏头条。
  const toggleCollapse = useCallback((side: 'left' | 'right') => {
    setCollapsed((prev) => {
      const next = { ...prev, [side]: !prev[side] };
      saveColumnLayout({ widths: desiredRef.current, collapsed: next });
      return next;
    });
    setColumnOverlay((prev) => (prev === side ? null : prev));
  }, []);

  const paneProps = (active: boolean) => ({
    className: `${styles.columnPane} ${active ? styles.columnPaneActive : ''}`,
    'aria-hidden': !active,
    ...(!active ? { inert: '' } : {}),
  });

  // 变更面板的栏头动作：分支 caption chip + 刷新。
  const reviewActions = (summary: GitSummary | null, refreshRef: { current: (() => void) | null }) => (
    <>
      <span className={styles.columnToolbarChip} title={summary?.branch || 'Git'}>
        <BranchesOutlined />
        <span className={styles.columnToolbarChipLabel}>{summary?.branch || 'Git'}</span>
      </span>
      <Button
        type="text"
        size="small"
        icon={<ReloadOutlined />}
        aria-label="刷新变更"
        onClick={() => refreshRef.current?.()}
      />
    </>
  );

  const leftToolbarActions = leftPane === 'files' ? (
    <Button
      type="text"
      size="small"
      icon={<ReloadOutlined />}
      aria-label="刷新文件树"
      onClick={() => filesRefreshRef.current?.()}
    />
  ) : leftPane === 'review' ? reviewActions(leftReviewSummary, leftReviewRefreshRef) : null;
  const rightToolbarActions = rightPane === 'review' ? reviewActions(rightReviewSummary, rightReviewRefreshRef) : null;

  // overlay 态的栏头追加收起按钮（覆盖层不影响网格宽度，关闭后回到贴边展开入口）。
  const overlayClose = (
    <Button
      type="text"
      size="small"
      icon={<CloseOutlined />}
      aria-label="收起面板"
      onClick={() => setColumnOverlay(null)}
    />
  );
  // 栏头折叠控件：chevron 指向折叠方向（左栏向左收、右栏向右收）。
  const collapseSide = (side: 'left' | 'right') => (
    <Button
      type="text"
      size="small"
      icon={side === 'left' ? <LeftOutlined /> : <RightOutlined />}
      aria-label={side === 'left' ? '折叠资源栏' : '折叠工具栏'}
      onClick={() => toggleCollapse(side)}
    />
  );
  const leftActions = <>{leftToolbarActions}{collapseSide('left')}{leftOverlayActive ? overlayClose : null}</>;
  const rightActions = <>{rightToolbarActions}{rightOverlayActive ? overlayClose : null}{collapseSide('right')}</>;

  // 网格模板按可见性动态生成：折叠的栏只占栏头条宽度且无分隔条；
  // 被策略隐藏的栏与其分隔条都不进模板，中栏吃满剩余宽度。
  const gridTemplate = [
    collapsed.left ? `${COLLAPSED_COLUMN_WIDTH}px` : visibility.left ? `${widths.left}px ${DIVIDER_WIDTH}px` : '',
    'minmax(0, 1fr)',
    collapsed.right ? `${COLLAPSED_COLUMN_WIDTH}px` : visibility.right ? `${DIVIDER_WIDTH}px ${widths.right}px` : '',
  ].filter(Boolean).join(' ');

  // 栏的四种呈现：折叠栏头条（网格内固定宽）/ 网格内（可见）/ 覆盖层（显式打开）/ 隐藏保活。
  const sideClass = (side: 'left' | 'right') => {
    if (collapsed[side]) {
      return `${styles.columnSide} ${styles.columnCollapsed} ${side === 'left' ? styles.columnCollapsedLeft : styles.columnCollapsedRight}`;
    }
    if (visibility[side]) return styles.columnSide;
    const overlayed = columnOverlay === side;
    return `${styles.columnSide} ${overlayed
      ? `${styles.columnOverlay} ${side === 'left' ? styles.columnOverlayLeft : styles.columnOverlayRight}`
      : styles.columnHidden}`;
  };
  const sideStyle = (side: 'left' | 'right') => (
    !collapsed[side] && !visibility[side] && columnOverlay === side ? { width: widths[side] } : undefined
  );

  return (
    <div
      ref={containerRef}
      className={styles.columnsLayout}
      style={{ gridTemplateColumns: gridTemplate }}
    >
      <aside className={sideClass('left')} style={sideStyle('left')}>
        {/* 折叠态：栏头条（展开 chevron + 纵向当前面板标签），面板保持挂载仅 CSS 隐藏。 */}
        {collapsed.left ? (
          <div className={styles.columnRail}>
            <button
              type="button"
              className={styles.columnRailButton}
              aria-label="展开资源栏"
              onClick={() => toggleCollapse('left')}
            >
              <RightOutlined />
            </button>
            <span className={styles.columnRailLabel}>{PANE_LABELS[leftPane]}</span>
          </div>
        ) : null}
        <ColumnToolbar panes={LEFT_PANES} active={leftPane} onSelect={selectLeftPane} ariaLabel="资源栏" actions={leftActions} />
        <div className={styles.columnBody}>
          {projectPath ? (
            <>
              <div {...paneProps(leftPane === 'files')}>
                <FilesPanel projectPath={projectPath} registerRefresh={registerFilesRefresh} />
              </div>
              {leftReviewMounted ? (
                <div {...paneProps(leftPane === 'review')}>
                  <ReviewPanel
                    projectPath={projectPath}
                    registerRefresh={registerLeftReviewRefresh}
                    onSummaryChange={setLeftReviewSummary}
                  />
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
      {shown.left ? (
        <div
          className={styles.columnDivider}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整左栏宽度"
          onMouseDown={onDividerDown('left')}
        />
      ) : null}
      <section className={styles.columnCenter}>{chat}</section>
      {shown.right ? (
        <div
          className={styles.columnDivider}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整右栏宽度"
          onMouseDown={onDividerDown('right')}
        />
      ) : null}
      <aside className={sideClass('right')} style={sideStyle('right')}>
        {collapsed.right ? (
          <div className={styles.columnRail}>
            <button
              type="button"
              className={styles.columnRailButton}
              aria-label="展开工具栏"
              onClick={() => toggleCollapse('right')}
            >
              <LeftOutlined />
            </button>
            <span className={styles.columnRailLabel}>{PANE_LABELS[rightPane]}</span>
          </div>
        ) : null}
        <ColumnToolbar panes={RIGHT_PANES} active={rightPane} onSelect={selectRightPane} ariaLabel="工具栏" actions={rightActions} />
        <div className={styles.columnBody}>
          {terminalOpen ? (
            <div {...paneProps(rightPane === 'terminal')}>
              {/* 无项目时不挂载终端（cwd 无意义且会自动连接），与其他面板空态一致。 */}
              {projectPath ? (
                <ShellTerminalPanel visible cwd={projectPath} onClose={closeTerminal} compactChrome />
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先选择项目" />
              )}
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
                <ReviewPanel
                  projectPath={projectPath}
                  registerRefresh={registerRightReviewRefresh}
                  onSummaryChange={setRightReviewSummary}
                />
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
      {/* 栏被策略隐藏时的贴边展开入口：显式打开为覆盖层，不被 resize 自动收回。
          折叠态已渲染栏头条，不再重复提供贴边入口。 */}
      {!visibility.left && !collapsed.left && !leftOverlayActive ? (
        <button
          type="button"
          className={`${styles.columnExpand} ${styles.columnExpandLeft}`}
          aria-label="展开资源栏"
          onClick={() => setColumnOverlay('left')}
        >
          <MenuUnfoldOutlined />
        </button>
      ) : null}
      {!visibility.right && !collapsed.right && !rightOverlayActive ? (
        <button
          type="button"
          className={`${styles.columnExpand} ${styles.columnExpandRight}`}
          aria-label="展开工具栏"
          onClick={() => setColumnOverlay('right')}
        >
          <MenuFoldOutlined />
        </button>
      ) : null}
    </div>
  );
}
