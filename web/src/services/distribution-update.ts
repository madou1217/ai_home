import { fetchAuthorizedWebUiResource } from './webui-auth-transport';

export interface DistributionUpdateSchedule {
  id: string;
  version: string;
  status: string;
  at: string;
  timezone: string;
  nextAttemptAt?: string;
  error?: string;
  deferredReason?: string;
}

export interface DistributionUpdateSnapshot {
  current: { version: string; target: string; source: string };
  latest?: { available: boolean; version: string } | null;
  checkedAt?: string;
  nextCheckAt?: string;
  checkError?: string;
  schedule?: DistributionUpdateSchedule | null;
}

export interface DistributionUpdateAppointment {
  at: string;
  timezone: string;
  confirm: true;
}

const errorMessages: Record<string, string> = {
  unauthorized: '请先配置当前连接服务的访问凭据。',
  webui_unauthorized: '当前连接服务的访问凭据不可用，请重新配置。',
  forbidden: '当前访问权限不足，无法管理此服务的发行版更新。',
  not_found: '当前服务尚未提供发行版更新接口。',
  distribution_update_unavailable: '当前服务暂未启用发行版更新。',
  distribution_install_required: '当前不是发行版安装，请先通过发行版安装流程部署。',
  explicit_confirmation_required: '请明确确认更新操作后再提交。',
  check_release_first: '请先检查并确认可用的新版本。',
  update_already_scheduled: '已有更新任务，请刷新后查看其状态。',
  update_not_cancellable: '任务已进入执行阶段或已结束，无法取消。',
  invalid_schedule: '预约时间或时区无效，请重新选择。',
  invalid_timezone: '请输入有效的 IANA 时区，例如 Asia/Shanghai 或 UTC。',
  invalid_local_time: '该时间在所选时区中无效，请重新选择。',
  ambiguous_local_time: '该时刻因夏令时存在重复，请选择其他时间。',
  schedule_in_past: '请选择未来的预约时间。',
  check_failed: '检查新版本失败，请稍后重试。',
  check_unavailable: '当前服务未配置版本检查来源。',
  invalid_release: '版本检查结果不可用，请重新检查。',
  download_failed: '下载更新失败，请检查服务端日志后重试。',
  download_verification_failed: '更新包校验失败，未继续安装。',
  installer_handoff_failed: '未能交接安装任务，请检查服务端日志。',
  distribution_update_failed: '更新请求失败，请刷新状态后重试。',
  invalid_response: '当前服务返回了无法识别的更新状态。',
  network_error: '无法连接当前服务，请检查连接后重试。',
};

function knownErrorMessage(code: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(errorMessages, code) ? errorMessages[code] : undefined;
}

export class DistributionUpdateError extends Error {
  constructor(public readonly code: string, public readonly status = 0) {
    // Never reflect arbitrary backend messages, response bodies, or request headers.
    super(knownErrorMessage(code) || errorMessages.distribution_update_failed);
    this.name = 'DistributionUpdateError';
  }
}

export function distributionUpdateErrorMessage(error: unknown): string {
  return error instanceof DistributionUpdateError
    ? error.message
    : errorMessages.distribution_update_failed;
}

export function distributionUpdateFailureMessage(code: string): string {
  return knownErrorMessage(code) || '操作未完成，请查看当前服务的日志。';
}

const updatePath = '/v0/webui/distribution-update';

async function requestUpdate(
  action: '' | '/check' | '/schedule' | '/cancel',
  signal?: AbortSignal,
  appointment?: DistributionUpdateAppointment,
): Promise<DistributionUpdateSnapshot> {
  let response: Response;
  try {
    response = await fetchAuthorizedWebUiResource(`${updatePath}${action}`, {
      method: action ? 'POST' : 'GET',
      cache: 'no-store',
      signal,
      ...(appointment ? {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ at: appointment.at, timezone: appointment.timezone, confirm: appointment.confirm }),
      } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new DistributionUpdateError('network_error');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    const fallback = response.status === 401 ? 'unauthorized'
      : response.status === 403 ? 'forbidden'
        : response.status === 404 ? 'not_found' : 'distribution_update_failed';
    const code = typeof payload?.error === 'string'
      && Object.prototype.hasOwnProperty.call(errorMessages, payload.error)
      ? payload.error : fallback;
    throw new DistributionUpdateError(code, response.status);
  }
  const update = payload?.update;
  if (typeof update?.current?.version !== 'string'
    || typeof update?.current?.target !== 'string'
    || typeof update?.current?.source !== 'string') {
    throw new DistributionUpdateError('invalid_response', response.status);
  }
  return update;
}

export function getDistributionUpdate(signal?: AbortSignal) {
  return requestUpdate('', signal);
}

export function checkDistributionUpdate(signal?: AbortSignal) {
  return requestUpdate('/check', signal);
}

export function scheduleDistributionUpdate(
  appointment: DistributionUpdateAppointment,
  signal?: AbortSignal,
) {
  return requestUpdate('/schedule', signal, appointment);
}

export function cancelDistributionUpdate(signal?: AbortSignal) {
  return requestUpdate('/cancel', signal);
}

export function validateDistributionTimezone(timezone: string): string {
  const value = timezone.trim();
  // Reject fixed offsets/"Local"; the server expects an IANA location or UTC.
  if (value !== 'UTC' && !/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value)) {
    throw new DistributionUpdateError('invalid_timezone');
  }
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value }).format();
  } catch (_error) {
    throw new DistributionUpdateError('invalid_timezone');
  }
  return value;
}

/** Interpret datetime-local in the selected IANA zone, never the browser's offset. */
export function distributionScheduleInstant(localTime: string, timezone: string): string {
  const zone = validateDistributionTimezone(timezone);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localTime)) {
    throw new DistributionUpdateError('invalid_local_time');
  }
  const wallTime = Date.parse(`${localTime}:00Z`);
  if (!Number.isFinite(wallTime) || new Date(wallTime).toISOString().slice(0, 16) !== localTime) {
    throw new DistributionUpdateError('invalid_local_time');
  }
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const wallAt = (instant: number) => {
    const parts: Record<string, string> = {};
    formatter.formatToParts(instant).forEach(({ type, value }) => { parts[type] = value; });
    return Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
  };
  const candidates = new Set<number>();
  // Adjacent days provide both offsets around a DST transition.
  for (const delta of [-86400000, 0, 86400000]) {
    const sample = wallTime + delta;
    const candidate = wallTime - (wallAt(sample) - sample);
    if (wallAt(candidate) === wallTime) candidates.add(candidate);
  }
  if (candidates.size !== 1) {
    throw new DistributionUpdateError(candidates.size ? 'ambiguous_local_time' : 'invalid_local_time');
  }
  const instant = [...candidates][0];
  if (instant <= Date.now()) throw new DistributionUpdateError('schedule_in_past');
  return new Date(instant).toISOString();
}
