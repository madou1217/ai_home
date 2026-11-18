import { toolkitAPI, waitForAppInstallJob } from '@/services/api';
import type { AccountActivityJob, AccountActivityResult } from '@/types';

/** 活动结果下发的安装提示（目前是 Qoder CLI；结构对所有 Provider 通用）。 */
export interface ActivityInstallHint {
  appId: string;
  kind: 'cli' | 'desktop';
}

/** 读取结果里的安装提示；没有或 appId 为空时返回 null。 */
export function getActivityInstallHint(
  result: AccountActivityResult | null | undefined
): ActivityInstallHint | null {
  const hint = result?.installRequired;
  if (!hint || !hint.appId) return null;
  return { appId: hint.appId, kind: hint.kind === 'desktop' ? 'desktop' : 'cli' };
}

/**
 * 按活动结果安装客户端，并等到安装任务进入终态。
 * 走与 Toolkit > 应用管理相同的异步安装任务，进度由右下角任务队列展示。
 */
export async function installActivityClient(hint: ActivityInstallHint): Promise<void> {
  const started = await toolkitAPI.executeAppAction(hint.appId, 'install', hint.kind);
  if (!started.ok || !started.job) {
    throw new Error(started.error || '安装任务未创建');
  }
  const completed = await waitForAppInstallJob(started.job.id);
  if (completed.status !== 'succeeded') {
    throw new Error(completed.error || '安装失败');
  }
}

/** 只有整批目标均在访问上游前缺 CLI，安装后才可自动重试同一批。 */
export function canRetryActivityJobAfterInstall(job: AccountActivityJob | null): boolean {
  return Boolean(job
    && ['succeeded', 'partial', 'failed'].includes(job.status)
    && job.progress.total > 0
    && job.progress.completed === job.progress.total
    && job.results.length === job.progress.total
    && job.results.every((result) => result.status === 'error'
      && (result.errorCode || result.error || '').split(':', 1)[0].trim() === 'qoder_cli_missing'));
}
