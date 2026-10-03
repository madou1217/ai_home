import type { ManagedToolService, ManagedToolServiceAction } from '@/types';

export type ServiceTone = 'ok' | 'warn' | 'err' | 'info' | 'idle';

export const SERVICE_ACTION_LABELS: Readonly<Record<ManagedToolServiceAction, string>> = Object.freeze({
  start: '启动',
  stop: '停止',
  restart: '重启'
});

export function serviceStateLabel(service: ManagedToolService): string {
  switch (service.state) {
    case 'running':
      return '运行中';
    case 'stopped':
      return '已停止';
    case 'backoff':
      return `等待自动重启（连续失败 ${service.consecutiveFailures || 0} 次）`;
    case 'external':
      return '外部进程运行中';
    case 'error':
      return service.exitCode != null ? `异常退出（退出码 ${service.exitCode}）` : '异常退出';
    default:
      return '状态未知';
  }
}

export function serviceStateTone(service: ManagedToolService): ServiceTone {
  if (service.state === 'running') return 'ok';
  if (service.state === 'backoff' || service.state === 'external') return 'warn';
  if (service.state === 'error') return 'err';
  if (service.state === 'stopped') return 'idle';
  return 'info';
}

export function serviceSummary(service: ManagedToolService): string {
  const parts = [service.backendLabel || service.backend, serviceStateLabel(service)];
  if (service.pid) parts.push(`pid ${service.pid}`);
  if (service.restarts) parts.push(`已自动重启 ${service.restarts} 次`);
  return parts.filter(Boolean).join(' · ');
}

export function servicePolicySummary(service: ManagedToolService): string {
  const autoRestart = service.autoRestart ? '异常退出自动重启' : '不自动重启';
  const autoStart = service.backend === 'homebrew'
    ? (service.autoStart ? '已注册开机自启' : '未注册开机自启')
    : (service.autoStart ? '随 AIH 启动' : '不随 AIH 启动');
  return `${autoRestart}；${autoStart}`;
}

/** 停止/重启会中断隧道连接，需要二次确认；启动不需要。 */
export function serviceActionNeedsConfirm(action: ManagedToolServiceAction) {
  return action !== 'start';
}
