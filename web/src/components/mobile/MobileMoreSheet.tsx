import {
  CloudServerOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  DesktopOutlined,
  ExperimentOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { history, useLocation } from '@umijs/max';
import { Drawer } from 'antd';
import type { ReactNode } from 'react';

/**
 * 移动端「更多」动作面板 —— 底部 TabBar 第 5 个 tab 弹出的底部 Sheet，
 * 承接 TabBar 放不下的低频页面入口（对齐 design.reuse-antd-pro.md 第 2 章：
 * 低频入口收敛进底部 Sheet，而不是挤占 3–5 个底部 Tab）。
 *
 * 入口图标与桌面侧边菜单（config/routes.ts 的 icon 字段）保持同一语义。
 */

export interface MoreEntry {
  key: string;
  path: string;
  label: string;
  icon: ReactNode;
  /** 命中判定：当前路由以此前缀开头即在面板内高亮该入口 */
  match: (pathname: string) => boolean;
}

export const MORE_ENTRIES: MoreEntry[] = [
  {
    key: 'dashboard',
    path: '/dashboard',
    label: '仪表盘',
    icon: <DashboardOutlined />,
    match: (p) => p === '/' || p.startsWith('/dashboard'),
  },
  {
    key: 'models',
    path: '/models',
    label: '模型目录',
    icon: <DatabaseOutlined />,
    match: (p) => p.startsWith('/models') || p.includes('/models'),
  },
  {
    key: 'studio',
    path: '/studio/image',
    label: '灵感工坊',
    icon: <ExperimentOutlined />,
    match: (p) => p.startsWith('/studio'),
  },
  {
    key: 'fabric-servers',
    path: '/fabric/servers',
    label: 'Server 管理',
    icon: <CloudServerOutlined />,
    match: (p) => p.startsWith('/fabric/servers') || p.startsWith('/fabric/control-planes'),
  },
  {
    key: 'fabric-ssh-hosts',
    path: '/fabric/ssh-hosts',
    label: 'SSH 开发机',
    icon: <DesktopOutlined />,
    match: (p) => p.startsWith('/fabric/ssh-hosts'),
  },
];

/** 当前路由是否落在「更多」面板覆盖的页面集合内（用于 TabBar 高亮第 5 个 tab）。 */
export const isMoreEntryPath = (pathname: string) =>
  MORE_ENTRIES.some((entry) => entry.match(pathname));

interface Props {
  open: boolean;
  onClose: () => void;
}

const MobileMoreSheet = ({ open, onClose }: Props) => {
  const location = useLocation();
  const pathname = location.pathname || '';

  return (
    <Drawer
      rootClassName="mobile-more-sheet"
      placement="bottom"
      open={open}
      onClose={onClose}
      height="auto"
      title="更多"
    >
      <nav className="mobile-more-entries" aria-label="更多页面">
        {MORE_ENTRIES.map((entry) => {
          const active = entry.match(pathname);
          return (
            <button
              key={entry.key}
              type="button"
              className={`mobile-more-entry${active ? ' mobile-more-entry-active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => {
                onClose();
                if (!active) history.push(entry.path);
              }}
            >
              <span className="mobile-more-entry-icon">{entry.icon}</span>
              <span className="mobile-more-entry-label">{entry.label}</span>
              <RightOutlined className="mobile-more-entry-arrow" aria-hidden />
            </button>
          );
        })}
      </nav>
    </Drawer>
  );
};

export default MobileMoreSheet;
