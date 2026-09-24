import { providerNames } from '@/components/chat/ProviderIcon';
import { getRuntimeStatusMeta } from '@/components/runtime/RuntimeStatusTag';
import { normalizeQueueCount, type ProviderRow } from '@/features/dashboard/dashboard-presentation';
import { DetailSheet, KeyValue } from '@/mobile/ui';
import { runtimeColorTone } from './dashboard-tones';
import styles from '../MobileDashboard.module.css';

interface Props {
  open: boolean;
  /** 选中 Provider 的实时行（随管理快照刷新）；关闭动画期间保留最后一次选择 */
  row: ProviderRow | null;
  onClose: () => void;
}

/** Provider 运行状态详情：可调度账号、队列、请求计数与运行时状态分布（均来自 management status / metrics）。 */
export default function ProviderStatusSheet({ open, row, onClose }: Props) {
  if (!row) return null;
  const pct = row.total > 0 ? Math.round((row.active / row.total) * 100) : 0;
  const offline = row.total === 0;
  const running = normalizeQueueCount(row.queue?.running);
  const queued = normalizeQueueCount(row.queue?.queued);
  const conc = normalizeQueueCount(row.queue?.maxConcurrency, 1);
  const statusEntries = Object.entries(row.statuses || {}).filter(([, count]) => Number(count) > 0);
  const ratioTone = offline ? 'muted' : pct < 100 ? 'warn' : 'ok';

  return (
    <DetailSheet
      open={open}
      onClose={onClose}
      code="PROVIDER"
      title={providerNames[row.provider as keyof typeof providerNames] || row.provider}
    >
      <div className={styles.sheetGauge}>
        <span className={`${styles.sheetGaugeValue} mhud-tone--${ratioTone}`}>
          {row.active}<span className={styles.sheetGaugeUnit}>/ {row.total}</span>
        </span>
        <span className="hud-label">可调度账号</span>
        <span className="mhud-track" aria-hidden="true">
          <span className={`mhud-track__fill mhud-bg--${ratioTone}`} style={{ width: `${offline ? 0 : pct}%` }} />
        </span>
      </div>
      <KeyValue
        rows={[
          { key: 'running', label: '队列运行中', value: running },
          { key: 'queued', label: '队列排队', value: queued },
          { key: 'conc', label: '并发上限', value: conc },
          { key: 'requests', label: '请求', value: row.requests },
          { key: 'success', label: '成功', value: row.success, tone: row.success > 0 ? 'ok' : undefined },
          { key: 'failures', label: '失败', value: row.failures, tone: row.failures > 0 ? 'err' : undefined },
          ...statusEntries.map(([status, count]) => {
            const meta = getRuntimeStatusMeta(status);
            return {
              key: `status-${status}`,
              label: (
                <span className="mhud-status">
                  <span className={`hud-led hud-led--${runtimeColorTone(meta.color) === 'muted' ? 'info' : runtimeColorTone(meta.color)}`} />
                  {meta.label}
                </span>
              ),
              value: count,
              tone: runtimeColorTone(meta.color)
            };
          })
        ]}
      />
    </DetailSheet>
  );
}
