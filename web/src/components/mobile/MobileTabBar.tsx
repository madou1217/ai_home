import {
  MessageOutlined,
  TeamOutlined,
  BarChartOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { history, useLocation } from '@umijs/max';
import type { ReactNode } from 'react';

/**
 * 移动端底部 TabBar —— 跨页主导航（对齐 design.reuse-antd-pro.md 第 2 章：
 * 桌面「侧边菜单」在手机上收敛成 3–5 个底部 Tab）。
 *
 * - 仅移动端可见：显隐由 mobile-shell.css 的媒体查询控制（桌面 display:none）。
 * - 沉浸态（如 Chat 对话视图）自动隐藏：由 body[data-mobile-immersive] + CSS 接管，
 *   页面只需切换该 data 属性，无需和本组件耦合。
 * - 通过 childrenRender 注入到 ProLayout content 之上，全站生效。
 */

interface TabItem {
  key: string;
  path: string;
  label: string;
  icon: ReactNode;
  /** 命中判定：当前路由以此前缀开头即高亮（覆盖子路由） */
  match: (pathname: string) => boolean;
}

const TABS: TabItem[] = [
  {
    key: 'chat',
    path: '/chat',
    label: '会话',
    icon: <MessageOutlined />,
    match: (p) => p === '/chat' || p.startsWith('/chat'),
  },
  {
    key: 'accounts',
    path: '/accounts',
    label: '账号',
    icon: <TeamOutlined />,
    match: (p) => p.startsWith('/accounts'),
  },
  {
    key: 'usage',
    path: '/usage',
    label: '用量',
    icon: <BarChartOutlined />,
    match: (p) => p.startsWith('/usage'),
  },
  {
    key: 'settings',
    path: '/settings',
    label: '设置',
    icon: <SettingOutlined />,
    match: (p) => p.startsWith('/settings'),
  },
];

export default function MobileTabBar() {
  const location = useLocation();
  const pathname = location.pathname || '';

  return (
    <nav className="mobile-tabbar" aria-label="主导航">
      {TABS.map((tab) => {
        const active = tab.match(pathname);
        return (
          <button
            key={tab.key}
            type="button"
            className={`mobile-tabbar-item${active ? ' mobile-tabbar-item-active' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => {
              if (!active) history.push(tab.path);
            }}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
