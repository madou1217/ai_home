import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  ApiOutlined,
  AppstoreOutlined,
  CloudSyncOutlined,
  CodeOutlined,
  DesktopOutlined,
  ForkOutlined,
  GatewayOutlined,
  GlobalOutlined,
  ToolOutlined
} from '@ant-design/icons';
import type { MobilePageProps } from '../mobile-routes';
import { HudChips, MobilePage } from '@/mobile/ui';
import AppDeskPanel from '@/features/app-desk/AppDeskPanel';
import AppsPanel from './toolkit/AppsPanel';
import DiagnosticsPanel from './toolkit/DiagnosticsPanel';
import EnvironmentPanel from './toolkit/EnvironmentPanel';
import MirrorsPanel from './toolkit/MirrorsPanel';
import SubscriptionAggregatorPanel from './toolkit/SubscriptionAggregatorPanel';
import EdgeForwardingPanel from './toolkit/EdgeForwardingPanel';
import TerminalsPanel from './toolkit/TerminalsPanel';
import ToolsPanel from './toolkit/ToolsPanel';
import styles from './MobileToolkit.module.css';

type ToolkitSection = 'integration' | 'runtime' | 'network';

interface SecondaryItem {
  id: string;
  label: string;
  icon: ReactNode;
}

/** 与桌面 Toolkit 相同的三个一级分区与二级面板（同名、同顺序、同默认项）。 */
const SECTIONS: Array<{ key: ToolkitSection; label: string; icon: ReactNode }> = [
  { key: 'integration', label: '应用与集成', icon: <AppstoreOutlined /> },
  { key: 'runtime', label: '运行环境', icon: <CodeOutlined /> },
  { key: 'network', label: '网络', icon: <GlobalOutlined /> }
];

const SECTION_ITEMS: Record<ToolkitSection, SecondaryItem[]> = {
  integration: [
    { id: 'apps', label: '应用管理', icon: <AppstoreOutlined /> },
    { id: 'app-desk', label: '应用看台', icon: <DesktopOutlined /> },
    { id: 'terminals', label: '终端管理', icon: <ToolOutlined /> },
    { id: 'edge-forwarding', label: '入口与转发', icon: <GatewayOutlined /> },
    { id: 'session-runtimes', label: '持久化工具', icon: <ToolOutlined /> }
  ],
  runtime: [
    { id: 'environment', label: '语言运行时', icon: <CodeOutlined /> },
    { id: 'mirrors', label: '软件源与镜像', icon: <CloudSyncOutlined /> }
  ],
  network: [
    { id: 'network-access', label: '接入与隧道', icon: <ApiOutlined /> },
    { id: 'subscription-aggregator', label: '订阅聚合与分流', icon: <ForkOutlined /> },
    { id: 'proxy-diagnostics', label: '网络诊断', icon: <GlobalOutlined /> }
  ]
};

const DEFAULT_SECONDARY: Record<ToolkitSection, string> = {
  integration: 'apps',
  runtime: 'environment',
  network: 'network-access'
};

/** 深链 ?panel=app-desk 在移动端也应落到对应分区；与新开标签/分享链接一致。 */
function resolveInitialPanel(): { section: ToolkitSection; panel: string } {
  const requested = new URLSearchParams(window.location.search).get('panel') || '';
  for (const section of Object.keys(SECTION_ITEMS) as ToolkitSection[]) {
    if (SECTION_ITEMS[section].some((item) => item.id === requested)) {
      return { section, panel: requested };
    }
  }
  return { section: 'integration', panel: DEFAULT_SECONDARY.integration };
}

function renderPanel(panelId: string) {
  switch (panelId) {
    case 'apps':
      return <AppsPanel />;
    case 'app-desk':
      return <AppDeskPanel />;
    case 'terminals':
      return <TerminalsPanel />;
    case 'edge-forwarding':
      return <EdgeForwardingPanel />;
    case 'session-runtimes':
      return <ToolsPanel category="session-runtimes" />;
    case 'environment':
      return <EnvironmentPanel />;
    case 'mirrors':
      return <MirrorsPanel />;
    case 'network-access':
      return <ToolsPanel category="network-access" />;
    case 'subscription-aggregator':
      return <SubscriptionAggregatorPanel />;
    case 'proxy-diagnostics':
      return <DiagnosticsPanel />;
    default:
      return null;
  }
}

/**
 * 开发工具（/toolkit）移动端：一级分区芯片 + 二级面板芯片，一次只挂载一个面板
 * （与桌面 destroyInactiveTabPane 一致，只请求当前面板的数据）。
 */
export default function MobileToolkit(_props: MobilePageProps) {
  const initial = resolveInitialPanel();
  const [section, setSection] = useState<ToolkitSection>(initial.section);
  const [selection, setSelection] = useState<Record<ToolkitSection, string>>({
    ...DEFAULT_SECONDARY,
    [initial.section]: initial.panel
  });
  const panelId = selection[section];

  return (
    <MobilePage lead="管理应用集成、运行环境与网络诊断工具。">
      <div className={styles.nav}>
        <HudChips
          ariaLabel="开发工具分区"
          value={section}
          onChange={(key) => setSection(key as ToolkitSection)}
          items={SECTIONS.map((item) => ({ key: item.key, label: item.label, icon: item.icon }))}
        />
        <HudChips
          ariaLabel={`${SECTIONS.find((item) => item.key === section)?.label || ''}二级导航`}
          value={panelId}
          onChange={(key) => setSelection((current) => ({ ...current, [section]: key }))}
          items={SECTION_ITEMS[section].map((item) => ({
            key: item.id,
            label: item.label,
            icon: item.icon
          }))}
        />
      </div>
      <div className={`${styles.panel} aih-fade-in`} key={panelId}>
        {renderPanel(panelId)}
      </div>
    </MobilePage>
  );
}
