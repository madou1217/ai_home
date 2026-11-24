import { CopyOutlined, DownOutlined, MessageOutlined, ReloadOutlined, UpOutlined, WarningOutlined } from '@ant-design/icons';
import ProviderIcon, { providerNames } from '@/components/chat/ProviderIcon';
import {
  getRecentErrorProvider,
  normalizeQueueCount,
  type ProviderRow,
  type RouteRow
} from '@/features/dashboard/dashboard-presentation';
import {
  EmptySignal,
  HudCard,
  HudIconButton,
  HudSection,
  MonoList,
  SwipeRow,
  type HudTone,
  type SwipeAction
} from '@/mobile/ui';
import type { RecentErrorView } from './RecentErrorSheet';
import styles from '../MobileDashboard.module.css';

const providerLabel = (provider: string) => providerNames[provider as keyof typeof providerNames] || provider;

const getProviderStatusText = (active: number, total: number) => {
  if (total === 0) return '未配置';
  if (active === 0) return '不可用';
  if (active < total) return '部分可用';
  return '可用';
};

interface ProviderListSectionProps {
  activeCount: number;
  totalCount: number;
  idleCount: number;
  showIdleProviders: boolean;
  onToggleIdleProviders: () => void;
  entries: Array<{ item: { row: ProviderRow; idle: boolean }; leaving: boolean }>;
  onOpenProvider: (row: ProviderRow) => void;
  onGoAccounts: () => void;
}

export function DashboardProviderSection({
  activeCount,
  totalCount,
  idleCount,
  showIdleProviders,
  onToggleIdleProviders,
  entries,
  onOpenProvider,
  onGoAccounts
}: ProviderListSectionProps) {
  return (
    <HudSection title="Provider 运行状态" code="PROV" count={`${activeCount}/${totalCount}`}>
      {entries.length === 0 ? (
        <EmptySignal
          title="暂无已配置 Provider"
          description="先添加可用账号，再回到仪表盘观察实时调度。"
          action={(
            <HudIconButton
              icon={<ReloadOutlined />}
              label="前往账号"
              tone="primary"
              showLabel
              onClick={onGoAccounts}
            />
          )}
        />
      ) : (
        <MonoList ariaLabel="Provider 运行状态">
          {entries.map(({ item, leaving }) => {
            const { row, idle: entering } = item;
            const pct = row.total > 0 ? Math.round((row.active / row.total) * 100) : 0;
            const offline = row.total === 0;
            const running = normalizeQueueCount(row.queue?.running);
            const queued = normalizeQueueCount(row.queue?.queued);
            const conc = normalizeQueueCount(row.queue?.maxConcurrency, 1);
            const ratioTone: HudTone = offline ? 'muted' : row.active === 0 ? 'err' : pct < 100 ? 'warn' : 'ok';
            const statusText = getProviderStatusText(row.active, row.total);
            return (
              <SwipeRow
                key={row.key}
                onTap={() => onOpenProvider(row)}
                ariaLabel={`查看 ${providerLabel(row.provider)} 运行状态，${statusText}`}
                className={leaving ? 'aih-leaving' : entering ? 'aih-fade-in' : undefined}
              >
                <span className={`mhud-row__icon${offline ? ` ${styles.idle}` : ''}`}>
                  <ProviderIcon provider={row.provider} size={20} />
                </span>
                <span className={`mhud-row__main${offline ? ` ${styles.idle}` : ''}`}>
                  <span className="mhud-row__title">{providerLabel(row.provider)}</span>
                  <span className="mhud-row__meta">
                    {offline ? '未接入账号' : `队列 ${running}/${queued} · 并发 ${conc} · 请求 ${row.requests}`}
                  </span>
                </span>
                <span className="mhud-row__side">
                  <span className={`mhud-status mhud-tone--${ratioTone}`}>
                    <span className={`hud-led${offline ? '' : ` hud-led--${ratioTone}`}`} aria-hidden="true" />
                    {statusText} {row.active}/{row.total}
                  </span>
                  <span className={styles.counts}>
                    <span className="mhud-tone--ok">成 {row.success}</span>
                    <span className={row.failures > 0 ? 'mhud-tone--err' : styles.dim}>败 {row.failures}</span>
                  </span>
                </span>
              </SwipeRow>
            );
          })}
        </MonoList>
      )}
      {idleCount > 0 ? (
        <button
          type="button"
          className={styles.expander}
          aria-expanded={showIdleProviders}
          onClick={onToggleIdleProviders}
        >
          {showIdleProviders ? <UpOutlined /> : <DownOutlined />}
          <span>{showIdleProviders ? '收起未接入账号的 Provider' : `显示未接入账号的 Provider（${idleCount}）`}</span>
        </button>
      ) : null}
    </HudSection>
  );
}

