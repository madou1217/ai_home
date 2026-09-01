import { memo } from 'react';
import { Tooltip } from 'antd';
import { WifiOutlined } from '@ant-design/icons';
import styles from './composer/composer.module.css';

export interface ConnectionPulseBadgeProps {
  status: 'connected' | 'reconnecting' | 'disconnected';
  latencyMs?: number;
  label?: string;
}

/**
 * HarmonyOS 6 风格实时长连接心跳水滴指示环
 * 具备声光微呼吸动力学、超级圆角与通透亚克力毛玻璃胶囊
 */
export const ConnectionPulseBadge = memo(function ConnectionPulseBadge({
  status = 'connected',
  latencyMs,
  label,
}: ConnectionPulseBadgeProps) {
  const statusColorClass =
    status === 'connected'
      ? styles.pulseBadgeConnected
      : status === 'reconnecting'
      ? styles.pulseBadgeReconnecting
      : styles.pulseBadgeDisconnected;

  const tooltipTitle =
    status === 'connected'
      ? `实时连接正常 ${latencyMs ? `(${latencyMs}ms)` : ''}`
      : status === 'reconnecting'
      ? '正在重连上游端点...'
      : '连接已断开';

  return (
    <Tooltip title={tooltipTitle} placement="top">
      <div className={`${styles.connectionPulseCapsule} ${statusColorClass}`}>
        <span className={styles.pulseDotWrapper}>
          <span className={styles.pulseDotCore} />
          <span className={styles.pulseDotRing} />
        </span>
        <span className={styles.pulseLabel}>
          <WifiOutlined /> {label || (status === 'connected' ? (latencyMs ? `${latencyMs}ms` : '已连接') : status === 'reconnecting' ? '重连中' : '离线')}
        </span>
      </div>
    </Tooltip>
  );
});

export default ConnectionPulseBadge;
