import type { Settings as LayoutSettings } from "@ant-design/pro-components";
import ControlPlaneProfileSelect from "@/components/control-plane/ControlPlaneProfileSelect";
import CurrentServerBadge from "@/components/control-plane/CurrentServerBadge";
import { FABRIC_SERVER_SETUP_HREF } from "@/services/fabric-profile-gate";
import logo from "@/assets/brand/ai-home-logo.png";

export async function getInitialState(): Promise<{
  settings?: Partial<LayoutSettings>;
}> {
  return {
    settings: {
      layout: "side",
      navTheme: "light",
      colorPrimary: "#171717",
      contentWidth: "Fluid",
      fixedHeader: true,
      fixSiderbar: true,
    },
  };
}

export const layout = ({ initialState }: any) => {
  return {
    logo,
    title: "AIH",
    rightContentRender: () => <CurrentServerBadge />,
    menuFooterRender: () => (
      <div style={{ padding: "8px 12px" }}>
        <ControlPlaneProfileSelect
          label="Server"
          size="compact"
          manageHref={FABRIC_SERVER_SETUP_HREF}
          emptyLabel="配置"
          manageLabel="配置"
          showSummary
          onChange={() => {
            // 切换 server 后强制整页重载：所有数据页从新 server 重新取数，避免残留上一台的数据。
            if (typeof window !== "undefined") window.location.reload();
          }}
        />
      </div>
    ),
    ...initialState?.settings,
  };
};
