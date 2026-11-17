import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button, Input, Tag } from 'antd';
import { CheckOutlined, ClockCircleOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import { buildAppHref } from '@/services/app-navigation';
import { ACTIVE_CONTROL_PLANE_CHANGED_EVENT } from '@/services/control-plane-selection';
import { CONTROL_PLANE_PROFILES_CHANGED_EVENT } from '@/services/control-plane-profiles';
import { resolveActiveServer, resolveActiveServerOrigin } from '@/services/webui-auth-transport';
import {
  cancelDistributionUpdate,
  checkDistributionUpdate,
  distributionScheduleInstant,
  distributionUpdateErrorMessage,
  distributionUpdateFailureMessage,
  DistributionUpdateError,
  getDistributionUpdate,
  scheduleDistributionUpdate,
  validateDistributionTimezone,
  type DistributionUpdateSnapshot,
} from '@/services/distribution-update';
import styles from './DistributionUpdatePanel.module.css';

type Action = 'load' | 'check' | 'schedule' | 'now' | 'cancel';
interface Confirmation {
  action: 'schedule' | 'now';
  at: string;
  timezone: string;
  version: string;
  scope: string;
}

const statusLabels: Record<string, string> = {
  queued: '已预约', deferred: '忙碌延期', downloading: '下载中', installing: '安装处理中',
  succeeded: '已完成', failed: '更新失败', cancelled: '已取消',
};
const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled']);

function serverScope() {
  const active = resolveActiveServer();
  return `${active.isRemote ? 'remote' : 'local'}:${active.serverId}:${resolveActiveServerOrigin()}`;
}

function browserTimezone() {
  try { return validateDistributionTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone); }
  catch (_error) { return 'UTC'; }
}

function formatTime(value?: string, timezone?: string) {
  if (!value || value.startsWith('0001-')) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone || browserTimezone(), month: '2-digit', day: '2-digit',
      year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
    }).format(date);
  } catch (_error) { return date.toISOString(); }
}

