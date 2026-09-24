import { CloseOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';
import { HudIconButton } from '@/mobile/ui';
import type { HudTone } from '@/mobile/ui';
import { LIFECYCLE_ACTION_LABELS, isLifecycleAction } from '@/components/toolkit/lifecycle-presentation';
import type { WebUiTask } from '@/types';
import styles from '../MobileToolkit.module.css';

const LED_TONE: Record<HudTone, string> = {
  ok: 'ok',
  warn: 'warn',
  err: 'err',
  info: 'info',
  muted: 'info'
};

/** 状态 = LED + 大写等宽短文本（颜色来自语义 tone）。 */
export function StatusText({ tone, children, live }: { tone: HudTone; children: ReactNode; live?: boolean }) {
  return (
    <span className={`mhud-status mhud-tone--${tone}`}>
      {tone === 'muted'
        ? <span className="hud-led" aria-hidden="true" />
        : <span className={`hud-led hud-led--${LED_TONE[tone]}${live ? ' hud-led--live' : ''}`} aria-hidden="true" />}
      {children}
    </span>
  );
}

/** 后台任务队列中的生命周期任务读数：「更新中 42%」。 */
export function lifecycleTaskLabel(task: WebUiTask) {
  const key = task.action || 'update';
  const action = isLifecycleAction(key) ? LIFECYCLE_ACTION_LABELS[key] : '操作';
  return `${action}中 ${Math.round(Number(task.progress?.percent || 0))}%`;
}

export function TaskStatus({ task }: { task: WebUiTask }) {
  return <StatusText tone="info" live>{lifecycleTaskLabel(task)}</StatusText>;
}

/** 行内错误：LED + 标题 + 详情 + 真实重试。 */
export function InlineError({ title, detail, onRetry, retrying, onDismiss }: {
  title: ReactNode;
  detail?: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  onDismiss?: () => void;
}) {
  return (
    <div className={styles.error} role="alert">
      <span className={styles.errorHead}>
        <span className="hud-led hud-led--err" aria-hidden="true" />
        <strong>{title}</strong>
      </span>
      {detail ? <span className={styles.errorDetail}>{detail}</span> : null}
      {onRetry ? (
        <HudIconButton icon={<ReloadOutlined />} label="重试" showLabel loading={retrying} onClick={onRetry} />
      ) : null}
      {onDismiss ? (
        <HudIconButton icon={<CloseOutlined />} label="关闭" onClick={onDismiss} />
      ) : null}
    </div>
  );
}

/** 提示条（信息 / 警告），用于原面板里的 InlineNote 说明。 */
export function Note({ tone = 'info', title, children }: { tone?: 'info' | 'warn' | 'err'; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`${styles.note} ${styles[`note_${tone}`]}`} role="note">
      {title ? <strong className={styles.noteTitle}>{title}</strong> : null}
      {children ? <span className={styles.noteBody}>{children}</span> : null}
    </div>
  );
}

/** 面板工具条：左侧一句真实状态，右侧刷新（与桌面「重新探测 / 重新读取」同一请求）。 */
export function PanelToolbar({ status, refreshLabel, refreshing, onRefresh, children }: {
  status?: ReactNode;
  refreshLabel: string;
  refreshing?: boolean;
  onRefresh: () => void;
  children?: ReactNode;
}) {
  return (
    <div className={styles.panelToolbar}>
      <div className={styles.panelToolbarStatus}>{status}</div>
      <div className={styles.panelToolbarActions}>
        {children}
        <HudIconButton icon={<ReloadOutlined />} label={refreshLabel} loading={refreshing} onClick={onRefresh} />
      </div>
    </div>
  );
}

/** 抽屉底部 / 卡片内的操作按钮（≥44px，切角，一处最多一个 primary）。 */
export function ActionButton({ icon, label, onClick, disabled, loading, tone = 'default', href }: {
  icon?: ReactNode;
  label: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  tone?: 'default' | 'primary' | 'danger';
  href?: string;
}) {
  const className = [
    styles.actionButton,
    tone !== 'default' ? styles[`actionButton_${tone}`] : '',
    loading ? styles.actionButtonLoading : ''
  ].filter(Boolean).join(' ');
  if (href) {
    return (
      <a className={className} href={href} target="_blank" rel="noreferrer">
        {icon}
        <span>{label}</span>
      </a>
    );
  }
  return (
    <button
      type="button"
      className={className}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/** 等宽只读块（命令 / 路径 / 配置值）。 */
export function MonoBlock({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <pre className={styles.monoBlock} tabIndex={0} aria-label={label}>
      <code>{children}</code>
    </pre>
  );
}
