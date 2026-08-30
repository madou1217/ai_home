import { memo } from 'react';
import { Tag, Button } from 'antd';
import {
  BranchesOutlined,
  ForkOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
} from '@ant-design/icons';
import styles from './chat.module.css';

export interface BranchNode {
  id: string;
  title: string;
  messageCount: number;
  updatedAt?: string | number;
  isActive?: boolean;
}

export interface SessionBranchGraphProps {
  branches: BranchNode[];
  activeBranchId: string;
  onSelectBranch: (id: string) => void;
  onForkCurrent?: () => void;
}

/**
 * HarmonyOS 6 连续曲率会话分支可视化组件
 */
export const SessionBranchGraph = memo(function SessionBranchGraph({
  branches,
  activeBranchId,
  onSelectBranch,
  onForkCurrent,
}: SessionBranchGraphProps) {
  if (!branches || branches.length === 0) return null;

  return (
    <div className={styles.branchGraphContainer}>
      <div className={styles.branchGraphHeader}>
        <div className={styles.branchGraphTitle}>
          <BranchesOutlined /> 会话分支管理 (Branches)
        </div>
        {onForkCurrent ? (
          <Button
            size="small"
            type="dashed"
            icon={<ForkOutlined />}
            onClick={onForkCurrent}
            className={styles.forkBtn}
          >
            派生新分支
          </Button>
        ) : null}
      </div>

      <div className={styles.branchNodesList}>
        {branches.map((b, idx) => {
          const isActive = b.id === activeBranchId;
          return (
            <div
              key={b.id}
              className={`${styles.branchNodeItem} ${isActive ? styles.branchNodeActive : ''}`}
              onClick={() => onSelectBranch(b.id)}
            >
              <div className={styles.branchIndicator}>
                {isActive ? (
                  <CheckCircleFilled className={styles.branchActiveIcon} />
                ) : (
                  <span className={styles.branchDot} />
                )}
                {idx < branches.length - 1 ? <span className={styles.branchLine} /> : null}
              </div>

              <div className={styles.branchNodeInfo}>
                <div className={styles.branchNodeHeader}>
                  <span className={styles.branchNodeTitle}>{b.title}</span>
                  {isActive ? (
                    <Tag color="processing" className={styles.branchTag}>
                      当前
                    </Tag>
                  ) : null}
                </div>
                <div className={styles.branchNodeMeta}>
                  <span>{b.messageCount} 条消息</span>
                  {b.updatedAt ? (
                    <span>
                      <ClockCircleOutlined /> {new Date(b.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

export default SessionBranchGraph;
