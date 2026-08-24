import type { AppInstallJob, ManagedAppUpdateResponse, WebUiTask } from '@/types';

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

export interface AppUpdateActionPresentation {
  shouldExecute: boolean;
  title: string;
  summary: string;
  notice: string;
  metadata: Array<{ label: string; value: string }>;
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

export function getAppUpdateActionPresentation(
  appName: string,
  response: ManagedAppUpdateResponse
): AppUpdateActionPresentation {
  const name = String(appName || '').trim() || '应用';
  const currentVersion = response.currentVersion || '未探测到';
  const latestVersion = response.latestVersion || '';
  const isCurrent = response.ok && response.status === 'current' && !response.updateAvailable;
  if (isCurrent) {
    return {
      shouldExecute: false,
      title: '',
      summary: '',
      notice: latestVersion ? `${name} 已是最新版（${latestVersion}）` : `${name} 已是最新版`,
      metadata: []
    };
  }

  const summary = response.updateAvailable
    ? '确认后将创建更新任务，进度显示在后台任务队列。'
    : response.status === 'unknown'
      ? '当前版本无法自动比较；确认后仍会执行更新计划。'
      : '远端版本不可用；确认后仍会执行更新计划。';
  return {
    shouldExecute: true,
    title: response.updateAvailable ? `${name} 有新版本` : `更新 ${name}`,
    summary,
    notice: '',
    metadata: [
      { label: '当前版本', value: currentVersion },
      ...(latestVersion ? [{ label: '远端最新版', value: latestVersion }] : [])
    ]
  };
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

export function canRetryWebUiTask(task: WebUiTask) {
  const source = String(task.source || '');
  return ['app-install', 'terminal', 'environment', 'managed-tool'].includes(source)
    && String(task.status || '').toLowerCase() === 'failed'
    && Boolean(task.appId && task.action);
}

export function getWebUiTaskSourceLabel(task: Pick<WebUiTask, 'source'>) {
  if (task.source === 'terminal') return '终端';
  if (task.source === 'environment') return '运行环境';
  if (task.source === 'managed-tool') return '网络接入';
  return '应用';
}
