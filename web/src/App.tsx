import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { ConfigProvider, Grid, Layout } from 'antd';
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  BarChartOutlined,
  ClusterOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  TeamOutlined,
  MessageOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import aiHomeLogo from '@/assets/brand/ai-home-logo.png';
import aiHomeMark from '@/assets/brand/ai-home-mark.png';
import ControlPlaneProfileSelect from '@/components/control-plane/ControlPlaneProfileSelect';
import {
  addControlPlaneProfilesChangeListener,
  listControlPlaneProfiles
} from '@/services/control-plane-profiles';
import {
  addActiveControlPlaneProfileChangeListener,
  getActiveControlPlaneProfileId
} from '@/services/control-plane-selection';
import {
  FABRIC_SERVER_SETUP_HREF,
  resolveFabricServerSetupTarget,
  resolveFabricProfileGateState,
  shouldRedirectToFabricServerSetup
} from '@/services/fabric-profile-gate';
import { throttle } from '@/utils/timing';
import './styles/App.css';

function lazyWithChunkRecovery(factory: () => Promise<{ default: React.ComponentType<any> }>) {
  return lazy(async () => {
    try {
      return await factory();
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error || '');
      const isChunkLoadFailure = /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk/i.test(message);
      if (isChunkLoadFailure && !sessionStorage.getItem('aih:chunk-reload-attempted')) {
        // 服务端部署新静态资源后，旧页面可能仍请求旧 hash chunk；只自动刷新一次避免循环。
        sessionStorage.setItem('aih:chunk-reload-attempted', String(Date.now()));
        window.location.reload();
      }
      throw error;
    }
  });
}

const { Header, Content } = Layout;
const Dashboard = lazyWithChunkRecovery(() => import('@/pages/Dashboard'));
const Accounts = lazyWithChunkRecovery(() => import('@/pages/Accounts'));
const Chat = lazyWithChunkRecovery(() => import('@/pages/Chat'));
const ModelUsage = lazyWithChunkRecovery(() => import('@/pages/ModelUsage'));
const Models = lazyWithChunkRecovery(() => import('@/pages/Models'));
const Settings = lazyWithChunkRecovery(() => import('@/pages/Settings'));
const FabricServerSetup = lazyWithChunkRecovery(() => import('@/pages/FabricServerSetup'));
const FabricNodes = lazyWithChunkRecovery(() => import('@/pages/FabricNodes'));
const FabricWebrtcLab = lazyWithChunkRecovery(() => import('@/pages/FabricWebrtcLab'));

interface NavItem {
  key: string;
  icon: ReactNode;
  label: string;
  mobileLabel: string;
  primary?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    key: '/',
    icon: <DashboardOutlined />,
    label: '仪表盘',
    mobileLabel: '概览',
    primary: true
  },
  {
    key: '/accounts',
    icon: <TeamOutlined />,
    label: '账号',
    mobileLabel: '账号',
    primary: true
  },
  {
    key: '/chat',
    icon: <MessageOutlined />,
    label: '会话',
    mobileLabel: '会话',
    primary: true
  },
  {
    key: '/usage',
    icon: <BarChartOutlined />,
    label: '用量',
    mobileLabel: '用量',
    primary: true
  },
  {
    key: '/models',
    icon: <DatabaseOutlined />,
    label: '模型',
    mobileLabel: '模型'
  },
  {
    key: '/fabric/nodes',
    icon: <ClusterOutlined />,
    label: 'Fabric Nodes',
    mobileLabel: '节点'
  },
  {
    key: '/settings',
    icon: <SettingOutlined />,
    label: '设置',
    mobileLabel: '设置',
    primary: true
  }
];

function resolveSelectedKey(pathname: string) {
  if (pathname === '/server-setup') return '/settings';
  const match = NAV_ITEMS.find((item) => (
    item.key === '/'
      ? pathname === '/'
      : pathname === item.key || pathname.startsWith(`${item.key}/`)
  ));

  if (!match && pathname.startsWith('/fabric/')) return '/settings';
  return match?.key || '/';
}

