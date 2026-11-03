import { memo, type ReactNode } from 'react';
import { Button, Tag } from 'antd';
import {
  DownloadOutlined,
  SettingOutlined,
  SyncOutlined,
  AppstoreOutlined,
} from '@ant-design/icons';
import styles from './HarmonyAppMarketCard.module.css';

export interface AppMarketItemProps {
  id: string;
  name: string;
  version?: string;
  description: string;
  icon?: ReactNode;
  category?: string;
  installed?: boolean;
  installing?: boolean;
  onInstall?: () => void;
  onManage?: () => void;
}

/**
 * 应用市场卡片：HUD 小切角面板，图标 / 名称 / 版本 / 安装状态（LED）与操作
 */
export const HarmonyAppMarketCard = memo(function HarmonyAppMarketCard({
  name,
  version,
  description,
  icon,
  category,
  installed = false,
  installing = false,
  onInstall,
  onManage,
}: AppMarketItemProps) {
  return (
    <div className={`${styles.marketCard} hud-panel hud-panel--sm`}>
      <div className={styles.cardTop}>
        <div className={styles.iconWrapper}>
          {icon || <AppstoreOutlined className={styles.fallbackIcon} />}
        </div>
        <div className={styles.titleInfo}>
          <div className={styles.nameLine}>
            <strong className={styles.appName}>{name}</strong>
            {version && <span className={styles.appVersion}>v{version}</span>}
          </div>
          {category && <Tag className={styles.categoryTag}>{category}</Tag>}
        </div>
      </div>

      <p className={styles.description}>{description}</p>

      <div className={styles.cardBottom}>
        <div className={styles.installState}>
          {installed ? (
            <span className={styles.installedBadge}>
              <span className="hud-led hud-led--ok" aria-hidden="true" /> 已部署
            </span>
          ) : (
            <span className={styles.uninstalledBadge}>
              <span className="hud-led" aria-hidden="true" /> 未安装
            </span>
          )}
        </div>

        <div className={styles.actions}>
          {installed ? (
            <Button
              type="default"
              size="small"
              icon={<SettingOutlined />}
              onClick={onManage}
              className={styles.manageBtn}
            >
              管理
            </Button>
          ) : (
            <Button
              type="primary"
              size="small"
              icon={installing ? <SyncOutlined spin /> : <DownloadOutlined />}
              loading={installing}
              onClick={onInstall}
              className={styles.installBtn}
            >
              获取
            </Button>
          )}
        </div>
      </div>
    </div>
  );
});

export default HarmonyAppMarketCard;
