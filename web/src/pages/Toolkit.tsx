import { useState, type ReactNode } from 'react';
import { Tabs } from 'antd';
import {
  ApiOutlined,
  AppstoreOutlined,
  CloudSyncOutlined,
  CodeOutlined,
  ForkOutlined,
  GlobalOutlined,
  ToolOutlined
} from '@ant-design/icons';
import PageScaffold from '@/components/ui/PageScaffold';
import AppManagerPanel from '@/components/toolkit/AppManagerPanel';
import TerminalManagerPanel from '@/components/toolkit/TerminalManagerPanel';
import EnvironmentPanel from '@/components/toolkit/EnvironmentPanel';
import ManagedToolsPanel from '@/components/toolkit/ManagedToolsPanel';
import MirrorManagerPanel from '@/components/toolkit/MirrorManagerPanel';
import ProxyDiagnosticsPanel from '@/components/toolkit/ProxyDiagnosticsPanel';
import ProxyPoolPanel from '@/components/toolkit/proxy-pool/ProxyPoolPanel';
import './Toolkit.css';

type ToolkitSection = 'integration' | 'runtime' | 'network';

interface ToolkitSecondaryItem {
  id: string;
  label: string;
  description: string;
  icon: ReactNode;
}

const SECTION_ITEMS: Record<ToolkitSection, ToolkitSecondaryItem[]> = {
  integration: [
    {
      id: 'apps',
      label: '应用管理',
      description: '安装、更新、配置与自动同步',
      icon: <AppstoreOutlined />
    },
    {
      id: 'terminals',
      label: '终端管理',
      description: '发现、安装、更新与卸载终端',
      icon: <ToolOutlined />
    },
    {
      id: 'session-runtimes',
      label: '会话运行时',
      description: 'tmux、psmux 与持久会话后端',
      icon: <ToolOutlined />
    }
  ],
  runtime: [
    {
      id: 'environment',
      label: 'Node / Python',
      description: '版本、包管理器与任务式命令',
      icon: <CodeOutlined />
    },
    {
      id: 'mirrors',
      label: '软件源与镜像',
      description: '当前源、连通延迟与平台指南',
      icon: <CloudSyncOutlined />
    }
  ],
  network: [
    {
      id: 'network-access',
      label: '接入与隧道',
      description: 'FRP 与 Cloudflare Tunnel',
      icon: <ApiOutlined />
    },
    {
      id: 'proxy-pool',
      label: '代理池与分流',
      description: '节点、订阅、出口与聚合配置',
      icon: <ForkOutlined />
    },
    {
      id: 'proxy-diagnostics',
      label: '网络诊断',
      description: '系统、进程与工具代理观测',
      icon: <GlobalOutlined />
    }
  ]
};

const DEFAULT_SECONDARY: Record<ToolkitSection, string> = {
  integration: 'apps',
  runtime: 'environment',
  network: 'network-access'
};

const SECTION_LABELS: Record<ToolkitSection, string> = {
  integration: '应用与集成',
  runtime: '运行环境',
  network: '网络'
};

function renderPanel(panelId: string) {
  switch (panelId) {
    case 'apps':
      return <AppManagerPanel />;
    case 'session-runtimes':
      return <ManagedToolsPanel category="session-runtimes" />;
    case 'terminals':
      return <TerminalManagerPanel />;
    case 'environment':
      return <EnvironmentPanel />;
    case 'mirrors':
      return <MirrorManagerPanel />;
    case 'network-access':
      return <ManagedToolsPanel category="network-access" />;
    case 'proxy-pool':
      return <ProxyPoolPanel />;
    case 'proxy-diagnostics':
      return <ProxyDiagnosticsPanel />;
    default:
      return null;
  }
}

export default function Toolkit() {
  const [activeSection, setActiveSection] = useState<ToolkitSection>('integration');
  const [secondarySelection, setSecondarySelection] = useState<Record<ToolkitSection, string>>(DEFAULT_SECONDARY);

  const renderSectionBody = (section: ToolkitSection) => {
    const sectionItems = SECTION_ITEMS[section];
    const activePanelId = secondarySelection[section];

    return (
      <div className="toolkit-console-body">
        <nav className="toolkit-secondary-nav" aria-label={`${SECTION_LABELS[section]}二级导航`}>
          <div className="toolkit-secondary-nav-label">CONTROL SURFACE</div>
          {sectionItems.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className="toolkit-secondary-nav-item"
              data-active={item.id === activePanelId || undefined}
              aria-current={item.id === activePanelId ? 'page' : undefined}
              onClick={() => setSecondarySelection((current) => ({
                ...current,
                [section]: item.id
              }))}
            >
              <span className="toolkit-secondary-nav-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <span className="toolkit-secondary-nav-icon" aria-hidden="true">{item.icon}</span>
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          ))}
        </nav>

        <main className="toolkit-panel-host">
          {renderPanel(activePanelId)}
        </main>
      </div>
    );
  };

  return (
    <PageScaffold
      title="开发工具"
      subTitle="工业化开发控制台：沿实测、配置、指南三条轨道管理应用、运行时与网络。"
      className="toolkit-scaffold"
      ghost
      headerContent={(
        <div className="toolkit-console-legend" aria-label="控制台数据语义">
          <span><strong>实测</strong> 当前主机返回的观测值</span>
          <span><strong>配置</strong> 可变更且可重新读取的状态</span>
          <span><strong>指南</strong> 只生成命令，不在页面自动执行</span>
        </div>
      )}
    >
      <div className="toolkit-console">
        <Tabs
          className="toolkit-primary-tabs"
          activeKey={activeSection}
          onChange={(value) => setActiveSection(value as ToolkitSection)}
          destroyInactiveTabPane
          items={[
            { key: 'integration', label: <span><AppstoreOutlined /> 应用与集成</span>, children: renderSectionBody('integration') },
            { key: 'runtime', label: <span><CodeOutlined /> 运行环境</span>, children: renderSectionBody('runtime') },
            { key: 'network', label: <span><GlobalOutlined /> 网络</span>, children: renderSectionBody('network') }
          ]}
        />
      </div>
    </PageScaffold>
  );
}
