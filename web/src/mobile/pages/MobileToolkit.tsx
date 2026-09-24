import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  ApiOutlined,
  AppstoreOutlined,
  CloudSyncOutlined,
  CodeOutlined,
  ForkOutlined,
  GlobalOutlined,
  ToolOutlined
} from '@ant-design/icons';
import type { MobilePageProps } from '../mobile-routes';
import { HudChips, MobilePage } from '@/mobile/ui';
import AppsPanel from './toolkit/AppsPanel';
import CliUpgradePanel from './toolkit/CliUpgradePanel';
import DiagnosticsPanel from './toolkit/DiagnosticsPanel';
import EnvironmentPanel from './toolkit/EnvironmentPanel';
import MirrorsPanel from './toolkit/MirrorsPanel';
import ProxyPoolPanel from './toolkit/ProxyPoolPanel';
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
    { id: 'terminals', label: '终端管理', icon: <ToolOutlined /> },
    { id: 'cli-upgrade', label: 'CLI 自动升级', icon: <CloudSyncOutlined /> },
    { id: 'session-runtimes', label: '会话运行时', icon: <ToolOutlined /> }
  ],
  runtime: [
    { id: 'environment', label: 'Node / Python', icon: <CodeOutlined /> },
    { id: 'mirrors', label: '软件源与镜像', icon: <CloudSyncOutlined /> }
  ],
  network: [
    { id: 'network-access', label: '接入与隧道', icon: <ApiOutlined /> },
    { id: 'proxy-pool', label: '代理池与分流', icon: <ForkOutlined /> },
    { id: 'proxy-diagnostics', label: '网络诊断', icon: <GlobalOutlined /> }
  ]
};

const DEFAULT_SECONDARY: Record<ToolkitSection, string> = {
  integration: 'apps',
  runtime: 'environment',
  network: 'network-access'
};

function renderPanel(panelId: string) {
  switch (panelId) {
    case 'apps':
      return <AppsPanel />;
    case 'terminals':
      return <TerminalsPanel />;
    case 'cli-upgrade':
      return <CliUpgradePanel />;
    case 'session-runtimes':
      return <ToolsPanel category="session-runtimes" />;
    case 'environment':
      return <EnvironmentPanel />;
    case 'mirrors':
      return <MirrorsPanel />;
    case 'network-access':
      return <ToolsPanel category="network-access" />;
    case 'proxy-pool':
      return <ProxyPoolPanel />;
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
  const [section, setSection] = useState<ToolkitSection>('integration');
  const [selection, setSelection] = useState<Record<ToolkitSection, string>>(DEFAULT_SECONDARY);
  const panelId = selection[section];

  return (
    <MobilePage>
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
          items={SECTION_ITEMS[section].map((item, index) => ({
            key: item.id,
            label: <><span className={styles.navIndex}>{String(index + 1).padStart(2, '0')}</span>{item.label}</>,
            icon: item.icon
          }))}
        />
      </div>
      <div className={styles.panel} key={panelId}>
        {renderPanel(panelId)}
      </div>
    </MobilePage>
  );
}
