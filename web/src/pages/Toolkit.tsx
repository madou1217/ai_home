import { useState, type ReactNode } from 'react';
import { Tabs } from 'antd';
import {
  ApiOutlined,
  AppstoreOutlined,
  CloudSyncOutlined,
  CodeOutlined,
  GlobalOutlined,
  ToolOutlined
} from '@ant-design/icons';
import PageScaffold from '@/components/ui/PageScaffold';
import AppManagerPanel from '@/components/toolkit/AppManagerPanel';
import TerminalManagerPanel from '@/components/toolkit/TerminalManagerPanel';
import EnvironmentPanel from '@/components/toolkit/EnvironmentPanel';
import ManagedToolsPanel from '@/components/toolkit/ManagedToolsPanel';
import MirrorManagerPanel from '@/components/toolkit/MirrorManagerPanel';
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
      description: '安装、更新与卸载',
      icon: <AppstoreOutlined />
    },
    {
      id: 'terminals',
      label: '终端管理',
      description: '安装、更新与卸载',
      icon: <ToolOutlined />
    },
    {
      id: 'session-runtimes',
      label: '会话运行时',
      description: '持久会话后端',
      icon: <ToolOutlined />
    }
  ],
  runtime: [
    {
      id: 'environment',
      label: 'Node / Python',
      description: '安装、更新与卸载',
      icon: <CodeOutlined />
    },
    {
      id: 'mirrors',
      label: '软件源与镜像',
      description: '镜像状态与连通性',
      icon: <CloudSyncOutlined />
    }
  ],
  network: [
    {
      id: 'network-access',
      label: '接入与隧道',
      description: 'FRP 接入配置',
      icon: <ApiOutlined />
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
      subTitle="管理应用、终端、运行环境与网络。"
      className="toolkit-scaffold"
      ghost
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
