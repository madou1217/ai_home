import type { AppInstallJob, WebUiTask } from '@/types';

export interface AppActionPlanPresentation {
  id: string;
  label: string;
  command: string;
  args?: string[];
}

export type AppInstallStatusTone = 'active' | 'success' | 'error' | 'neutral';

export interface AppInstallStatusPresentation {
  label: string;
  tone: AppInstallStatusTone;
  terminal: boolean;
}

function quoteShellToken(value: string) {
  if (!value) return "''";
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatAppActionPlan(plan: AppActionPlanPresentation) {
  const tokens = [plan.command, ...(plan.args || [])]
    .map((value) => String(value || ''))
    .filter(Boolean)
    .map(quoteShellToken);
  if (tokens.length <= 1) return tokens[0] || '';
  return tokens.map((token, index) => index === 0 ? token : `  ${token}`)
    .join(' \\\n');
}

export function getAppInstallFailureReasons(job: Pick<AppInstallJob, 'error' | 'attempts'> | null | undefined) {
  const reasons: string[] = [];
  const seen = new Set<string>();
  const append = (rawReason: unknown, label = '') => {
    const reason = String(rawReason || '').trim();
    if (!reason || seen.has(reason)) return;
    seen.add(reason);
    reasons.push(label ? `${label}：${reason}` : reason);
  };

  append(job?.error);
  (job?.attempts || []).filter((attempt) => !attempt.ok).forEach((attempt) => {
    append(attempt.error || '执行失败', String(attempt.label || attempt.id || '').trim());
  });
  return reasons.length ? reasons : ['安装任务未返回失败原因'];
}

export function getAppInstallStatusPresentation(status: string): AppInstallStatusPresentation {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'succeeded') return { label: '已成功', tone: 'success', terminal: true };
  if (normalized === 'failed') return { label: '执行失败', tone: 'error', terminal: true };
  if (normalized === 'cancelled') return { label: '已取消', tone: 'neutral', terminal: true };
  if (normalized === 'queued') return { label: '排队中', tone: 'active', terminal: false };
  return { label: '执行中', tone: 'active', terminal: false };
}

export function mergeWebUiTaskQueueEntries(
  activeTasks: WebUiTask[],
  recentTasks: WebUiTask[],
  dismissedTaskIds: ReadonlySet<string> = new Set()
) {
  const merged = new Map<string, WebUiTask>();
  recentTasks.forEach((task) => merged.set(task.id, task));
  activeTasks.forEach((task) => merged.set(task.id, task));
  return [...merged.values()]
    .filter((task) => !dismissedTaskIds.has(task.id))
    .sort((left, right) => {
      const leftTerminal = getAppInstallStatusPresentation(left.status).terminal;
      const rightTerminal = getAppInstallStatusPresentation(right.status).terminal;
      if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
      return Number(right.updatedAt || 0) - Number(left.updatedAt || 0)
        || String(left.id).localeCompare(String(right.id));
    });
}

export function canRetryAppInstallTask(task: WebUiTask) {
  return task.source === 'app-install'
    && String(task.status || '').toLowerCase() === 'failed'
    && Boolean(task.appId && task.action);
}
