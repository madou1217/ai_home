import { useSyncExternalStore } from 'react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { relativeTimeClock } from '@/services/relative-time-clock';

dayjs.extend(relativeTime);

/** 更新时间来自原生记录；时钟只更新文案，绝不修改会话时间或请求服务器。 */
export default function SessionRelativeTime({ timestamp }: { timestamp: number }) {
  const now = useSyncExternalStore(
    relativeTimeClock.subscribe,
    relativeTimeClock.getSnapshot,
    relativeTimeClock.getSnapshot,
  );
  const time = dayjs(timestamp).locale('zh-cn');
  if (!Number.isFinite(timestamp) || timestamp <= 0 || !time.isValid()) return <>—</>;
  return (
    <time dateTime={time.toISOString()} title={time.format('YYYY-MM-DD HH:mm:ss')}>
      {time.from(now)}
    </time>
  );
}
