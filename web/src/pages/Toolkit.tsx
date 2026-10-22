import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from '@umijs/max';
import { Tabs } from 'antd';
import {
  ApiOutlined,
  AppstoreOutlined,
  CloudServerOutlined,
  CloudSyncOutlined,
  CodeOutlined,
  ForkOutlined,
  GatewayOutlined,
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
import SubscriptionAggregatorPanel from '@/components/toolkit/subscription-aggregator/SubscriptionAggregatorPanel';
import EdgeProxyPanel from '@/components/toolkit/edge-proxy/EdgeProxyPanel';
import EgressPoolPanel from '@/features/egress-pool/EgressPoolPanel';
import GeoResourcePanel from '@/features/geo-resource/GeoResourcePanel';
import EgressUpstreamPanel from '@/features/egress-upstream/EgressUpstreamPanel';
import { resolveToolkitPanelAlias, subscribeToolkitPanel, writeToolkitPanel } from './toolkit-url-state';
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
      id: 'edge-forwarding',
      label: '入口与转发',
      description: 'nginx / caddy / frp',
      icon: <GatewayOutlined />
    },
    {
      id: 'session-runtimes',
      label: '持久化工具',
      description: 'tmux / psmux 持久会话',
      icon: <ToolOutlined />
    }
  ],
  runtime: [
    {
      id: 'environment',
      label: '语言运行时',
      description: '插件化多语言工具链',
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
    },
    {
      id: 'subscription-aggregator',
      label: '订阅聚合与分流',
      description: '多订阅合一与分流规则',
      icon: <ForkOutlined />
    },
    {
      id: 'egress-pool',
      label: '出口池',
      description: '节点使用、冷却与恢复',
      icon: <ApiOutlined />
    },
    {
      id: 'egress-upstreams',
      label: '上游地区策略',
      description: '哪些出口位置能访问哪个上游',
      icon: <CloudServerOutlined />
    },
    {
      id: 'geo-resources',
      label: 'GeoIP 数据',
      description: '本地归属地库与更新',
      icon: <GlobalOutlined />
    },
    {
      id: 'proxy-diagnostics',
      label: '网络诊断',
      description: '代理状态与诊断',
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
    case 'edge-forwarding':
      return <EdgeProxyPanel />;
    case 'environment':
      return <EnvironmentPanel />;
    case 'mirrors':
      return <MirrorManagerPanel />;
    case 'network-access':
      return <ManagedToolsPanel category="network-access" />;
    case 'subscription-aggregator':
      return <SubscriptionAggregatorPanel />;
    case 'egress-pool':
      return <EgressPoolPanel />;
    case 'egress-upstreams':
      return <EgressUpstreamPanel />;
    case 'geo-resources':
      return <GeoResourcePanel />;
    case 'proxy-diagnostics':
      return <ProxyDiagnosticsPanel />;
    default:
      return null;
  }
}

// 深链：`/toolkit?panel=<id>` 直接打开某个二级面板（例如账号出口弹窗里的「查看出口池」）。
// 已并入其它面板的旧 id（如 cli-upgrade → apps）在这里归一，旧书签不会落到空面板。
function resolveDeepLink(search: string): { section: ToolkitSection; panel: string } | null {
  const raw = new URLSearchParams(search).get('panel') || '';
  const panel = resolveToolkitPanelAlias(raw);
  const section = (Object.keys(SECTION_ITEMS) as ToolkitSection[])
    .find((key) => SECTION_ITEMS[key].some((item) => item.id === panel));
  return section ? { section, panel } : null;
}

export default function Toolkit() {
  const location = useLocation();
  const deepLink = resolveDeepLink(location.search);
  const [activeSection, setActiveSection] = useState<ToolkitSection>(deepLink?.section || 'integration');
  const [secondarySelection, setSecondarySelection] = useState<Record<ToolkitSection, string>>(
    deepLink ? { ...DEFAULT_SECONDARY, [deepLink.section]: deepLink.panel } : DEFAULT_SECONDARY
  );

  useEffect(() => subscribeToolkitPanel((panel) => {
    const next = resolveDeepLink(panel ? `?panel=${encodeURIComponent(panel)}` : '');
    if (!next) return;
    setActiveSection(next.section);
    setSecondarySelection((current) => ({ ...current, [next.section]: next.panel }));
  }), []);

  useEffect(() => {
    const next = resolveDeepLink(location.search);
    if (!next) return;
    setActiveSection(next.section);
    setSecondarySelection((current) => ({ ...current, [next.section]: next.panel }));
  }, [location.search]);

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
              onClick={() => {
                setSecondarySelection((current) => ({
                  ...current,
                  [section]: item.id
                }));
                writeToolkitPanel(item.id);
              }}
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

        {/* key 随面板变化：切换二级面板时重新挂载并播放进场过渡（styles/motion.css） */}
        <main className="toolkit-panel-host aih-panel-enter" key={activePanelId}>
          {renderPanel(activePanelId)}
        </main>
      </div>
    );
  };

  return (
    <PageScaffold
      code="TOOLKIT"
      title="开发工具"
      subTitle="管理应用、终端、运行环境与网络。"
      className="toolkit-scaffold"
      ghost
    >
      <div className="toolkit-console hud-panel">
        <Tabs
          className="toolkit-primary-tabs"
          activeKey={activeSection}
          onChange={(value) => {
            const next = value as ToolkitSection;
            setActiveSection(next);
            writeToolkitPanel(secondarySelection[next]);
          }}
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