function AppContent() {
  const navigate = useNavigate();
  const location = useLocation();
  const screens = Grid.useBreakpoint();
  const [profiles, setProfiles] = useState(() => listControlPlaneProfiles());
  const [activeProfileId, setActiveProfileId] = useState(() => getActiveControlPlaneProfileId());
  const fabricGate = useMemo(
    () => resolveFabricProfileGateState(profiles, activeProfileId),
    [activeProfileId, profiles]
  );
  const isMobile = !screens.md;
  const selectedKey = resolveSelectedKey(location.pathname);
  const selectedNavItem = NAV_ITEMS.find((item) => item.key === selectedKey);
  const primaryNavItems = NAV_ITEMS.filter((item) => item.primary);
  const mobilePageTitle = selectedNavItem?.label || NAV_ITEMS[0].label;
  const isChat = location.pathname === '/chat';
  const appClassName = [
    'app-shell',
    isMobile ? 'app-shell--mobile' : 'app-shell--desktop',
    isChat ? 'app-shell--chat' : ''
  ].filter(Boolean).join(' ');

  useEffect(() => {
    const viewport = window.visualViewport;
    const applyViewportHeight = () => {
      const height = viewport?.height || window.innerHeight;
      document.documentElement.style.setProperty('--app-visual-viewport-height', `${height}px`);
      document.documentElement.classList.toggle(
        'app-keyboard-open',
        Boolean(viewport && height < window.screen.height * 0.78)
      );
    };
    // 移动端键盘弹出/滚动时 resize·scroll 高频触发，节流到 ~60ms（含首末触发）。
    const onViewportChange = throttle(applyViewportHeight, 60);
    applyViewportHeight();
    viewport?.addEventListener('resize', onViewportChange);
    viewport?.addEventListener('scroll', onViewportChange);
    window.addEventListener('resize', onViewportChange);
    return () => {
      onViewportChange.cancel();
      viewport?.removeEventListener('resize', onViewportChange);
      viewport?.removeEventListener('scroll', onViewportChange);
      window.removeEventListener('resize', onViewportChange);
    };
  }, []);

  useEffect(() => {
    const refreshFabricProfiles = () => {
      setProfiles(listControlPlaneProfiles());
      setActiveProfileId(getActiveControlPlaneProfileId());
    };
    const unsubscribeProfiles = addControlPlaneProfilesChangeListener(refreshFabricProfiles);
    const unsubscribeActive = addActiveControlPlaneProfileChangeListener(refreshFabricProfiles);
    window.addEventListener('focus', refreshFabricProfiles);
    return () => {
      unsubscribeProfiles();
      unsubscribeActive();
      window.removeEventListener('focus', refreshFabricProfiles);
    };
  }, []);

  const handleNavigate = (key: string) => {
    navigate(key);
  };

  const routeFallback = (
    <div className="app-route-fallback">
      页面加载中...
    </div>
  );

  return (
    <Layout className={appClassName}>
      <Layout className="app-workspace">
        {!isMobile ? (
          <aside className="app-sidebar" aria-label="AI Home 主导航">
            <div className="app-sidebar-brand">
              <div className="app-logo-card" aria-hidden="true">
                <img src={aiHomeLogo} alt="" className="app-logo-full" />
              </div>
              <div className="app-brand-copy">
                <div className="app-brand-kicker">本地编排</div>
                <div className="app-brand-name">AIH</div>
              </div>
            </div>
            <nav className="app-nav-stack">
              <div className="app-nav-section">工作区</div>
              {NAV_ITEMS.map((item) => {
                const active = selectedKey === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => handleNavigate(item.key)}
                    className={`app-nav-item${active ? ' app-nav-item--active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                  >
                    <span className="app-nav-icon">{item.icon}</span>
                    <span className="app-nav-label">{item.label}</span>
                    <span className="app-nav-signal" aria-hidden="true" />
                  </button>
                );
              })}
            </nav>
            <div className="app-sidebar-footer">
              <ControlPlaneProfileSelect
                label="Server"
                size="compact"
                manageHref={FABRIC_SERVER_SETUP_HREF}
                emptyLabel="配置"
                manageLabel="配置"
                showSummary
              />
            </div>
          </aside>
        ) : null}

        <Layout className="app-main">
          {/* 移动端保留菜单入口；桌面端由页面自身标题承载上下文，避免双标题。 */}
          {isMobile ? (
            <Header className="app-topbar">
              <div className="app-topbar-left">
                <div className="app-mobile-logo" aria-hidden="true">
                  <img src={aiHomeMark} alt="" className="app-logo-image" />
                </div>
                <div className="app-page-copy">
                  <div className="app-page-title">{mobilePageTitle}</div>
                </div>
              </div>
              <ControlPlaneProfileSelect
                label=""
                size="compact"
                manageHref={FABRIC_SERVER_SETUP_HREF}
                emptyLabel="配置"
                manageLabel="配置"
              />
            </Header>
          ) : null}

          <Content className={`app-content${isChat ? ' app-content--chat' : ''}`}>
            <Suspense fallback={routeFallback}>
              {shouldRedirectToFabricServerSetup(fabricGate, location.pathname, location.search) ? (
                <Navigate to={resolveFabricServerSetupTarget(location.search)} replace />
              ) : (
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/accounts" element={<Accounts />} />
                  <Route path="/chat" element={<Chat />} />
                  <Route path="/usage" element={<ModelUsage />} />
                  <Route path="/models" element={<Models />} />
                  <Route path="/accounts/:provider/:accountId/models" element={<Models />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/server-setup" element={<FabricServerSetup />} />
                  <Route path="/fabric/nodes" element={<FabricNodes />} />
                  <Route path="/fabric/webrtc-lab" element={<FabricWebrtcLab />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              )}
            </Suspense>
          </Content>
        </Layout>
      </Layout>

      {isMobile ? (
        <nav className="app-mobile-nav" aria-label="主导航">
          {primaryNavItems.map((item) => {
            const active = selectedKey === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => handleNavigate(item.key)}
                className={`app-mobile-nav-item${active ? ' app-mobile-nav-item--active' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                <span className="app-mobile-nav-icon">{item.icon}</span>
                <span className="app-mobile-nav-label">{item.mobileLabel}</span>
              </button>
            );
          })}
        </nav>
      ) : null}
    </Layout>
  );
}