interface RecentErrorsSectionProps {
  errorViews: RecentErrorView[];
  onOpenError: (view: RecentErrorView) => void;
  onCopyError: (text: string) => void;
  onOpenChat: (options: { projectPath?: string; sessionId?: string }) => void;
}

export function DashboardRecentErrorsSection({
  errorViews,
  onOpenError,
  onCopyError,
  onOpenChat
}: RecentErrorsSectionProps) {
  if (errorViews.length === 0) return null;
  return (
    <HudSection title="最近错误" code="ERR" count={errorViews.length} className="aih-fade-in">
      <MonoList ariaLabel="最近错误">
        {errorViews.map((view) => {
          const provider = getRecentErrorProvider(view.item);
          const canOpenChat = Boolean(view.item.projectPath || view.item.sessionId);
          const actions: SwipeAction[] = [
            { key: 'copy', label: '复制', icon: <CopyOutlined />, onAction: () => onCopyError(view.text) }
          ];
          if (canOpenChat) {
            actions.push({
              key: 'chat',
              label: '会话',
              icon: <MessageOutlined />,
              tone: 'primary',
              onAction: () => onOpenChat({ projectPath: view.item.projectPath, sessionId: view.item.sessionId })
            });
          }
          return (
            <SwipeRow key={view.key} actions={actions} onTap={() => onOpenError(view)} ariaLabel={`查看错误详情：${view.account}`}>
              <span className="mhud-row__icon">
                {provider ? <ProviderIcon provider={provider} size={18} /> : <WarningOutlined className="mhud-tone--err" />}
              </span>
              <span className="mhud-row__main">
                <span className="mhud-row__title">{view.account}</span>
                <span className={`mhud-row__meta ${styles.errorMeta}`}>{view.text}</span>
              </span>
              <span className="mhud-row__side">
                <span className="mhud-status mhud-tone--err">
                  <span className="hud-led hud-led--err" />
                  失败
                </span>
                {view.item.at ? <span className={styles.dim}>{new Date(view.item.at).toLocaleTimeString()}</span> : null}
              </span>
            </SwipeRow>
          );
        })}
      </MonoList>
    </HudSection>
  );
}

interface HotRoutesSectionProps {
  routeRows: RouteRow[];
}

export function DashboardHotRoutesSection({ routeRows }: HotRoutesSectionProps) {
  if (routeRows.length === 0) return null;
  const routeTotalMax = Math.max(routeRows[0]?.count || 0, 1);
  return (
    <HudSection title="热点路由" code="ROUTE" count={routeRows.length} className="aih-fade-in">
      <HudCard>
        <div className={styles.routeList}>
          {routeRows.map((row) => (
            <div className={styles.routeItem} key={row.key}>
              <div className={styles.routeLine}>
                <span className={styles.routeName}>{row.route}</span>
                <span className={styles.routeCount}>{row.count}</span>
              </div>
              <span className="mhud-track" aria-hidden="true">
                <span className="mhud-track__fill mhud-bg--info" style={{ width: `${Math.round((row.count / routeTotalMax) * 100)}%` }} />
              </span>
            </div>
          ))}
        </div>
      </HudCard>
    </HudSection>
  );
}
