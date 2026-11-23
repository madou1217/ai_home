import type { ReactNode } from 'react';
import {
  ApiOutlined,
  AppstoreOutlined,
  CloudServerOutlined,
  CloudSyncOutlined,
  CodeOutlined,
  DeploymentUnitOutlined,
  ForkOutlined,
  GatewayOutlined,
  GlobalOutlined,
  ToolOutlined
} from '@ant-design/icons';
import { resolveToolkitPanelAlias } from '@/pages/toolkit-url-state';

export type ToolkitSection = 'integration' | 'runtime' | 'network';

export interface ToolkitSecondaryItem {
  id: string;
  label: string;
  icon: ReactNode;
}

export interface ToolkitSectionMeta {
  key: ToolkitSection;
  label: string;
  icon: ReactNode;
}

export const TOOLKIT_SECTIONS: ToolkitSectionMeta[] = [
  { key: 'integration', label: '应用与集成', icon: <AppstoreOutlined /> },
  { key: 'runtime', label: '运行环境', icon: <CodeOutlined /> },
  { key: 'network', label: '网络', icon: <GlobalOutlined /> }
];

export const TOOLKIT_SECTION_LABELS: Record<ToolkitSection, string> = {
  integration: '应用与集成',
  runtime: '运行环境',
  network: '网络'
};

export const TOOLKIT_SECTION_ITEMS: Record<ToolkitSection, ToolkitSecondaryItem[]> = {
  integration: [
    { id: 'apps', label: '应用管理', icon: <AppstoreOutlined /> },
    { id: 'terminals', label: '终端管理', icon: <ToolOutlined /> },
    { id: 'edge-forwarding', label: '入口与转发', icon: <GatewayOutlined /> },
    { id: 'session-runtimes', label: '持久会话', icon: <ToolOutlined /> },
    { id: 'native-resources', label: '插件与资源', icon: <CodeOutlined /> }
  ],
  runtime: [
    { id: 'environment', label: '语言运行时', icon: <CodeOutlined /> },
    { id: 'mirrors', label: '软件源与镜像', icon: <CloudSyncOutlined /> }
  ],
  network: [
    { id: 'network-access', label: '接入与隧道', icon: <ApiOutlined /> },
    { id: 'subscription-aggregator', label: '订阅与分流', icon: <ForkOutlined /> },
    { id: 'proxy-serve', label: '本机代理', icon: <DeploymentUnitOutlined /> },
    { id: 'egress-pool', label: '出口池', icon: <ApiOutlined /> },
    { id: 'egress-upstreams', label: '上游策略', icon: <CloudServerOutlined /> },
    { id: 'geo-resources', label: 'GeoIP 数据', icon: <GlobalOutlined /> },
    { id: 'proxy-diagnostics', label: '网络诊断', icon: <GlobalOutlined /> }
  ]
};

export const DEFAULT_TOOLKIT_SECONDARY: Record<ToolkitSection, string> = {
  integration: 'apps',
  runtime: 'environment',
  network: 'network-access'
};

export function resolveToolkitDeepLink(
  search: string
): { section: ToolkitSection; panel: string } | null {
  const raw = new URLSearchParams(search).get('panel') || '';
  const panel = resolveToolkitPanelAlias(raw);
  const section = (Object.keys(TOOLKIT_SECTION_ITEMS) as ToolkitSection[])
    .find((key) => TOOLKIT_SECTION_ITEMS[key].some((item) => item.id === panel));
  return section ? { section, panel } : null;
}
