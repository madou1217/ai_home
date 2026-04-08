import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { ConfigProvider, Layout, Menu } from 'antd';
import {
  DashboardOutlined,
  TeamOutlined,
  MessageOutlined,
  SettingOutlined
} from '@ant-design/icons';
import { useState } from 'react';
import zhCN from 'antd/locale/zh_CN';
import Dashboard from '@/pages/Dashboard';
import Accounts from '@/pages/Accounts';
import Chat from '@/pages/Chat';
import Settings from '@/pages/Settings';
import aiHomeIcon from '@/assets/icons/ai-home.svg';
import './styles/App.css';

const { Header, Sider, Content } = Layout;

function AppContent() {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const menuItems = [
    {
      key: '/',
      icon: <DashboardOutlined />,
      label: '仪表盘'
    },
    {
      key: '/accounts',
      icon: <TeamOutlined />,
      label: '账号管理'
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

  const isChat = location.pathname === '/chat';

  return (
    <Layout style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* 顶部导航 - 固定高度，不参与 flex 伸缩 */}
      <Header style={{
        padding: '0 24px',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        flex: '0 0 64px',
        zIndex: 10
      }}>
        <div style={{
          color: 'white',
          fontSize: '20px',
          fontWeight: 'bold',
          display: 'flex',
          alignItems: 'center',
          gap: 10
        }}>
          <img src={aiHomeIcon} alt="AI Home" style={{ width: 26, height: 26 }} />
          AI Home
        </div>
        <div style={{ color: 'rgba(255, 255, 255, 0.85)', fontSize: '13px' }}>
          多账号 AI 管理平台
        </div>
      </Header>

      {/* 下方内容区 - flex: 1 占满剩余空间 */}
      <Layout style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
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
            items={menuItems}
            onClick={({ key }) => navigate(key)}
            style={{ borderRight: 0, background: 'transparent' }}
          />
        </Sider>
        <Layout style={{
          padding: isChat ? 0 : '24px',
          height: '100%',
          overflow: 'hidden'
        }}>
          <Content style={{
            padding: isChat ? 0 : 24,
            margin: 0,
            background: '#fff',
            borderRadius: isChat ? 0 : '12px',
            height: '100%',
            overflow: isChat ? 'hidden' : 'auto',
            boxShadow: isChat ? 'none' : '0 1px 2px rgba(0,0,0,0.03)',
            display: isChat ? 'flex' : 'block',
            flexDirection: 'column'
          }}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/accounts" element={<Accounts />} />
              <Route path="/chat" element={<Chat />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Content>
        </Layout>
      </Layout>
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
