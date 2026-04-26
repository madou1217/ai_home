import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { ConfigProvider, Layout, Menu, Grid } from 'antd';
import { Suspense, lazy, useState } from 'react';
import type { ReactNode } from 'react';
import {
  DashboardOutlined,
  TeamOutlined,
  MessageOutlined,
  SettingOutlined
} from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import aiHomeIcon from '@/assets/icons/ai-home.svg';
import './styles/App.css';

const { Header, Sider, Content } = Layout;
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Accounts = lazy(() => import('@/pages/Accounts'));
const Chat = lazy(() => import('@/pages/Chat'));
const Settings = lazy(() => import('@/pages/Settings'));

interface NavItem {
  key: string;
  icon: ReactNode;
  label: string;
}

function AppContent() {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;

  const allNavItems: NavItem[] = [
    {
      key: '/',
      icon: <DashboardOutlined />,
      label: '仪表盘'
    },
    {
      key: '/accounts',
      icon: <TeamOutlined />,
      label: '账号'
    },
    {
      key: '/chat',
      icon: <MessageOutlined />,
      label: '会话'
    },
    {
      key: '/settings',
      icon: <SettingOutlined />,
      label: '设置'
    }
  ];

  const desktopMenuItems = allNavItems.map((item) => ({
    key: item.key,
    icon: item.icon,
    label: item.label
  }));
  const mobileNavItems = allNavItems.filter((item) => item.key !== '/settings');
  const isChat = location.pathname === '/chat';
  const headerHeight = isMobile ? 56 : 64;
  const mobileNavHeight = isMobile ? 64 : 0;
  const routeFallback = (
    <div style={{
      height: '100%',
      minHeight: isChat ? '100%' : 240,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#6b7280',
      fontSize: isMobile ? 14 : 15
    }}
    >
      页面加载中...
    </div>
  );

  return (
    <Layout style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: '#f5f7fb' }}>
      <Header style={{
        padding: isMobile ? '0 14px' : '0 24px',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        flex: `0 0 ${headerHeight}px`,
        height: headerHeight,
        zIndex: 10
      }}>
        <div style={{
          color: 'white',
          fontSize: isMobile ? '18px' : '20px',
          fontWeight: 'bold',
          display: 'flex',
          alignItems: 'center',
          gap: 10
        }}>
          <img src={aiHomeIcon} alt="AI Home" style={{ width: isMobile ? 24 : 26, height: isMobile ? 24 : 26 }} />
          AI Home
        </div>
        {!isMobile ? (
          <div style={{ color: 'rgba(255, 255, 255, 0.85)', fontSize: '13px' }}>
            多账号 AI 管理平台
          </div>
        ) : null}
      </Header>

      <Layout style={{ flex: 1, minHeight: 0, overflow: 'hidden', paddingBottom: mobileNavHeight }}>
        {!isMobile ? (
          <Sider
            collapsible
            collapsed={collapsed}
            onCollapse={setCollapsed}
            theme="light"
            style={{
              background: '#fafafa',
              borderRight: '1px solid #e8e8e8',
              overflow: 'auto',
              height: '100%'
            }}
          >
            <Menu
              mode="inline"
              selectedKeys={[location.pathname]}
              items={desktopMenuItems}
              onClick={({ key }) => navigate(key)}
              style={{ borderRight: 0, background: 'transparent' }}
            />
          </Sider>
        ) : null}

        <Layout style={{
          padding: isChat ? 0 : (isMobile ? '12px' : '24px'),
          height: '100%',
          overflow: 'hidden'
        }}>
          <Content style={{
            padding: isChat ? 0 : (isMobile ? 14 : 24),
            margin: 0,
            background: '#fff',
            borderRadius: isChat ? 0 : (isMobile ? '18px' : '12px'),
            height: '100%',
            overflow: isChat ? 'hidden' : 'auto',
            boxShadow: isChat ? 'none' : '0 1px 2px rgba(0,0,0,0.03)',
            display: isChat ? 'flex' : 'block',
            flexDirection: 'column'
          }}>
            <Suspense fallback={routeFallback}>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/accounts" element={<Accounts />} />
                <Route path="/chat" element={<Chat />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </Content>
        </Layout>
      </Layout>

      {isMobile ? (
        <div
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            height: mobileNavHeight,
            background: 'rgba(255,255,255,0.96)',
            backdropFilter: 'blur(12px)',
            borderTop: '1px solid #ececec',
            display: 'grid',
            gridTemplateColumns: `repeat(${mobileNavItems.length}, minmax(0, 1fr))`,
            paddingBottom: 'env(safe-area-inset-bottom)'
          }}
        >
          {mobileNavItems.map((item) => {
            const active = location.pathname === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => navigate(item.key)}
                style={{
                  border: 'none',
                  background: 'transparent',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                  color: active ? '#1677ff' : '#7a7a7a',
                  fontSize: 12,
                  fontWeight: active ? 600 : 500
                }}
              >
                <span style={{ fontSize: 18, lineHeight: 1 }}>{item.icon}</span>
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </Layout>
  );
}

function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <BrowserRouter basename="/ui">
        <AppContent />
      </BrowserRouter>
    </ConfigProvider>
  );
}

export default App;
