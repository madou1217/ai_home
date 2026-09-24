import { RightOutlined } from '@ant-design/icons';
import { history, useLocation } from '@umijs/max';
import { useThemeMode } from '@/hooks/use-theme-mode';
import { crossTabSync } from '@/services/cross-tab-session-sync';
import { applyThemeMode } from '@/services/theme-persistence';
import DetailSheet from '../ui/DetailSheet';
import { MOBILE_MORE_ITEMS } from './mobile-nav';

/** 「更多」底部面板：低频页面入口 + 深色 / 日光主题切换（与桌面顶栏同一存储与跨标签同步）。 */
export default function MobileHudMoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const location = useLocation();
  const theme = useThemeMode();
  const pathname = location.pathname || '';

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyThemeMode(next);
    crossTabSync.broadcast('THEME_CHANGED', { theme: next });
  };

  return (
    <DetailSheet open={open} onClose={onClose} code="SYS // MORE" title="更多入口" destroyOnClose={false}>
      <div className="mhud-more">
        {MOBILE_MORE_ITEMS.map((item) => {
          const active = pathname === item.path || pathname.startsWith(`${item.path}/`);
          return (
            <button
              key={item.path}
              type="button"
              className={`mhud-more__item${active ? ' is-active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => {
                onClose();
                if (!active) history.push(item.path);
              }}
            >
              <span className="mhud-more__code">[{item.code}]</span>
              <span className="mhud-more__text">
                <span className="mhud-more__label">{item.label}</span>
                <span className="mhud-more__desc">{item.desc}</span>
              </span>
              <RightOutlined className="mhud-more__arrow" />
            </button>
          );
        })}
        <button type="button" className="mhud-more__item mhud-more__item--toggle" onClick={toggleTheme}>
          <span className="mhud-more__code">[--]</span>
          <span className="mhud-more__text">
            <span className="mhud-more__label">显示模式</span>
            <span className="mhud-more__desc">MODE</span>
          </span>
          <span className="mhud-more__value">{theme === 'dark' ? 'NIGHT' : 'DAY'}</span>
        </button>
      </div>
    </DetailSheet>
  );
}
