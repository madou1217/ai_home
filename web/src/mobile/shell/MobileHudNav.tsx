import {
  AppstoreOutlined,
  BarChartOutlined,
  DashboardOutlined,
  MessageOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { history } from '@umijs/max';
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { MobileNavKey } from '../mobile-routes';
import MobileHudMoreSheet from './MobileHudMoreSheet';
import { MOBILE_NAV_TABS } from './mobile-nav';

const ICONS: Record<string, ReactNode> = {
  dashboard: <DashboardOutlined />,
  accounts: <TeamOutlined />,
  chat: <MessageOutlined />,
  usage: <BarChartOutlined />,
};

/** 拇指区底部导航：4 个主 Tab + 「更多」，每格 ≥56px 高、全宽均分。 */
export default function MobileHudNav({ active }: { active: MobileNavKey | null }) {
  const [moreOpen, setMoreOpen] = useState(false);
  return (
    <>
      <nav className="mhud-nav" aria-label="主导航">
        {MOBILE_NAV_TABS.map((tab) => {
          const isActive = active === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              className={`mhud-nav__item${isActive ? ' is-active' : ''}`}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => {
                if (!isActive) history.push(tab.path);
              }}
            >
              <span className="mhud-nav__icon">{ICONS[tab.key]}</span>
              <span className="mhud-nav__label">{tab.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={`mhud-nav__item${active === 'more' ? ' is-active' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
        >
          <span className="mhud-nav__icon"><AppstoreOutlined /></span>
          <span className="mhud-nav__label">更多</span>
        </button>
      </nav>
      <MobileHudMoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
    </>
  );
}
