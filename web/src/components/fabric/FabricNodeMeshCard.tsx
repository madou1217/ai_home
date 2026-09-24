import { memo } from 'react';
import { Button, Space, Tag } from 'antd';
import {
  CloudServerOutlined,
  WifiOutlined,
  ThunderboltFilled,
  SettingOutlined,
} from '@ant-design/icons';
import styles from './FabricNodeMeshCard.module.css';

export interface FabricNodeMeshCardProps {
  id: string;
  name: string;
  host: string;
  role?: 'control_plane' | 'worker' | 'relay';
  status: 'online' | 'busy' | 'offline';
  latencyMs?: number;
  cpuUsage?: number;
  memoryUsage?: number;
  activeSessions?: number;
  onConnect?: () => void;
  onManage?: () => void;
}

/**
 * Fabric Mesh 节点卡片：扁平 surface + 发丝线描边，状态用实心圆点表达
 */
export const FabricNodeMeshCard = memo(function FabricNodeMeshCard({
  name,
  host,
  role = 'worker',
  status = 'online',
  latencyMs,
  cpuUsage,
  memoryUsage,
  activeSessions,
  onConnect,
  onManage,
}: FabricNodeMeshCardProps) {
  const isOnline = status === 'online';
  const isBusy = status === 'busy';

  const roleLabel = role === 'control_plane' ? '控制面中心' : role === 'relay' ? '中继代理' : '计算节点';

  return (
    <div className={`${styles.meshCard} ${isOnline ? '' : isBusy ? styles.cardBusy : styles.cardOffline}`}>
      <div className={styles.cardHeader}>
        <div className={styles.avatarWrap}>
          <div className={styles.nodeIcon}>
            <CloudServerOutlined />
          </div>
          <span className={`${styles.radarPulse} ${isOnline ? styles.pulseOnline : isBusy ? styles.pulseBusy : styles.pulseOffline}`} />
        </div>

        <div className={styles.titleInfo}>
          <div className={styles.nameLine}>
            <strong className={styles.nodeName}>{name}</strong>
            <Tag className={styles.roleTag}>{roleLabel}</Tag>
          </div>
          <span className={styles.nodeHost}>{host}</span>
        </div>
      </div>

      <div className={styles.cardBody}>
        <div className={styles.metricsRow}>
          {latencyMs !== undefined ? (
            <div className={styles.metricItem}>
              <span className={styles.metricLabel}>往返时延 (RTT)</span>
              <strong className={styles.metricValue}>
                <WifiOutlined className={styles.metricIcon} />
                {latencyMs}ms
              </strong>
            </div>
          ) : null}
          {cpuUsage !== undefined ? (
            <div className={styles.metricItem}>
              <span className={styles.metricLabel}>CPU 负载</span>
              <strong className={styles.metricValue}>{cpuUsage}%</strong>
            </div>
          ) : null}
          {memoryUsage !== undefined ? (
            <div className={styles.metricItem}>
              <span className={styles.metricLabel}>内存占用</span>
              <strong className={styles.metricValue}>{memoryUsage}%</strong>
            </div>
          ) : null}
        </div>
      </div>

      <div className={styles.cardFooter}>
        <div className={styles.sessionState}>
          {activeSessions !== undefined ? (
            <span className={styles.sessionCount}>
              <ThunderboltFilled className={styles.sessionIcon} /> {activeSessions} 活跃会话
            </span>
          ) : (
            <span className={styles.statusLabel}>
              {isOnline ? '就绪' : isBusy ? '忙碌中' : '离线'}
            </span>
          )}
        </div>

        <Space size={8}>
          {onConnect && (
            <Button type="primary" size="small" className={styles.actionBtn} onClick={onConnect}>
              连接
            </Button>
          )}
          {onManage && (
            <Button size="small" icon={<SettingOutlined />} className={styles.actionBtn} onClick={onManage}>
              配置
            </Button>
          )}
        </Space>
      </div>
    </div>
  );
});

export default FabricNodeMeshCard;