function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        // antd 全局主题 = 设计规范（design-tokens.css）的 JS 镜像。
        // 圆角 / 按钮色 / 控件高度统一在此，避免各处自定义。详见 web/DESIGN.md。
        token: {
          colorPrimary: '#171717',     // --color-brand
          colorInfo: '#2563eb',        // --color-info
          colorSuccess: '#15803d',     // --color-success
          colorWarning: '#d97706',     // --color-warning
          colorError: '#dc2626',       // --color-danger
          borderRadius: 10,            // 标准圆角：输入框 / 按钮 = --radius-md
          borderRadiusLG: 14,
          borderRadiusSM: 8,           // --radius-sm
          borderRadiusXS: 6,           // --radius-xs
          controlHeight: 36,           // 统一控件高度（对齐基线）
          colorBgLayout: '#f8fafc',    // --color-bg
          colorBgContainer: '#ffffff', // --color-surface
          colorBorder: '#e2e8f0',      // --color-border
          colorBorderSecondary: '#eef2f7',
          colorText: '#1e293b',        // --color-text
          colorTextSecondary: '#64748b', // --color-muted
          fontFamily: "'Manrope', 'HarmonyOS Sans SC', 'Noto Sans SC', sans-serif",
          fontSize: 14,
          boxShadow: '0 8px 24px rgba(15, 23, 42, 0.10)' // --elevation-3
        },
        components: {
          Layout: {
            bodyBg: '#f8fafc',
            headerBg: '#ffffff',
            siderBg: '#ffffff'
          },
          Menu: {
            itemBorderRadius: 8,
            itemSelectedBg: '#eef2f6',
            itemSelectedColor: '#111418',
            itemHoverBg: '#f6f8fa'
          },
          Card: {
            borderRadiusLG: 16
          },
          Button: {
            borderRadius: 10,
            controlHeight: 36,
            fontWeight: 600,
            primaryShadow: 'none',
            defaultShadow: 'none'
          },
          Input: { borderRadius: 10, controlHeight: 36 },
          Select: { borderRadius: 10, controlHeight: 36 },
          Modal: { borderRadiusLG: 16 },
          Tag: { borderRadiusSM: 6 }
        }
      }}
    >
      <BrowserRouter basename="/ui">
        <AppContent />
      </BrowserRouter>
    </ConfigProvider>
  );
}

export default App;