export default function DistributionUpdatePanel() {
  const [update, setUpdate] = useState<DistributionUpdateSnapshot | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [formError, setFormError] = useState('');
  const [localTime, setLocalTime] = useState('');
  const [timezone, setTimezone] = useState(browserTimezone);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [revision, setRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
  const scope = useRef('');
  const timezoneListId = useId();

  const run = useCallback(async (action: Action, intent?: Confirmation) => {
    if (request.current || scope.current !== serverScope()) return;
    if (intent && intent.scope !== scope.current) return;
    if (intent?.action === 'schedule' && Date.parse(intent.at) <= Date.now()) {
      setFormError('预约时间已过去，请重新选择。');
      setConfirmation(null);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    const selectedScope = scope.current;
    setPending(action);
    setError(null);
    try {
      let result: DistributionUpdateSnapshot;
      if (action === 'check') result = await checkDistributionUpdate(controller.signal);
      else if (action === 'cancel') result = await cancelDistributionUpdate(controller.signal);
      else if (intent) {
        result = await scheduleDistributionUpdate({
          at: intent.action === 'now' ? new Date().toISOString() : intent.at,
          timezone: intent.timezone,
          confirm: true,
        }, controller.signal);
      } else result = await getDistributionUpdate(controller.signal);
      if (controller.signal.aborted || selectedScope !== serverScope()) return;
      setUpdate(result);
      setConfirmation((current) => {
        if (action !== 'load' || (result.schedule && !terminalStatuses.has(result.schedule.status))
          || result.latest?.version !== current?.version || !result.latest?.available || result.checkError) return null;
        return current;
      });
    } catch (cause) {
      if (!controller.signal.aborted && selectedScope === serverScope()) {
        setError(cause);
        setConfirmation(null);
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(null);
      }
    }
  }, []);

  useEffect(() => {
    const changed = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== null
        && !['aih:active-control-plane-profile:v1', 'aih:control-plane-profiles:v1', 'aih:explicit-control-plane-profile:v1'].includes(event.key)) return;
      // Profile heartbeat/metadata refreshes must not discard an in-progress draft.
      if (scope.current === serverScope()) return;
      request.current?.abort();
      request.current = null;
      scope.current = '';
      setUpdate(null);
      setConfirmation(null);
      setFormError('');
      setRevision((value) => value + 1);
    };
    const events = [ACTIVE_CONTROL_PLANE_CHANGED_EVENT, CONTROL_PLANE_PROFILES_CHANGED_EVENT,
      'storage', 'popstate', 'hashchange'];
    events.forEach((name) => window.addEventListener(name, changed));
    return () => events.forEach((name) => window.removeEventListener(name, changed));
  }, []);

  useEffect(() => {
    scope.current = serverScope();
    setPending(null);
    setError(null);
    setLocalTime('');
    setConfirmation(null);
    void run('load');
    const timer = window.setInterval(() => { void run('load'); }, 30000);
    return () => {
      window.clearInterval(timer);
      request.current?.abort();
      request.current = null;
      scope.current = '';
    };
  }, [revision, run]);

  const schedule = update?.schedule;
  const activeSchedule = !!schedule && !terminalStatuses.has(schedule.status);
  const distribution = update?.current.source === 'distribution';
  const canSchedule = distribution && update?.latest?.available === true
    && !update.checkError && !activeSchedule && !pending && !error;
  const cancellable = schedule?.status === 'queued' || schedule?.status === 'deferred';
  const accessDenied = error instanceof DistributionUpdateError
    && (error.status === 401 || error.status === 403
      || error.code === 'webui_unauthorized' || error.code === 'unauthorized');

  const prepare = (action: 'schedule' | 'now') => {
    if (!canSchedule || !update?.latest || scope.current !== serverScope()) return;
    setFormError('');
    try {
      const zone = validateDistributionTimezone(timezone);
      setConfirmation({
        action, at: action === 'now' ? new Date().toISOString() : distributionScheduleInstant(localTime, zone),
        timezone: zone, version: update.latest.version, scope: serverScope(),
      });
    } catch (cause) { setFormError(distributionUpdateErrorMessage(cause)); }
  };

  return (
    <section className={styles.panel} aria-label="发行版更新" aria-busy={!!pending}>
      <div className={styles.summary}>
        <div className={styles.versions}>
          <h3 className={styles.title}>发行版更新</h3>
          <span className={styles.muted}>当前 <strong className={styles.version}>{update?.current.version || '—'}</strong></span>
          {update?.current.target && <span className={styles.target}>{update.current.target}</span>}
          <span className={styles.muted}>
            {update?.checkError ? '检查未完成'
              : update?.latest?.available ? <>可更新至 <strong className={styles.version}>{update.latest.version}</strong></>
                : update?.latest ? '当前无可用更新' : pending === 'load' && !update ? '读取中…' : '尚未检查新版本'}
          </span>
        </div>
        <Button size="small" icon={<ReloadOutlined />} loading={pending === 'check'}
          disabled={!!pending} onClick={() => { void run('check'); }}>检查更新</Button>
      </div>

      <div className={styles.metadata}>
        <span>仅管理当前连接的服务 · 每 30 秒刷新状态，不自动安装</span>
        {update && <span>
          {distribution ? '发行版安装' : update.current.source === 'source'
            ? '源码运行：仅检查版本，需先通过发行版安装流程部署' : '安装来源未知：不开放更新操作'}
        </span>}
      </div>
      {update && <div className={styles.metadata}>
        <span>上次检查 {formatTime(update.checkedAt)}</span>
        <span>下次检查 {formatTime(update.nextCheckAt)}</span>
      </div>}
      <div className={styles.feedback} aria-live="polite" aria-atomic="true">
        {!!error && <span className={styles.error} role="alert">
          {distributionUpdateErrorMessage(error)}
          {accessDenied && <> <a href={buildAppHref('/server-setup')}>配置访问凭据</a></>}
        </span>}
        {update?.checkError && <span className={styles.error} role="status">
          {distributionUpdateFailureMessage(update.checkError)}
        </span>}
      </div>

      {schedule && <div className={styles.schedule} aria-live="polite">
        <div className={styles.scheduleSummary}>
          <Tag color={schedule.status === 'failed' ? 'error' : schedule.status === 'succeeded' ? 'success' : 'default'}>
            {Object.prototype.hasOwnProperty.call(statusLabels, schedule.status) ? statusLabels[schedule.status] : '状态待确认'}
          </Tag>
          <span className={styles.version}>{schedule.version}</span>
          <span>{formatTime(schedule.at, schedule.timezone)} · {schedule.timezone}</span>
          {cancellable && <Button size="small" type="text" icon={<StopOutlined />}
            loading={pending === 'cancel'} disabled={!!pending || !!error}
            onClick={() => { void run('cancel'); }}>取消预约</Button>}
        </div>
        {schedule.status === 'deferred' && <span className={styles.muted}>
          {schedule.deferredReason === 'busy_unknown' ? '暂无法确认服务空闲，已安全延期' : '服务忙碌，已延期，不强制中断当前工作'}
          {schedule.nextAttemptAt && <> · 下次尝试 {formatTime(schedule.nextAttemptAt, schedule.timezone)}</>}
        </span>}
        {schedule.status === 'queued' && schedule.nextAttemptAt && <span className={styles.muted}>
          下次尝试 {formatTime(schedule.nextAttemptAt, schedule.timezone)}，执行前仍检查忙碌状态
        </span>}
        {schedule.status === 'installing' && <span className={styles.muted}>正在处理安装或交接，等待服务端确认结果；此状态不代表更新已完成。</span>}
        {schedule.status === 'failed' && <span className={styles.error}>
          {distributionUpdateFailureMessage(schedule.error || '')}
        </span>}
      </div>}

      {distribution && <>
        <div className={styles.controls}>
          <label className={styles.field}>
            <span>预约时间</span>
            <Input type="datetime-local" size="small" value={localTime} disabled={!!pending || activeSchedule}
              onChange={(event) => { setLocalTime(event.target.value); setConfirmation(null); setFormError(''); }} />
          </label>
          <label className={styles.field}>
            <span>时区（IANA）</span>
            <Input size="small" value={timezone} list={timezoneListId} placeholder="Asia/Shanghai"
              disabled={!!pending || activeSchedule}
              onChange={(event) => { setTimezone(event.target.value); setConfirmation(null); setFormError(''); }} />
            <datalist id={timezoneListId}>
              {[...new Set([browserTimezone(), 'UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'America/Los_Angeles'])]
                .map((zone) => <option key={zone} value={zone} />)}
            </datalist>
          </label>
          <Button size="small" icon={<ClockCircleOutlined />} disabled={!canSchedule || !localTime}
            onClick={() => prepare('schedule')}>预约更新</Button>
          <Button size="small" disabled={!canSchedule} onClick={() => prepare('now')}>立即更新</Button>
        </div>
        {formError && <span className={styles.error} role="alert">{formError}</span>}
        {confirmation && <div className={styles.confirmation} role="group" aria-label="确认更新计划">
          <span>
            确认将当前连接服务更新至 <strong>{confirmation.version}</strong>？
            {confirmation.action === 'now' ? '立即进入更新队列' : `${formatTime(confirmation.at, confirmation.timezone)}（${confirmation.timezone}）执行`}；
            空闲后安装并重启，忙碌则延期。
          </span>
          <Button size="small" type="primary" icon={<CheckOutlined />}
            loading={pending === confirmation.action} disabled={!canSchedule}
            onClick={() => { void run(confirmation.action, confirmation); }}>
            {confirmation.action === 'now' ? '确认立即排队' : '确认预约'}
          </Button>
          <Button size="small" type="text" disabled={!!pending} onClick={() => setConfirmation(null)}>返回</Button>
        </div>}
      </>}
    </section>
  );
}
