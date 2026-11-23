import { useCallback, useEffect, useState } from 'react';
import { useLocation } from '@umijs/max';
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
import NativeResourcesPanel from '@/components/toolkit/NativeResourcesPanel';
import NetworkConnectorPanel from '@/components/toolkit/NetworkConnectorPanel';
import EgressUpstreamPanel from '@/features/egress-upstream/EgressUpstreamPanel';
import ProxyServePanel from '@/features/proxy-serve/ProxyServePanel';
import ToolkitNavigationShell from '@/features/toolkit/ToolkitNavigationShell';
import {
  DEFAULT_TOOLKIT_SECONDARY,
  TOOLKIT_SECTION_ITEMS,
  resolveToolkitDeepLink,
  type ToolkitSection
} from '@/features/toolkit/toolkit-navigation-config';
import { isSameCommittedIntent, resolveOrderedDirection, useSurfaceSwitch } from '@/hooks/use-surface-switch';
import { subscribeToolkitPanel, writeToolkitPanel } from './toolkit-url-state';
import './Toolkit.css';

function renderPanel(panelId: string) {
  switch (panelId) {
    case 'apps':
      return <AppManagerPanel />;
    case 'session-runtimes':
      return <ManagedToolsPanel category="session-runtimes" />;
    case 'native-resources':
      return <NativeResourcesPanel />;
    case 'terminals':
      return <TerminalManagerPanel />;
    case 'edge-forwarding':
      return <EdgeProxyPanel />;
    case 'environment':
      return <EnvironmentPanel />;
    case 'mirrors':
      return <MirrorManagerPanel />;
    case 'network-access':
      return (
        <>
          <ManagedToolsPanel category="network-access" />
          <NetworkConnectorPanel />
        </>
      );
    case 'subscription-aggregator':
      return <SubscriptionAggregatorPanel />;
    case 'proxy-serve':
      return <ProxyServePanel />;
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

export default function Toolkit() {
  const location = useLocation();
  const deepLink = resolveToolkitDeepLink(location.search);
  const [activeSection, setActiveSection] = useState<ToolkitSection>(deepLink?.section || 'integration');
  const [secondarySelection, setSecondarySelection] = useState<Record<ToolkitSection, string>>(
    deepLink ? { ...DEFAULT_TOOLKIT_SECONDARY, [deepLink.section]: deepLink.panel } : DEFAULT_TOOLKIT_SECONDARY
  );
  const { surfaceRef: panelHostRef, switchSurface: switchPanelSurface } = useSurfaceSwitch<HTMLElement>();

  useEffect(() => subscribeToolkitPanel((panel) => {
    const next = resolveToolkitDeepLink(panel ? `?panel=${encodeURIComponent(panel)}` : '');
    if (!next) return;
    setActiveSection(next.section);
    setSecondarySelection((current) => ({ ...current, [next.section]: next.panel }));
  }), []);

  useEffect(() => {
    const next = resolveToolkitDeepLink(location.search);
    if (!next) return;
    setActiveSection(next.section);
    setSecondarySelection((current) => ({ ...current, [next.section]: next.panel }));
  }, [location.search]);

  const handleSectionChange = useCallback((nextSection: ToolkitSection) => {
    setActiveSection(nextSection);
    writeToolkitPanel(secondarySelection[nextSection]);
  }, [secondarySelection]);

  const handlePanelSelect = useCallback((section: ToolkitSection, panelId: string) => {
    const sectionItems = TOOLKIT_SECTION_ITEMS[section];
    const activePanelId = secondarySelection[section];
    const panelOrder = sectionItems.map((entry) => entry.id);
    const commit = () => {
      setSecondarySelection((current) => ({
        ...current,
        [section]: panelId
      }));
      writeToolkitPanel(panelId);
    };

    if (section === activeSection) {
      switchPanelSurface(commit, {
        slot: section,
        current: activePanelId,
        next: panelId,
        direction: resolveOrderedDirection(panelOrder, activePanelId, panelId)
      });
    } else {
      if (isSameCommittedIntent(activePanelId, panelId)) return;
      commit();
    }
  }, [activeSection, secondarySelection, switchPanelSurface]);

  const renderSectionPanel = useCallback((section: ToolkitSection, activePanelId: string) => (
    <main
      ref={section === activeSection ? panelHostRef : undefined}
      className="toolkit-panel-host aih-panel-enter"
      key={activePanelId}
    >
      {renderPanel(activePanelId)}
    </main>
  ), [activeSection, panelHostRef]);

  return (
    <PageScaffold
      title="开发工具"
      subTitle="统一管理应用、运行环境与网络。"
      className="toolkit-scaffold"
      ghost
    >
      <ToolkitNavigationShell
        activeSection={activeSection}
        secondarySelection={secondarySelection}
        onSectionChange={handleSectionChange}
        onPanelSelect={handlePanelSelect}
        renderSectionPanel={renderSectionPanel}
      />
    </PageScaffold>
  );
}
