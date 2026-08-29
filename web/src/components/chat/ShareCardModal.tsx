import { memo, useRef, useState } from 'react';
import { Modal, Button, Tag, message as antdMessage } from 'antd';
import {
  ShareAltOutlined,
  DownloadOutlined,
  CopyOutlined,
  CheckOutlined,
  RobotOutlined,
  UserOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import styles from './chat.module.css';

export interface ShareCardModalProps {
  open: boolean;
  onClose: () => void;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  timestamp?: number | string;
}

/**
 * HarmonyOS 6 风格高质感分享卡片弹窗
 * 具备通透多层毛玻璃背景、超级连续圆角、品牌水印标徽与一键复制/保存
 */
export const ShareCardModal = memo(function ShareCardModal({
  open,
  onClose,
  role,
  content,
  model,
  timestamp,
}: ShareCardModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const formattedTime = timestamp
    ? dayjs(timestamp).format('YYYY-MM-DD HH:mm')
    : dayjs().format('YYYY-MM-DD HH:mm');

  const handleCopyText = () => {
    if (!content) return;
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      antdMessage.success('已复制卡片文本内容', 1.2);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={540}
      centered
      title={
        <div className={styles.shareModalTitle}>
          <ShareAltOutlined /> 生成分享卡片
        </div>
      }
      className={styles.shareModal}
    >
      <div className={styles.shareModalBody}>
        {/* 卡片容器 */}
        <div ref={cardRef} className={styles.harmonyShareCard}>
          <div className={styles.shareCardHeader}>
            <div className={styles.shareCardAuthor}>
              <div className={styles.shareCardAvatar}>
                {role === 'assistant' ? <RobotOutlined /> : <UserOutlined />}
              </div>
              <div className={styles.shareCardMeta}>
                <span className={styles.shareCardAuthorName}>
                  {role === 'assistant' ? (model || 'AI Assistant') : 'User'}
                </span>
                <span className={styles.shareCardTime}>{formattedTime}</span>
              </div>
            </div>
            <Tag color="processing" className={styles.shareCardTag}>
              AI Home
            </Tag>
          </div>

          <div className={styles.shareCardContent}>
            <p className={styles.shareCardText}>{content}</p>
          </div>

          <div className={styles.shareCardFooter}>
            <div className={styles.shareCardBrand}>
              <span className={styles.shareCardLogo}>⚡</span>
              <span className={styles.shareCardBrandText}>AI Home Console · HarmonyOS 6</span>
            </div>
          </div>
        </div>

        {/* 底部操作区 */}
        <div className={styles.shareModalActions}>
          <Button
            type="primary"
            icon={copied ? <CheckOutlined /> : <CopyOutlined />}
            onClick={handleCopyText}
            className={styles.shareActionBtn}
          >
            {copied ? '已复制' : '复制文本'}
          </Button>
          <Button onClick={onClose} className={styles.shareActionBtn}>
            完成
          </Button>
        </div>
      </div>
    </Modal>
  );
});

export default ShareCardModal;
